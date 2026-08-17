import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, getPrimaryOrg } from '../config.js';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../bigquery/events.js';
import { SCHEMA_SQL } from './schema.js';

export type Db = Database.Database;

let handle: Db | null = null;

export function getDb(): Db {
  if (handle) return handle;

  const { runtime } = getConfig();
  if (runtime.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(runtime.databasePath), { recursive: true });
  }

  const db = new Database(runtime.databasePath);
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  migrate(db);

  handle = db;
  return db;
}

/**
 * The few changes `CREATE TABLE IF NOT EXISTS` cannot make on its own.
 *
 * The schema above is idempotent for a *new* database and silent for an
 * existing one — a table that is already there is left exactly as it was,
 * including columns that have since moved or been dropped. This closes that
 * gap, and only for columns: anything structural enough to need a rebuild would
 * want a real migration ledger, and nothing here has earned one yet.
 */
function migrate(db: Db): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );

  /*
   * Cursors learned which window they were made for.
   *
   * A Relay cursor is an opaque position inside the result set of the query
   * that issued it, so it is only meaningful to a query with the same
   * arguments. An interrupted pass stores one; the next pass may compute a
   * different `createdAtMin` and hand the old cursor to the new query, which
   * resumes the *old* walk — past the window, through history the pass had no
   * reason to read, and away from the rows it was started for.
   *
   * The column records the window, so the two can be compared and a cursor
   * whose window has moved can be dropped rather than trusted. NULL on every
   * row that predates this, which reads as "unknown window" and therefore as
   * "do not resume" — the safe answer, and it costs one clean re-walk of one
   * window, once.
   */
  if (!columns('sync_state').has('cursor_window')) {
    db.exec('ALTER TABLE sync_state ADD COLUMN cursor_window TEXT');
  }

  /*
   * Apps learned which Shopify Partner organization they came from.
   *
   * Two things happen here and they have to happen together, which is why they
   * share one transaction: the column, and the renaming of the sync watermarks.
   *
   * The backfill is the reason this is a migration rather than a schema line.
   * Every app already in this file was synced when only one organization could
   * be configured, so it can only have come from that one — `orgs[0]`. Left
   * blank instead, the first multi-org sync would have apps it cannot pick a
   * token for.
   *
   * The rename is the reason it is urgent. Watermark keys used to be
   * `transactions:all` / `transactions:<appId>` / `events:<appId>`, which name
   * no organization; two orgs sharing `transactions:all` would take turns
   * pushing each other's watermark forward and each would then skip the range
   * the other had already claimed — a silent gap, not a crash. The new keys are
   * `org:<orgId>:...`. Renaming the existing ones rather than letting them fall
   * out of use is what stops a completed multi-hour backfill restarting from
   * `SYNC_START_DATE`. `sync_state` is WITHOUT ROWID with `key` as its primary
   * key, and an UPDATE of a primary key simply rewrites the row.
   *
   * `reviews:` and `bigquery:` keys are deliberately untouched — they are keyed
   * by app id and app ids are globally unique across organizations.
   *
   * In a transaction because it is two statements over the same fact: a crash
   * between them would leave a database with the column and un-namespaced keys,
   * which reads as "never synced".
   */
  const apps = columns('apps');
  if (!apps.has('org_id')) {
    const primaryOrgId = getPrimaryOrg().organizationId;
    db.transaction(() => {
      db.exec(`ALTER TABLE apps ADD COLUMN org_id TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE apps SET org_id = ? WHERE org_id = ''`).run(primaryOrgId);

      // Defensive, and cheap: a legacy key whose namespaced counterpart somehow
      // already exists would make the UPDATE below a primary-key collision and
      // take the boot down. The namespaced row is the newer of the two, so the
      // legacy one goes.
      db.prepare(
        `DELETE FROM sync_state
          WHERE (key LIKE 'transactions:%' OR key LIKE 'events:%')
            AND EXISTS (SELECT 1 FROM sync_state other
                         WHERE other.key = 'org:' || ? || ':' || sync_state.key)`,
      ).run(primaryOrgId);

      db.prepare(
        `UPDATE sync_state
            SET key = 'org:' || ? || ':' || key
          WHERE key LIKE 'transactions:%' OR key LIKE 'events:%'`,
      ).run(primaryOrgId);
    })();
  }

  // Unconditional and idempotent, outside the guard above and deliberately so:
  // inside it a *new* database would never get the index, because its table
  // arrives with the column already present and the branch never runs. And not
  // in the schema block, because that runs before this and would name a column
  // an old database lacks.
  db.exec('CREATE INDEX IF NOT EXISTS idx_apps_org ON apps (org_id)');

  // The GA4 export dataset moved from the connection to the app. A partner
  // running one GA4 property per listing has a dataset per app, so a single
  // connection-level value made the common case the awkward one.
  const connection = columns('bigquery_connection');
  if (connection.has('dataset')) {
    db.exec('ALTER TABLE bigquery_connection DROP COLUMN dataset');
  }

  /*
   * The GA4 event names stopped being settings.
   *
   * A database configured before that holds whichever names were entered, and
   * listing traffic collected under them. Rows are typed by *step*, not by
   * event name, so anything pulled as `view_item` is already labelled
   * "listing view" and would sit beside the `page_view` rows counting the same
   * visit twice. Where the stored names differ from the ones now compiled in,
   * the collected traffic and its watermarks go, and the next sync re-reads the
   * range. Nothing is lost that BigQuery cannot re-serve.
   */
  if (connection.has('view_event') || connection.has('click_event')) {
    const row = db
      .prepare('SELECT view_event, click_event FROM bigquery_connection')
      .get() as { view_event?: string; click_event?: string } | undefined;

    if (
      row &&
      (row.view_event !== LISTING_VIEW_EVENT || row.click_event !== ADD_APP_CLICK_EVENT)
    ) {
      db.exec('DELETE FROM listing_events');
      db.exec(`DELETE FROM sync_state WHERE key LIKE 'bigquery:%'`);
      db.exec('DELETE FROM metric_cache');
    }

    if (connection.has('view_event')) db.exec('ALTER TABLE bigquery_connection DROP COLUMN view_event');
    if (connection.has('click_event')) db.exec('ALTER TABLE bigquery_connection DROP COLUMN click_event');
  }

  const sources = columns('bigquery_app_sources');
  if (sources.size > 0 && !sources.has('location')) {
    db.exec('ALTER TABLE bigquery_app_sources ADD COLUMN location TEXT');
  }

  /*
   * Install intervals learned which event opened them.
   *
   * The column defaults to 'installed', which is wrong for every interval a
   * reopening opened — and the table is only rewritten by the next sync, so a
   * default left to stand would report reopenings as installs until then. The
   * backfill reads it straight off the raw events the interval was built from:
   * an exact match on the opening timestamp, preferring a real install where a
   * shop somehow carries both at the same instant. Cached figures computed
   * under the old reading go with it.
   */
  const installs = columns('install_intervals');
  if (installs.size > 0 && !installs.has('started_by')) {
    db.exec(
      `ALTER TABLE install_intervals ADD COLUMN started_by TEXT NOT NULL DEFAULT 'installed'`,
    );
    db.exec(
      `UPDATE install_intervals AS t
          SET started_by = 'reactivated'
        WHERE EXISTS (SELECT 1 FROM app_events e
                       WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                         AND e.occurred_at = t.started_at
                         AND e.type = 'RELATIONSHIP_REACTIVATED')
          AND NOT EXISTS (SELECT 1 FROM app_events e
                           WHERE e.app_id = t.app_id AND e.shop_id = t.shop_id
                             AND e.occurred_at = t.started_at
                             AND e.type = 'RELATIONSHIP_INSTALLED')`,
    );
    db.exec('DELETE FROM metric_cache');
  }

  // Who a listing event belongs to became a resolved value rather than always
  // the browser cookie. Existing rows keep a blank one and fall back to
  // `anonymous_id` at read time, so no re-sync is needed to keep counting.
  const listing = columns('listing_events');
  if (listing.size > 0) {
    if (!listing.has('user_key')) {
      db.exec(`ALTER TABLE listing_events ADD COLUMN user_key TEXT NOT NULL DEFAULT ''`);
    }
    // Only once the column is certain to exist. In the schema block this ran
    // before the ALTER above and brought the process down on any database
    // created before the column.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_listing_events_user
         ON listing_events (app_id, type, user_key)`,
    );
    /*
     * The funnel's own shape: one app, one date range, every bucket.
     *
     * `idx_listing_events_step` is `(app_id, type, occurred_at)`, and the funnel
     * counts both types in a single pass, so `type` sits between the two columns
     * it can actually seek on and the range predicate cannot be used at all —
     * every bucket re-read every event the app has ever collected. Putting
     * `occurred_at` second makes each bucket a range seek, and carrying the two
     * visitor columns keeps it index-only: 1.6s -> 0.04s over 480k events,
     * measured, with identical counts.
     *
     * Here rather than in the schema block for the same reason as the index
     * above: it names `user_key`, which the ALTER above may have only just added.
     */
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_listing_events_window
         ON listing_events (app_id, occurred_at, type, user_key, anonymous_id)`,
    );
  }

  /*
   * The (app_id, shop_id, occurred_at) index on `customer_events`, superseded
   * by `idx_cevents_app_shop_seen` in the schema block — see the comment there
   * for what the extra column buys. Dropped rather than left in place because
   * the new one is a strict extension of it: keeping both pays for a second
   * copy of the same keys, and on a table with one row per transaction that
   * copy is hundreds of megabytes.
   */
  db.exec('DROP INDEX IF EXISTS idx_cevents_app_shop');

  /*
   * Likewise `(type, created_at)` on `transactions`, superseded by
   * `idx_tx_type_money`. Same reasoning: the replacement starts with the same
   * two columns, so every plan that used this one still works, and on a table
   * this size a redundant copy of 7.9M keys is not free.
   */
  db.exec('DROP INDEX IF EXISTS idx_tx_type_time');
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Test seam: an in-memory database with the schema already applied. */
export function useDb(db: Db): void {
  handle = db;
}

export interface SyncState {
  cursor: string | null;
  /**
   * The window `cursor` was produced under, or null when it is not known.
   *
   * Null on a cursor written before this column existed, and on the cursors of
   * callers that do not paginate a time-windowed connection at all. Callers
   * that do compare it against the window they are about to query, and discard
   * the cursor when the two differ — see `syncTransactionsFor`.
   */
  cursorWindow: string | null;
  syncedThrough: string | null;
}

export function readSyncState(db: Db, key: string): SyncState {
  const row = db
    .prepare('SELECT cursor, cursor_window, synced_through FROM sync_state WHERE key = ?')
    .get(key) as
    | { cursor: string | null; cursor_window: string | null; synced_through: string | null }
    | undefined;
  return {
    cursor: row?.cursor ?? null,
    cursorWindow: row?.cursor_window ?? null,
    syncedThrough: row?.synced_through ?? null,
  };
}

export function writeSyncState(
  db: Db,
  key: string,
  patch: { cursor?: string | null; cursorWindow?: string | null; syncedThrough?: string | null },
): void {
  const current = readSyncState(db, key);
  /*
   * A cursor and its window are one fact, so clearing the cursor clears the
   * window with it unless the caller says otherwise. Left behind, the stale
   * window would be compared against by the next pass and could match by
   * coincidence — a cursor with no window is at least honestly unknown.
   */
  const cursor = patch.cursor === undefined ? current.cursor : patch.cursor;
  const cursorWindow =
    patch.cursorWindow !== undefined
      ? patch.cursorWindow
      : cursor === null
        ? null
        : current.cursorWindow;
  db.prepare(
    `INSERT INTO sync_state (key, cursor, cursor_window, synced_through, updated_at)
     VALUES (@key, @cursor, @cursorWindow, @syncedThrough, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET
       cursor = excluded.cursor,
       cursor_window = excluded.cursor_window,
       synced_through = excluded.synced_through,
       updated_at = excluded.updated_at`,
  ).run({
    key,
    cursor,
    cursorWindow,
    syncedThrough: patch.syncedThrough === undefined ? current.syncedThrough : patch.syncedThrough,
    updatedAt: new Date().toISOString(),
  });
}

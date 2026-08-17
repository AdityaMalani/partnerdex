import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
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
  }
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

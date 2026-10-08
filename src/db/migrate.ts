import type Database from 'better-sqlite3';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../bigquery/events.js';

type Db = Database.Database;

/**
 * Schema changes `CREATE TABLE IF NOT EXISTS` cannot make on its own.
 *
 * SCHEMA_SQL is idempotent for a *new* database and silent for an existing one:
 * a table that is already there is left exactly as it was, including columns
 * that have since moved or been dropped. Closing that gap needs a record of
 * what a database has already seen, and SQLite ships one — `PRAGMA
 * user_version`, an integer in the file header that costs nothing to read.
 *
 * Minimal on purpose: read the pragma, run each pending up() inside a
 * transaction, bump the version. No down-migrations, no framework, no ledger
 * table.
 *
 * Every migration body below is also individually idempotent — each one checks
 * the database before it writes. That is deliberate belt and braces, not
 * redundancy. Migrations 1 and 2 were previously applied by an unversioned
 * function that ran on every open, so databases exist that hold the changes
 * while user_version is still 0; replaying them has to be a no-op rather than a
 * `duplicate column name` crash. Later migrations are free to drop the checks
 * where the change genuinely cannot be detected after the fact.
 */

export interface Migration {
  version: number;
  up: (db: Db) => void;
}

/** The column names a table currently has, or an empty set if it has none. */
function columns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/**
 * Contacts store — Role 4. The Partner API never had this data, so nothing here
 * can be recovered by re-syncing. Email is the natural key (email-global
 * suppression assumes it). contact_shops is a separate table because one person
 * can manage many stores and the same person can appear across apps;
 * contact_suppressions is separate so an opt-out survives every rewrite of the
 * rows around it. A contact_suppressions row is do-not-contact / opt-out, not
 * erasure (erasure would delete the person).
 */
export const CONTACTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  email         TEXT PRIMARY KEY,
  first_name    TEXT,
  last_name     TEXT,
  is_suppressed INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL,
  first_seen_at TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS contact_shops (
  email         TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  shop_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',
  match_method  TEXT NOT NULL DEFAULT 'none',
  first_seen_at TEXT,
  last_seen_at  TEXT,
  PRIMARY KEY (email, app_id, shop_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_contact_shops_shop ON contact_shops (app_id, shop_id);

CREATE TABLE IF NOT EXISTS contact_suppressions (
  email         TEXT PRIMARY KEY,
  suppressed_at TEXT NOT NULL,
  source        TEXT NOT NULL,
  reason        TEXT
) WITHOUT ROWID;
`;

export const MIGRATIONS: Migration[] = [
  /*
   * The BigQuery connection stopped carrying per-app and per-spelling settings.
   *
   * Two changes with one cause: values that looked like configuration were not.
   * The GA4 export dataset is per *property*, so a partner running one property
   * per listing has a dataset per app and a single connection-level value made
   * the common case the awkward one. The GA4 event names had exactly one
   * spelling that works, and a field offering to change them only offered a way
   * to break the report.
   *
   * Dropping the event names is the destructive half. A database configured
   * before this holds whichever names were entered and the listing traffic
   * collected under them. Rows are typed by *step*, not by event name, so
   * anything pulled as `view_item` is already labelled "listing view" and would
   * sit beside the `page_view` rows counting the same visit twice. Where the
   * stored names differ from the ones now compiled in, the collected traffic
   * and its watermarks go, and the next sync re-reads the range. Nothing is
   * lost that BigQuery cannot re-serve.
   */
  {
    version: 1,
    up: (db) => {
      const connection = columns(db, 'bigquery_connection');
      if (connection.has('dataset')) {
        db.exec('ALTER TABLE bigquery_connection DROP COLUMN dataset');
      }

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

        if (connection.has('view_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN view_event');
        }
        if (connection.has('click_event')) {
          db.exec('ALTER TABLE bigquery_connection DROP COLUMN click_event');
        }
      }

      const sources = columns(db, 'bigquery_app_sources');
      if (sources.size > 0 && !sources.has('location')) {
        db.exec('ALTER TABLE bigquery_app_sources ADD COLUMN location TEXT');
      }

      // Who a listing event belongs to became a resolved value rather than
      // always the browser cookie. Existing rows keep a blank one and fall back
      // to `anonymous_id` at read time, so no re-sync is needed to keep
      // counting.
      const listing = columns(db, 'listing_events');
      if (listing.size > 0) {
        if (!listing.has('user_key')) {
          db.exec(`ALTER TABLE listing_events ADD COLUMN user_key TEXT NOT NULL DEFAULT ''`);
        }
        // Only once the column is certain to exist. In the schema block this
        // ran before the ALTER above and brought the process down on any
        // database created before the column.
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_listing_events_user
             ON listing_events (app_id, type, user_key)`,
        );
      }
    },
  },

  /*
   * Install intervals learned which event opened them.
   *
   * Separate from migration 1 because it is a separate fact about a separate
   * table: `install_intervals` is derived from the Partner API and would carry
   * this column whether or not a partner ever connects BigQuery. Only the
   * reason for wanting it is shared — a funnel that starts with someone reading
   * the listing must end with someone choosing the app, and a shop that was
   * closed and has reopened chose nothing.
   *
   * The column defaults to 'installed', which is wrong for every interval a
   * reopening opened — and the table is only rewritten by the next sync, so a
   * default left to stand would report reopenings as installs until then. The
   * backfill reads it straight off the raw events the interval was built from:
   * an exact match on the opening timestamp, preferring a real install where a
   * shop somehow carries both at the same instant. Cached figures computed
   * under the old reading go with it.
   */
  {
    version: 2,
    up: (db) => {
      const installs = columns(db, 'install_intervals');
      if (installs.size === 0 || installs.has('started_by')) return;

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
    },
  },

  /*
   * Contacts — Role 4, fork-only. Numbered 3 rather than 1: migrations 1 and 2
   * are the upstream BigQuery/funnel fixups (see issue #2 upstream), absorbed
   * here from what was originally an unversioned `migrate()` in
   * src/db/index.ts. This fork's contacts store shipped first locally and
   * carried migration number 1 until that reconciliation — this body is
   * unchanged from that version, only its version number moved.
   */
  {
    version: 3,
    up: (db) => {
      db.exec(CONTACTS_SCHEMA_SQL);
    },
  },
];

export function readUserVersion(db: Db): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0;
}

/**
 * Apply every migration whose version is greater than the database's current
 * user_version. Idempotent: a caught-up database runs zero migrations.
 *
 * `extra` is a test seam — production callers leave it undefined so only
 * MIGRATIONS runs. Tests pass a temporary migration (or a throwing one) without
 * polluting the production list.
 */
export function migrate(db: Db, extra: Migration[] = []): void {
  const current = readUserVersion(db);
  const pending = [...MIGRATIONS, ...extra]
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

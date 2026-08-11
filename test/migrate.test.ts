import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { describe, it } from 'node:test';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../src/bigquery/events.js';
import { MIGRATIONS, migrate, readUserVersion, type Migration } from '../src/db/migrate.js';
import { SCHEMA_SQL } from '../src/db/schema.js';

/**
 * The runner has two jobs and they pull in opposite directions.
 *
 * It must apply a pending change exactly once — that is the whole point of
 * keeping a version. And it must survive a database that already holds the
 * change with the version still unset, because migrations 1 and 2 shipped first
 * as an unversioned function that ran on every open. Every test below is one of
 * those two obligations.
 */

type Db = Database.Database;

const HAS = (db: Db, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === column,
  );

/** A database as SCHEMA_SQL alone would leave it: current shape, version 0. */
function freshDb(): Db {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

/**
 * A database as it stood *before* the funnel work: the pre-migration shape of
 * the two tables migrations 1 and 2 touch, and no BigQuery tables at all.
 */
function legacyDb(): Db {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec('DROP TABLE listing_events');
  db.exec('DROP TABLE bigquery_app_sources');
  db.exec('DROP TABLE bigquery_connection');
  db.exec('DROP TABLE install_intervals');
  db.exec(`
    CREATE TABLE bigquery_connection (
      id            TEXT PRIMARY KEY CHECK (id = 'default'),
      project_id    TEXT NOT NULL,
      dataset       TEXT NOT NULL,
      view_event    TEXT NOT NULL,
      click_event   TEXT NOT NULL,
      credentials   TEXT NOT NULL,
      client_email  TEXT,
      private_key_id TEXT
    );
    CREATE TABLE bigquery_app_sources (
      app_id TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (app_id, source)
    );
    CREATE TABLE listing_events (
      app_id       TEXT NOT NULL,
      type         TEXT NOT NULL,
      occurred_at  TEXT NOT NULL,
      anonymous_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE install_intervals (
      app_id     TEXT NOT NULL,
      shop_id    TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      PRIMARY KEY (app_id, shop_id, started_at)
    ) WITHOUT ROWID;
  `);
  return db;
}

describe('migration runner', () => {
  it('starts a new database at 0 and leaves it at the highest version', () => {
    const db = freshDb();
    assert.equal(readUserVersion(db), 0);
    migrate(db);
    assert.equal(readUserVersion(db), MIGRATIONS.length);
    db.close();
  });

  it('runs nothing on a database that is already caught up', () => {
    const db = freshDb();
    migrate(db);

    let ran = false;
    const alreadyApplied: Migration = { version: 1, up: () => { ran = true; } };
    migrate(db, [alreadyApplied]);

    assert.equal(ran, false, 'a migration at or below user_version must not run');
    db.close();
  });

  it('runs only the pending migrations, in ascending order', () => {
    const db = freshDb();
    migrate(db);

    const order: number[] = [];
    migrate(db, [
      { version: MIGRATIONS.length + 2, up: () => { order.push(2); } },
      { version: MIGRATIONS.length + 1, up: () => { order.push(1); } },
    ]);

    assert.deepEqual(order, [1, 2]);
    assert.equal(readUserVersion(db), MIGRATIONS.length + 2);
    db.close();
  });

  it('rolls back a failed migration and does not bump the version', () => {
    const db = freshDb();
    migrate(db);
    const before = readUserVersion(db);

    const boom: Migration = {
      version: before + 1,
      up: (d) => {
        d.exec('CREATE TABLE half_applied (id TEXT)');
        throw new Error('migration failed');
      },
    };

    assert.throws(() => migrate(db, [boom]), /migration failed/);
    assert.equal(readUserVersion(db), before, 'version must not move on failure');

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    assert.ok(!tables.includes('half_applied'), 'the transaction must roll the table back');
    db.close();
  });

  it('replays cleanly on a database that already holds the changes', () => {
    // The case that matters most: the unversioned function shipped these two
    // changes before the runner existed, so real databases hold them with
    // user_version still 0. An unguarded body would crash here.
    const db = freshDb();
    assert.equal(readUserVersion(db), 0);

    migrate(db);
    db.pragma('user_version = 0');
    assert.doesNotThrow(() => migrate(db));

    assert.equal(readUserVersion(db), MIGRATIONS.length);
    db.close();
  });
});

describe('migration 1 — BigQuery connection and listing events', () => {
  it('drops the moved dataset column and the fixed event-name columns', () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO bigquery_connection (id, project_id, dataset, view_event, click_event, credentials)
       VALUES ('default', 'p', 'ds', ?, ?, '{}')`,
    ).run(LISTING_VIEW_EVENT, ADD_APP_CLICK_EVENT);

    migrate(db);

    assert.ok(!HAS(db, 'bigquery_connection', 'dataset'));
    assert.ok(!HAS(db, 'bigquery_connection', 'view_event'));
    assert.ok(!HAS(db, 'bigquery_connection', 'click_event'));
    db.close();
  });

  it('keeps collected traffic when the stored event names already match', () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO bigquery_connection (id, project_id, dataset, view_event, click_event, credentials)
       VALUES ('default', 'p', 'ds', ?, ?, '{}')`,
    ).run(LISTING_VIEW_EVENT, ADD_APP_CLICK_EVENT);
    db.exec(`INSERT INTO listing_events (app_id, type, occurred_at) VALUES ('111', 'listing_view', '2026-01-01T00:00:00Z')`);

    migrate(db);

    const { c } = db.prepare('SELECT COUNT(*) AS c FROM listing_events').get() as { c: number };
    assert.equal(c, 1, 'traffic collected under the current names is still valid');
    db.close();
  });

  it('discards traffic collected under different event names', () => {
    const db = legacyDb();
    db.prepare(
      `INSERT INTO bigquery_connection (id, project_id, dataset, view_event, click_event, credentials)
       VALUES ('default', 'p', 'ds', 'view_item', 'Add App Button', '{}')`,
    ).run();
    db.exec(`INSERT INTO listing_events (app_id, type, occurred_at) VALUES ('111', 'listing_view', '2026-01-01T00:00:00Z')`);
    db.exec(
      `INSERT INTO sync_state (key, synced_through, updated_at)
       VALUES ('bigquery:111', '2026-01-01', '2026-01-01T00:00:00Z')`,
    );

    migrate(db);

    const { c } = db.prepare('SELECT COUNT(*) AS c FROM listing_events').get() as { c: number };
    assert.equal(c, 0, 'rows typed by step under other names would double-count');
    const { w } = db.prepare(`SELECT COUNT(*) AS w FROM sync_state WHERE key LIKE 'bigquery:%'`).get() as { w: number };
    assert.equal(w, 0, 'the watermark must go with the traffic so the next sync re-reads');
    db.close();
  });

  it('adds the per-app source location and the listing-event user key', () => {
    const db = legacyDb();
    migrate(db);

    assert.ok(HAS(db, 'bigquery_app_sources', 'location'));
    assert.ok(HAS(db, 'listing_events', 'user_key'));
    db.close();
  });
});

describe('migration 2 — install interval opening event', () => {
  it('labels a reopening as reactivated and a real install as installed', () => {
    const db = legacyDb();
    const rows: Array<[string, string, string]> = [
      ['111', 'shop-installed', '2026-01-01T00:00:00Z'],
      ['111', 'shop-reopened', '2026-02-01T00:00:00Z'],
    ];
    for (const [app, shop, at] of rows) {
      db.prepare('INSERT INTO install_intervals (app_id, shop_id, started_at) VALUES (?,?,?)').run(app, shop, at);
    }
    db.prepare(`INSERT INTO app_events (app_id, shop_id, type, occurred_at) VALUES (?,?,?,?)`)
      .run('111', 'shop-installed', 'RELATIONSHIP_INSTALLED', '2026-01-01T00:00:00Z');
    db.prepare(`INSERT INTO app_events (app_id, shop_id, type, occurred_at) VALUES (?,?,?,?)`)
      .run('111', 'shop-reopened', 'RELATIONSHIP_REACTIVATED', '2026-02-01T00:00:00Z');

    migrate(db);

    const got = Object.fromEntries(
      (db.prepare('SELECT shop_id, started_by FROM install_intervals').all() as Array<{ shop_id: string; started_by: string }>)
        .map((r) => [r.shop_id, r.started_by]),
    );
    assert.deepEqual(got, { 'shop-installed': 'installed', 'shop-reopened': 'reactivated' });
    db.close();
  });

  it('prefers a real install where a shop carries both at the same instant', () => {
    const db = legacyDb();
    db.prepare('INSERT INTO install_intervals (app_id, shop_id, started_at) VALUES (?,?,?)')
      .run('111', 'shop-both', '2026-03-01T00:00:00Z');
    for (const type of ['RELATIONSHIP_INSTALLED', 'RELATIONSHIP_REACTIVATED']) {
      db.prepare(`INSERT INTO app_events (app_id, shop_id, type, occurred_at) VALUES (?,?,?,?)`)
        .run('111', 'shop-both', type, '2026-03-01T00:00:00Z');
    }

    migrate(db);

    const { started_by } = db.prepare('SELECT started_by FROM install_intervals').get() as { started_by: string };
    assert.equal(started_by, 'installed', 'an acquisition outranks a reopening at the same instant');
    db.close();
  });
});

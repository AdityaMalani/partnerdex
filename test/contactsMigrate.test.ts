import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  dumpContactsToFile,
  restoreContactsFromFile,
} from '../src/contacts/dump.js';
import { closeDb, getDb, type Db } from '../src/db/index.js';
import { migrate, readUserVersion, type Migration } from '../src/db/migrate.js';
import { resetEnvironment } from './helpers.js';

/**
 * Migration runner acceptance: must create the contacts tables,
 * evolve them later (which CREATE TABLE IF NOT EXISTS cannot), and roll back a
 * failed migration without leaving a half-applied version. The dump CLI must
 * round-trip the three Role-4 tables.
 *
 * Contacts is migration 3, not 1 — migrations 1 and 2 are the upstream
 * BigQuery/funnel column fixups, absorbed into this runner ahead of contacts
 * per the reconciliation agreed in upstream issue #2. A fresh database runs
 * all three and lands on user_version = 3.
 */

function tableNames(db: Db): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function seedContact(db: Db): void {
  const now = '2026-08-06T12:00:00.000Z';
  db.prepare(
    `INSERT INTO contacts (
       email, first_name, last_name, is_suppressed, source,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES (?, ?, ?, 0, 'csv_import', NULL, NULL, ?, ?)`,
  ).run('ada@example.com', 'Ada', 'Lovelace', now, now);

  db.prepare(
    `INSERT INTO contact_shops (
       email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, 'owner', 'auto', NULL, NULL)`,
  ).run('ada@example.com', '111', '10');

  db.prepare(
    `INSERT INTO contact_suppressions (email, suppressed_at, source, reason)
     VALUES (?, ?, 'csv_import', 'unsubscribed')`,
  ).run('opted-out@example.com', now);

  db.prepare(
    `INSERT INTO contacts (
       email, first_name, last_name, is_suppressed, source,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES (?, NULL, NULL, 1, 'csv_import', NULL, NULL, ?, ?)`,
  ).run('opted-out@example.com', now, now);
}

describe('contacts migration runner', () => {
  beforeEach(() => {
    resetEnvironment();
  });

  afterEach(() => {
    closeDb();
  });

  it('creates the three contacts tables and sets user_version = 3 on a fresh DB', () => {
    const db = getDb();
    const names = tableNames(db);

    assert.equal(readUserVersion(db), 3);
    assert.ok(names.has('contacts'));
    assert.ok(names.has('contact_shops'));
    assert.ok(names.has('contact_suppressions'));

    // Index from migration 3 is present.
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_contact_shops_shop'`)
      .all();
    assert.equal(indexes.length, 1);
  });

  it('runs zero migrations on a DB already at user_version = 3 and leaves data untouched', () => {
    const db = getDb();
    seedContact(db);

    const before = db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number };
    assert.equal(before.n, 2);

    migrate(db); // no-op
    assert.equal(readUserVersion(db), 3);

    const after = db
      .prepare(`SELECT email, first_name FROM contacts ORDER BY email`)
      .all() as Array<{ email: string; first_name: string | null }>;
    assert.deepEqual(after, [
      { email: 'ada@example.com', first_name: 'Ada' },
      { email: 'opted-out@example.com', first_name: null },
    ]);
  });

  it('applies a deliberately-added migration 4 exactly once on next open', () => {
    const db = getDb();
    assert.equal(readUserVersion(db), 3);

    const migration4: Migration = {
      version: 4,
      up: (d) => {
        d.exec(`ALTER TABLE contacts ADD COLUMN company TEXT`);
      },
    };

    migrate(db, [migration4]);
    assert.equal(readUserVersion(db), 4);

    const cols = db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string }>;
    assert.ok(cols.some((col) => col.name === 'company'));

    // Second call is a no-op — proves IF NOT EXISTS would have been insufficient
    // for evolving an existing durable table, and that the runner is idempotent.
    migrate(db, [migration4]);
    assert.equal(readUserVersion(db), 4);
  });

  it('rolls back a throwing migration and leaves user_version unchanged', () => {
    const db = getDb();
    seedContact(db);
    assert.equal(readUserVersion(db), 3);

    const boom: Migration = {
      version: 4,
      up: () => {
        throw new Error('intentional migration failure');
      },
    };

    assert.throws(() => migrate(db, [boom]), /intentional migration failure/);
    assert.equal(readUserVersion(db), 3);

    // Pre-existing durable data survived the failed migration.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number };
    assert.equal(count.n, 2);
  });

  it('rolls back schema changes from a migration that fails mid-up', () => {
    const db = getDb();
    assert.equal(readUserVersion(db), 3);

    const boom: Migration = {
      version: 4,
      up: (d) => {
        d.exec(`ALTER TABLE contacts ADD COLUMN scratch TEXT`);
        throw new Error('fail after alter');
      },
    };

    assert.throws(() => migrate(db, [boom]), /fail after alter/);
    assert.equal(readUserVersion(db), 3);

    const cols = db.prepare(`PRAGMA table_info(contacts)`).all() as Array<{ name: string }>;
    assert.equal(
      cols.some((col) => col.name === 'scratch'),
      false,
      'failed migration must not leave a half-applied column',
    );
  });
});

describe('contacts:dump round-trip', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetEnvironment();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partnerdex-contacts-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a restorable off-box copy and restores it into an empty DB', () => {
    const db = getDb();
    seedContact(db);

    const dumpPath = path.join(tmpDir, 'contacts-dump.json');
    const { dump } = dumpContactsToFile(dumpPath, db);
    assert.equal(dump.contacts.length, 2);
    assert.equal(dump.contact_shops.length, 1);
    assert.equal(dump.contact_suppressions.length, 1);
    assert.ok(fs.existsSync(dumpPath));

    // Wipe and restore.
    db.exec('DELETE FROM contact_shops');
    db.exec('DELETE FROM contact_suppressions');
    db.exec('DELETE FROM contacts');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n, 0);

    const restored = restoreContactsFromFile(dumpPath, db);
    assert.deepEqual(restored, {
      contacts: 2,
      contact_shops: 1,
      contact_suppressions: 1,
    });

    const ada = db
      .prepare(`SELECT first_name, last_name, source FROM contacts WHERE email = ?`)
      .get('ada@example.com') as { first_name: string; last_name: string; source: string };
    assert.deepEqual(ada, {
      first_name: 'Ada',
      last_name: 'Lovelace',
      source: 'csv_import',
    });

    const link = db
      .prepare(`SELECT app_id, shop_id, match_method FROM contact_shops WHERE email = ?`)
      .get('ada@example.com') as { app_id: string; shop_id: string; match_method: string };
    assert.deepEqual(link, { app_id: '111', shop_id: '10', match_method: 'auto' });

    const suppression = db
      .prepare(`SELECT source, reason FROM contact_suppressions WHERE email = ?`)
      .get('opted-out@example.com') as { source: string; reason: string };
    assert.deepEqual(suppression, { source: 'csv_import', reason: 'unsubscribed' });
  });
});

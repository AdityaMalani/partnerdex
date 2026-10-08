import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';

/**
 * Off-box backup of the durable contacts tables.
 *
 * Contacts are Role 4 — the SQLite file holds the only copy. Fly volume
 * snapshots are the primary safety net; this dump is the belt: a portable
 * JSON artifact you can pull off the machine before any destructive
 * maintenance, and restore into an empty DB if the volume is lost.
 */

export const DUMP_FORMAT_VERSION = 1;

export interface ContactsDump {
  formatVersion: number;
  exportedAt: string;
  contacts: Record<string, unknown>[];
  contact_shops: Record<string, unknown>[];
  contact_suppressions: Record<string, unknown>[];
}

function allRows(db: Db, table: string): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

export function buildContactsDump(db: Db = getDb()): ContactsDump {
  return {
    formatVersion: DUMP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    contacts: allRows(db, 'contacts'),
    contact_shops: allRows(db, 'contact_shops'),
    contact_suppressions: allRows(db, 'contact_suppressions'),
  };
}

/**
 * Write the three contacts tables to a JSON file. Returns the absolute path
 * and the dump payload that was written. Creates parent directories as needed.
 */
export function dumpContactsToFile(
  filePath: string,
  db: Db = getDb(),
): { path: string; dump: ContactsDump } {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const dump = buildContactsDump(db);
  fs.writeFileSync(absolute, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
  return { path: absolute, dump };
}

export function loadContactsDump(filePath: string): ContactsDump {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as ContactsDump;
  if (raw.formatVersion !== DUMP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported contacts dump formatVersion ${raw.formatVersion}; expected ${DUMP_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(raw.contacts) || !Array.isArray(raw.contact_shops) || !Array.isArray(raw.contact_suppressions)) {
    throw new Error('Contacts dump is missing one or more of contacts / contact_shops / contact_suppressions');
  }
  return raw;
}

/**
 * Restore a dump into the current DB. Replaces the three tables wholesale so a
 * restore is a true round-trip — not a merge. Call only on an empty or
 * intentionally-replaced store.
 */
export function restoreContactsFromDump(dump: ContactsDump, db: Db = getDb()): {
  contacts: number;
  contact_shops: number;
  contact_suppressions: number;
} {
  const insertContact = db.prepare(
    `INSERT INTO contacts (
       email, first_name, last_name, is_suppressed, source,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES (
       @email, @first_name, @last_name, @is_suppressed, @source,
       @first_seen_at, @last_seen_at, @created_at, @updated_at
     )`,
  );
  const insertShop = db.prepare(
    `INSERT INTO contact_shops (
       email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
     ) VALUES (
       @email, @app_id, @shop_id, @role, @match_method, @first_seen_at, @last_seen_at
     )`,
  );
  const insertSuppression = db.prepare(
    `INSERT INTO contact_suppressions (email, suppressed_at, source, reason)
     VALUES (@email, @suppressed_at, @source, @reason)`,
  );

  db.transaction(() => {
    db.exec('DELETE FROM contact_shops');
    db.exec('DELETE FROM contact_suppressions');
    db.exec('DELETE FROM contacts');

    for (const row of dump.contacts) insertContact.run(row);
    for (const row of dump.contact_shops) insertShop.run(row);
    for (const row of dump.contact_suppressions) insertSuppression.run(row);
  })();

  return {
    contacts: dump.contacts.length,
    contact_shops: dump.contact_shops.length,
    contact_suppressions: dump.contact_suppressions.length,
  };
}

export function restoreContactsFromFile(filePath: string, db: Db = getDb()) {
  return restoreContactsFromDump(loadContactsDump(filePath), db);
}

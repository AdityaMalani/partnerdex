import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { migrate } from './migrate.js';
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
  // Schema first, then the changes it cannot express. A migration may reference
  // a table SCHEMA_SQL creates, so the order is load-bearing.
  db.exec(SCHEMA_SQL);
  migrate(db);

  handle = db;
  return db;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/** Test seam: an in-memory database with the schema already applied. */
export function useDb(db: Db): void {
  handle = db;
}

export function readSyncState(db: Db, key: string): { cursor: string | null; syncedThrough: string | null } {
  const row = db
    .prepare('SELECT cursor, synced_through FROM sync_state WHERE key = ?')
    .get(key) as { cursor: string | null; synced_through: string | null } | undefined;
  return { cursor: row?.cursor ?? null, syncedThrough: row?.synced_through ?? null };
}

export function writeSyncState(
  db: Db,
  key: string,
  patch: { cursor?: string | null; syncedThrough?: string | null },
): void {
  const current = readSyncState(db, key);
  db.prepare(
    `INSERT INTO sync_state (key, cursor, synced_through, updated_at)
     VALUES (@key, @cursor, @syncedThrough, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET
       cursor = excluded.cursor,
       synced_through = excluded.synced_through,
       updated_at = excluded.updated_at`,
  ).run({
    key,
    cursor: patch.cursor === undefined ? current.cursor : patch.cursor,
    syncedThrough: patch.syncedThrough === undefined ? current.syncedThrough : patch.syncedThrough,
    updatedAt: new Date().toISOString(),
  });
}

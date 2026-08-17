import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';

/**
 * Read-through cache keyed on the canonical request. The key is the metric plus
 * the normalized query, so two requests that mean the same thing share an
 * entry and one that differs by a single toggle does not.
 *
 * `sync` clears the table wholesale, so a refresh is never served stale data.
 *
 * Generic in the payload because not every report is a time series: the funnel
 * is five steps wide and answers on its own shape, and it wants the same
 * read-through behaviour the metric registry gets.
 */

export function cacheKey(metric: string, query: Record<string, unknown>): string {
  const canonical = Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== '')
    .sort()
    .map((key) => `${key}=${String(query[key])}`)
    .join('&');
  return `${metric}?${canonical}`;
}

/**
 * How long a *cache* write will wait for the write lock, in milliseconds.
 *
 * The connection-wide setting is `busy_timeout = 5000` (`db/index.ts`), and
 * better-sqlite3 honours a busy timeout by blocking **synchronously in native
 * code** — the Node event loop does not turn while it waits. The sync worker
 * holds the single write lock across multi-second rebuilds, so any `GET
 * /api/overview` landing in that window froze the whole process for up to five
 * seconds and then very likely failed anyway. That is a large part of why the
 * background sync is currently switched off in production: the app cannot pass
 * a health check while it runs.
 *
 * Twenty milliseconds is not a retry budget, it is a "the lock is free right
 * now, or never mind". Long enough to ride out the microsecond-scale contention
 * of two ordinary statements, far too short to notice a rebuild.
 */
const CACHE_LOCK_WAIT_MS = 20;

/**
 * Run a cache write with a short lock wait, and swallow contention.
 *
 * The trade, chosen over the two alternatives:
 *
 *   - *Move the cache out of the read path entirely* (compute-on-write in the
 *     worker) is the correct end state and a much larger change: the worker
 *     would have to know every query shape a reader might ask for, which it
 *     cannot, since the window and toggles come from the URL.
 *   - *Keep the 5 s wait* trades a rare recomputation for a guaranteed
 *     multi-second stall of every other request in the process. That is the
 *     wrong way round. A metric cache is an optimization; losing an entry costs
 *     one recomputation on the next request and nothing else. Losing the event
 *     loop costs the health check, and with it the machine.
 *
 * So: best effort. If the lock is held, the entry is simply not written.
 *
 * The `busy_timeout` pragma is per *connection*, and this process has one, so
 * the value is lowered and restored around the statement rather than set once.
 * Restoring in a `finally` matters — leaving the connection on 20 ms would
 * quietly make every other writer in the server fail under contention instead
 * of waiting, which is a different bug with the same shape.
 */
function bestEffortWrite(db: Db, run: () => void): void {
  const previous = (db.pragma('busy_timeout', { simple: true }) as number) ?? 5000;
  try {
    db.pragma(`busy_timeout = ${CACHE_LOCK_WAIT_MS}`);
    run();
  } catch (error) {
    // Only contention is tolerated. A malformed statement or a disk error is a
    // real fault and must not be hidden behind a cache miss forever.
    const code = (error as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_BUSY') && !code.startsWith('SQLITE_LOCKED')) throw error;
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

export function readCache<T>(db: Db, key: string): T | null {
  const { runtime } = getConfig();
  if (runtime.cacheTtlSeconds <= 0) return null;

  const row = db
    .prepare('SELECT payload, expires_at FROM metric_cache WHERE key = ?')
    .get(key) as { payload: string; expires_at: string } | undefined;

  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    // A write on a *read* path, and the least defensible one of the two: the
    // row is about to be overwritten by `writeCache` anyway, so deleting it is
    // housekeeping. Best effort for that reason — an expired row that survives
    // one more request is invisible.
    bestEffortWrite(db, () => {
      db.prepare('DELETE FROM metric_cache WHERE key = ?').run(key);
    });
    return null;
  }

  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export function writeCache<T>(db: Db, key: string, response: T): void {
  const { runtime } = getConfig();
  if (runtime.cacheTtlSeconds <= 0) return;

  const expiresAt = new Date(Date.now() + runtime.cacheTtlSeconds * 1000).toISOString();
  bestEffortWrite(db, () => {
    db.prepare(
      `INSERT INTO metric_cache (key, payload, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
    ).run(key, JSON.stringify(response), expiresAt);
  });
}

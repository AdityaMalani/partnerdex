import { getConfig } from '../config.js';
import { readSyncState, writeSyncState, type Db } from '../db/index.js';
import { addDayKey, dayKeyOf, dayKeyStart, offsetMs } from '../metrics/time.js';

/**
 * Maintenance of `transaction_daily`, the daily money rollup.
 *
 * The read side lives in `metrics/rollup.ts`; this half is only ever run by the
 * sync, in the sync's own child process, alongside the other derived tables. It
 * is deliberately not reachable from a request: a reader who happens to arrive
 * first must never pay to build it.
 *
 * Two properties this module exists to hold:
 *
 *  - **A sum of days equals a sum of rows.** The rollup groups the same rows
 *    with the same SUM over the same columns; nothing is rounded, scaled or
 *    converted on the way in. What it changes is how many times those rows are
 *    read, not what they add up to.
 *  - **A correction always lands.** The Partner API restates transactions that
 *    have already been ingested. Every write to `transactions` marks its day
 *    dirty, and a dirty day is recomputed from the raw rows rather than adjusted,
 *    so a restatement cannot leave a residue behind.
 */

/**
 * Where the rollup records the timezone it was built under.
 *
 * In `sync_state` rather than a table of its own because that is exactly what
 * `sync_state` is for, and because the value has to survive the `DELETE` that
 * starts a full rebuild.
 */
const ROLLUP_STATE_KEY = 'rollup:transaction_daily';

/**
 * Above this many dirty days, rebuild everything instead.
 *
 * The incremental path costs one indexed range seek per day and the full path
 * costs one sequential pass over the table; past a couple of months of dirty
 * days the seeks lose. A first backfill marks every day it imports, so this is
 * also what stops the initial build from taking the slow road.
 */
const FULL_REBUILD_DAY_THRESHOLD = 90;

/**
 * Days recomputed per statement, and per write transaction.
 *
 * The unit of work is bounded so the rollup can never become the thing that
 * OOMs the sync worker — the failure this codebase has already had once, from a
 * derived table that compiled its whole output into one array before writing it.
 * Nothing here holds more than a chunk's worth of aggregate rows, and SQLite
 * does the aggregation itself.
 */
const CHUNK_DAYS = 32;

interface OffsetSegment {
  /**
   * First instant this offset applies to, as an ISO string, or `''` for the
   * opening segment — `created_at >= ''` is true of every stored timestamp, so
   * the ladder needs no special case at its left edge.
   */
  start: string;
  /** Seconds to add to a UTC instant to read the local wall clock. */
  seconds: number;
}

/** Probe spacing when hunting for offset changes. No real zone shifts twice in a day. */
const PROBE_MS = 6 * 3_600_000;

/**
 * The zone's UTC offset, as the piecewise-constant function it actually is.
 *
 * A timezone's offset changes at most a couple of times a year, so mapping an
 * instant to a local date is a lookup into a handful of segments rather than
 * per-row timezone arithmetic — which matters because SQLite has no timezone
 * database and the alternative is dragging millions of rows through JavaScript.
 *
 * Boundaries are resolved to the millisecond by bisection rather than rounded to
 * the transition day. Rounding is wrong in one direction and only in one
 * direction, which is the worst kind of wrong: at a backward transition the last
 * hour of the day would be scored against the *next* day, so a rollup built that
 * way would silently move revenue between days twice a year and agree with
 * itself while doing it.
 *
 * Fixed-offset zones — UTC, and whatever a partner reporting out of one collapses
 * to — produce exactly one segment, and the ladder disappears.
 */
export function offsetSegments(from: Date, to: Date, timeZone: string): OffsetSegment[] {
  const secondsAt = (instant: Date): number => offsetMs(instant, timeZone) / 1000;

  const segments: OffsetSegment[] = [{ start: '', seconds: secondsAt(from) }];
  let previous = from;
  let previousSeconds = segments[0]!.seconds;

  for (let at = from.getTime() + PROBE_MS; ; at += PROBE_MS) {
    const probe = new Date(Math.min(at, to.getTime()));
    const seconds = secondsAt(probe);
    if (seconds !== previousSeconds) {
      // The change happened somewhere in (previous, probe]. Narrow to the exact
      // millisecond so the segment boundary is the transition itself.
      let low = previous.getTime();
      let high = probe.getTime();
      while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (secondsAt(new Date(middle)) === previousSeconds) low = middle;
        else high = middle;
      }
      segments.push({ start: new Date(high).toISOString(), seconds });
      previousSeconds = seconds;
    }
    previous = probe;
    if (probe.getTime() >= to.getTime()) break;
  }

  return segments;
}

/**
 * SQL that reads `column` as a calendar date in the reporting timezone.
 *
 * The offset is selected by a *balanced* CASE rather than a flat chain of
 * WHENs, so a zone with decades of history costs a handful of string
 * comparisons per row instead of one per transition. With a single segment the
 * CASE collapses to a constant and this is a plain `date(col, '<n> seconds')`.
 */
export function dayExpression(
  column: string,
  segments: OffsetSegment[],
  params: Record<string, unknown>,
  prefix: string,
): string {
  const ladder = (lo: number, hi: number): string => {
    if (lo === hi) {
      const name = `${prefix}o${lo}`;
      params[name] = `${segments[lo]!.seconds} seconds`;
      return `@${name}`;
    }
    const middle = lo + Math.ceil((hi - lo) / 2);
    const boundary = `${prefix}b${middle}`;
    params[boundary] = segments[middle]!.start;
    return `CASE WHEN ${column} < @${boundary} THEN ${ladder(lo, middle - 1)} ELSE ${ladder(middle, hi)} END`;
  };

  return `date(${column}, ${ladder(0, segments.length - 1)})`;
}

/**
 * Record that a day's transactions changed. Called by the ingest for every
 * batch it writes, insert or restatement alike.
 *
 * Takes UTC dates because that is what the caller can produce for free from an
 * ISO timestamp; `drainDirtyDays` widens each one to the local days it can
 * overlap. See the schema comment on `transaction_daily_dirty`.
 */
export function markTransactionDays(db: Db, utcDays: Iterable<string>): void {
  const statement = db.prepare('INSERT OR IGNORE INTO transaction_daily_dirty (day) VALUES (?)');
  for (const day of utcDays) statement.run(day);
}

/**
 * The reporting-timezone days a set of dirty UTC dates can touch.
 *
 * A UTC date overlaps at most two local ones anywhere in the −12:00..+14:00
 * range of real offsets, so a day either side covers it with room to spare.
 * Over-recomputing a day is invisible; under-recomputing one is permanent.
 */
function drainDirtyDays(db: Db): string[] {
  const rows = db.prepare('SELECT day FROM transaction_daily_dirty').all() as Array<{ day: string }>;
  const days = new Set<string>();
  for (const row of rows) {
    days.add(addDayKey(row.day, -1));
    days.add(row.day);
    days.add(addDayKey(row.day, 1));
  }
  return [...days].sort();
}

/** Every transaction type present, so an indexed range seek can be issued per type. */
function transactionTypes(db: Db): string[] {
  // `idx_tx_type_money` leads with `type`, so this is a walk of a few index
  // keys rather than a pass over the table.
  return (db.prepare('SELECT DISTINCT type FROM transactions').all() as Array<{ type: string }>).map(
    (row) => row.type,
  );
}

const INSERT_COLUMNS =
  'day, type, app_id, currency, gross_amount, net_amount, shopify_fee, txn_count';
const AGGREGATES =
  'SUM(gross_amount), SUM(net_amount), SUM(shopify_fee), COUNT(*)';

/**
 * Rebuild the whole rollup in one sequential pass.
 *
 * One statement, and SQLite does the grouping: the output is one row per
 * day/type/app/currency, which is thousands of rows against millions, so the
 * aggregate is held in a temp b-tree of a size that does not depend on how big
 * the ledger got. Nothing is materialized in JavaScript.
 */
function buildAll(db: Db, timeZone: string): number {
  const bounds = db
    .prepare('SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM transactions')
    .get() as { lo: string | null; hi: string | null };
  if (!bounds.lo || !bounds.hi) {
    db.prepare('DELETE FROM transaction_daily').run();
    return 0;
  }

  const segments = offsetSegments(new Date(bounds.lo), new Date(bounds.hi), timeZone);
  const params: Record<string, unknown> = {};
  const day = dayExpression('created_at', segments, params, 'f');

  db.transaction(() => {
    db.prepare('DELETE FROM transaction_daily').run();
    db.prepare(
      `INSERT INTO transaction_daily (${INSERT_COLUMNS})
       SELECT ${day} AS day, type, app_id, currency, ${AGGREGATES}
       FROM transactions
       GROUP BY day, type, app_id, currency`,
    ).run(params);
  })();

  return (db.prepare('SELECT COUNT(*) AS n FROM transaction_daily').get() as { n: number }).n;
}

/**
 * Recompute a contiguous run of days from the raw rows, in place.
 *
 * Deleted and re-aggregated rather than adjusted, which is what makes a
 * restatement safe: the new figures are whatever the raw rows say now, with no
 * dependence on what they said before, so a correction that arrives twice and a
 * correction that arrives once produce the same answer.
 *
 * Split by type because `idx_tx_type_money` is `(type, created_at, ...)`: with
 * the type pinned, each day is an index range seek. There is no index on
 * `created_at` alone, and adding one to a table this size to save this loop
 * would cost more on every write than it saves here.
 */
function buildDays(db: Db, timeZone: string, days: string[], types: string[]): void {
  if (days.length === 0 || types.length === 0) return;

  const first = days[0]!;
  const lastExclusive = addDayKey(days[days.length - 1]!, 1);
  const lo = dayKeyStart(first, timeZone);
  const hi = dayKeyStart(lastExclusive, timeZone);

  const params: Record<string, unknown> = {
    lo: lo.toISOString(),
    hi: hi.toISOString(),
    dayLo: first,
    dayHi: lastExclusive,
  };
  const segments = offsetSegments(lo, hi, timeZone);
  const day = dayExpression('created_at', segments, params, 'i');
  const typeNames = types.map((type, index) => {
    params[`t${index}`] = type;
    return `@t${index}`;
  });

  db.transaction(() => {
    db.prepare('DELETE FROM transaction_daily WHERE day >= @dayLo AND day < @dayHi').run({
      dayLo: params.dayLo,
      dayHi: params.dayHi,
    });
    db.prepare(
      `INSERT INTO transaction_daily (${INSERT_COLUMNS})
       SELECT ${day} AS day, type, app_id, currency, ${AGGREGATES}
       FROM transactions
       WHERE type IN (${typeNames.join(', ')})
         AND created_at >= @lo
         AND created_at < @hi
       GROUP BY day, type, app_id, currency`,
    ).run(params);
  })();
}

export interface RollupResult {
  /** True when the whole table was rewritten rather than patched. */
  full: boolean;
  /** Reporting-timezone days recomputed. Equals the table's span on a full build. */
  days: number;
  rows: number;
}

/**
 * Bring `transaction_daily` up to date with `transactions`.
 *
 * Full when it is asked to be, when the rollup is empty beside a non-empty
 * ledger (a first sync, or a database restored without it), when the reporting
 * timezone has changed underneath it — the day keys mean something else then and
 * cannot be patched into agreement — or when so many days are dirty that one
 * pass is cheaper than many seeks. Incremental otherwise: a sync that ingests a
 * day of transactions touches that day.
 */
export function syncTransactionDaily(db: Db, options: { full?: boolean } = {}): RollupResult {
  const timeZone = getConfig().runtime.timezone;
  const storedTimeZone = readSyncState(db, ROLLUP_STATE_KEY).cursor;
  const populated =
    (db.prepare('SELECT 1 AS present FROM transaction_daily LIMIT 1').get() as
      | { present: number }
      | undefined) !== undefined;

  const dirty = drainDirtyDays(db);
  const full =
    Boolean(options.full) ||
    storedTimeZone !== timeZone ||
    !populated ||
    dirty.length > FULL_REBUILD_DAY_THRESHOLD;

  let rows: number;
  let days: number;
  if (full) {
    rows = buildAll(db, timeZone);
    days = (
      db.prepare('SELECT COUNT(DISTINCT day) AS n FROM transaction_daily').get() as { n: number }
    ).n;
  } else {
    const types = transactionTypes(db);
    for (let at = 0; at < dirty.length; at += CHUNK_DAYS) {
      buildDays(db, timeZone, dirty.slice(at, at + CHUNK_DAYS), types);
    }
    days = dirty.length;
    rows = (db.prepare('SELECT COUNT(*) AS n FROM transaction_daily').get() as { n: number }).n;
  }

  // Only once the rows are in. A crash before this leaves the marks in place
  // and the stored timezone stale, and the next sync redoes the work — the
  // failure mode of this table is always "rebuild it", never "trust it".
  db.prepare('DELETE FROM transaction_daily_dirty').run();
  writeSyncState(db, ROLLUP_STATE_KEY, { cursor: timeZone, syncedThrough: new Date().toISOString() });

  return { full, days, rows };
}

/**
 * Whether the rollup can be read for the timezone currently configured.
 *
 * Consulted on the read path so a database that has never synced, or one whose
 * `REPORTING_TIMEZONE` changed since the last sync, still answers correctly —
 * out of the raw table, the slow way, rather than out of a rollup that means
 * something else.
 */
export function transactionDailyReady(db: Db, timeZone: string): boolean {
  if (readSyncState(db, ROLLUP_STATE_KEY).cursor !== timeZone) return false;
  return (
    (db.prepare('SELECT 1 AS present FROM transaction_daily LIMIT 1').get() as
      | { present: number }
      | undefined) !== undefined
  );
}

/** Test seam: the day key a row would be filed under. */
export function transactionDayKey(createdAt: string, timeZone: string): string {
  return dayKeyOf(new Date(createdAt), timeZone);
}

import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { transactionDailyReady } from '../sync/rollup.js';
import { addDayKey, dayKeyOf, dayKeyStart } from './time.js';
import type { Fragment } from './asof.js';

/**
 * Reading `transaction_daily` in place of the raw ledger.
 *
 * The rollup is keyed on whole reporting-timezone days and the windows metrics
 * ask about are not: a period ends at *now*, and a relative period starts at now
 * minus thirty days, so both edges of a window normally fall in the middle of a
 * day. A rollup alone therefore cannot answer any of these questions exactly.
 *
 * So it answers the part it can. Every window is cut into three: a partial day
 * at the head, a whole number of rollup days in the middle, and a partial day at
 * the tail. The middle comes from the rollup; the two remainders come from the
 * raw table over ranges narrow enough to be index seeks. The result is exact by
 * construction rather than by tolerance — the same rows are summed either way,
 * the middle ones just arrive pre-added.
 *
 * When the rollup is not usable — never synced, or synced under a different
 * `REPORTING_TIMEZONE` — every window degenerates to a single raw range and the
 * queries behave exactly as they did before this table existed. That is the
 * cold-database path, and it is slow rather than wrong.
 */

/**
 * Bucket boundaries land on local midnights only in the interior of a window.
 * `resolveWindow` clamps the first bucket's start to the requested start and the
 * last bucket's end to the requested end, so the two outermost buckets are the
 * ones that carry remainders — and at an `interval=hour` granularity every
 * bucket does, at which point this falls back to raw ranges an hour wide.
 */
export interface DayRange {
  idx: number;
  /** Half-open range of day keys, both `''` when the bucket has no whole day. */
  from: string;
  to: string;
}

export interface EdgeRange {
  idx: number;
  /** Half-open instant range, ISO. */
  lo: string;
  hi: string;
}

export interface BucketSplit {
  days: DayRange[];
  edges: EdgeRange[];
}

export interface SplitInput {
  idx: number;
  from: Date;
  /** Exclusive. See `toHalfOpen` for windows whose upper edge is inclusive. */
  to: Date;
}

/**
 * Turn an inclusive upper bound into an exclusive one.
 *
 * Every `transactions.created_at` is written through `toUtcIso`, so every stored
 * value has exactly millisecond precision and no timestamp can lie strictly
 * between an instant and that instant plus a millisecond. `created_at <= H` and
 * `created_at < H + 1ms` therefore select identically over the stored data,
 * which lets the trailing-30-day window — the one metric window that is
 * half-open the other way round — reuse this module unchanged instead of
 * carrying a second set of comparison operators through every query.
 */
export function toHalfOpen(openLow: Date, closedHigh: Date): { from: Date; to: Date } {
  return { from: new Date(openLow.getTime() + 1), to: new Date(closedHigh.getTime() + 1) };
}

/**
 * Cut each window into whole rollup days plus its sub-day remainders.
 *
 * `ready === false` puts the whole of every window in the remainders, which is
 * the pre-rollup behaviour expressed in the same shape.
 */
export function splitBuckets(ranges: SplitInput[], timeZone: string, ready: boolean): BucketSplit {
  const days: DayRange[] = [];
  const edges: EdgeRange[] = [];

  for (const range of ranges) {
    if (!ready || range.to.getTime() <= range.from.getTime()) {
      days.push({ idx: range.idx, from: '', to: '' });
      edges.push({ idx: range.idx, lo: range.from.toISOString(), hi: range.to.toISOString() });
      continue;
    }

    // The first whole day is this instant's own day when the instant is exactly
    // its midnight, and the next one otherwise. The last whole day ends at the
    // midnight opening the day the window's end falls in, which is at or before
    // that end by definition.
    const fromKey = dayKeyOf(range.from, timeZone);
    const fromMidnight = dayKeyStart(fromKey, timeZone);
    const firstWholeKey =
      fromMidnight.getTime() === range.from.getTime() ? fromKey : addDayKey(fromKey, 1);
    const firstWholeStart = dayKeyStart(firstWholeKey, timeZone);

    const toKey = dayKeyOf(range.to, timeZone);
    const lastWholeEnd = dayKeyStart(toKey, timeZone);

    if (firstWholeStart.getTime() >= lastWholeEnd.getTime()) {
      // Narrower than a day, or straddling one midnight with nothing whole in
      // between. One raw range, no rollup.
      days.push({ idx: range.idx, from: '', to: '' });
      edges.push({ idx: range.idx, lo: range.from.toISOString(), hi: range.to.toISOString() });
      continue;
    }

    days.push({ idx: range.idx, from: firstWholeKey, to: toKey });
    if (range.from.getTime() < firstWholeStart.getTime()) {
      edges.push({
        idx: range.idx,
        lo: range.from.toISOString(),
        hi: firstWholeStart.toISOString(),
      });
    }
    if (lastWholeEnd.getTime() < range.to.getTime()) {
      edges.push({
        idx: range.idx,
        lo: lastWholeEnd.toISOString(),
        hi: range.to.toISOString(),
      });
    }
  }

  return { days, edges };
}

/**
 * The two CTEs the split becomes.
 *
 * A bucket with no whole days still gets a `rdays` row, with an empty range that
 * matches nothing — one row per bucket keeps the shape of the query independent
 * of the data. `redges` gets a sentinel row when there are no remainders at all,
 * because SQLite's `VALUES` needs at least one and `created_at >= '' AND
 * created_at < ''` is false for every row.
 */
export function splitCte(split: BucketSplit): Fragment {
  const params: Record<string, unknown> = {};

  const dayRows = split.days.map((day, index) => {
    params[`rdi${index}`] = day.idx;
    params[`rdf${index}`] = day.from;
    params[`rdt${index}`] = day.to;
    return `(@rdi${index}, @rdf${index}, @rdt${index})`;
  });
  if (dayRows.length === 0) {
    params.rdiNone = -1;
    dayRows.push(`(@rdiNone, '', '')`);
  }

  const edgeRows = split.edges.map((edge, index) => {
    params[`rei${index}`] = edge.idx;
    params[`rel${index}`] = edge.lo;
    params[`reh${index}`] = edge.hi;
    return `(@rei${index}, @rel${index}, @reh${index})`;
  });
  if (edgeRows.length === 0) {
    params.reiNone = -1;
    edgeRows.push(`(@reiNone, '', '')`);
  }

  return {
    sql:
      `rdays(idx, day_from, day_to) AS (VALUES ${dayRows.join(', ')}), ` +
      `redges(idx, lo, hi) AS (VALUES ${edgeRows.join(', ')})`,
    params,
  };
}

/** `app_id IN (...)` over whichever alias, or nothing when the scope is every app. */
export function appIdFilter(appIds: string[], column: string, prefix: string): Fragment {
  if (appIds.length === 0) return { sql: '', params: {} };
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    params[`${prefix}${index}`] = id;
    return `@${prefix}${index}`;
  });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

/**
 * Whether this database's rollup can serve the timezone in force right now.
 *
 * Cheap enough to ask per metric — a `sync_state` lookup and a one-row probe —
 * and asked there rather than cached in a module variable because the sync runs
 * in a different process and this one would never learn that it had finished.
 */
export function rollupReady(db: Db): boolean {
  return transactionDailyReady(db, getConfig().runtime.timezone);
}

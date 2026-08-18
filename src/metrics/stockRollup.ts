import { getConfig } from '../config.js';
import { readSyncState, type Db } from '../db/index.js';
import { dayKeyOf, dayKeyStart } from './time.js';
import type { Fragment } from './predicate.js';

/**
 * Reading the daily snapshots in place of an as-of scan of the raw tables.
 *
 * `metrics/rollup.ts` does this for flows: a window is cut into whole rollup
 * days plus two sub-day remainders, and the middle arrives pre-added. A stock
 * cannot be cut that way, because a stock is read at one instant rather than
 * summed over a span. So the rule here is simpler and stricter:
 *
 *   **an instant that is exactly a local midnight is answered by the snapshot
 *   for that day; every other instant is answered by the raw tables.**
 *
 * That is enough, because of where the instants come from. Every bucket's as-of
 * instant is the exclusive end of a bucket, `startOfInterval` puts those on
 * local hour / day / week / month boundaries, and all but the hourly ones *are*
 * local midnights. The one exception in an ordinary window is its last bucket,
 * whose end `resolveWindow` clamps to the requested end — usually now. So a
 * twelve-month series is eleven snapshot lookups and one raw scan, where it used
 * to be twelve raw scans.
 *
 * There is no tolerance anywhere in this: an instant either is the midnight the
 * snapshot was taken at, to the millisecond, or it is not.
 */

/** Where the snapshot builder records the timezone it built under. */
export const STOCK_ROLLUP_STATE_KEY = 'rollup:stock_daily';
/** And the span of days it built, which bounds what a snapshot may answer. */
export const STOCK_ROLLUP_RANGE_KEY = 'rollup:stock_daily:range';

/**
 * What the snapshots can currently be trusted for.
 *
 * The day span matters as much as the readiness flag. A snapshot table answers
 * "nothing was live" and "this day was never built" with the same absence of
 * rows, and those are different facts — a custom window may end in the future,
 * past the last midnight the sync had a population for. Outside the built span
 * an instant goes to the raw tables, where the question has an answer.
 */
export interface StockCoverage {
  ready: boolean;
  /** Inclusive day keys. Meaningless when `ready` is false. */
  first: string;
  last: string;
}

export const NO_COVERAGE: StockCoverage = { ready: false, first: '', last: '' };

export interface SnapshotRef {
  idx: number;
  /** The reporting-timezone day whose opening midnight is this instant. */
  day: string;
  /** That same instant, carried through so both halves return the same columns. */
  asOf: Date;
}

export interface RawRef {
  idx: number;
  asOf: Date;
}

export interface InstantSplit {
  snapshots: SnapshotRef[];
  raw: RawRef[];
}

/**
 * Sort each as-of instant into the half that a snapshot can answer and the half
 * that cannot.
 *
 * `ready === false` sends every instant to the raw side, which is the
 * behaviour before these tables existed, expressed in the same shape.
 */
export function splitInstants(
  instants: Array<{ idx: number; asOf: Date }>,
  timeZone: string,
  coverage: StockCoverage,
): InstantSplit {
  const snapshots: SnapshotRef[] = [];
  const raw: RawRef[] = [];

  for (const instant of instants) {
    if (!coverage.ready) {
      raw.push(instant);
      continue;
    }
    // `dayKeyOf` and `dayKeyStart` are the same pair the builder resolves days
    // through, so "is this instant a midnight" is asked in exactly the terms
    // the snapshot was filed under, DST edges included.
    const day = dayKeyOf(instant.asOf, timeZone);
    const midnight = dayKeyStart(day, timeZone).getTime() === instant.asOf.getTime();
    if (midnight && day >= coverage.first && day <= coverage.last) {
      snapshots.push({ idx: instant.idx, day, asOf: instant.asOf });
    } else {
      raw.push(instant);
    }
  }

  return { snapshots, raw };
}

/** `(idx, day, as_of)` rows for the snapshot side. Never called when empty. */
export function snapshotCte(refs: SnapshotRef[], name: string, prefix: string): Fragment {
  const params: Record<string, unknown> = {};
  const rows = refs.map((ref, index) => {
    params[`${prefix}i${index}`] = ref.idx;
    params[`${prefix}d${index}`] = ref.day;
    params[`${prefix}a${index}`] = ref.asOf.toISOString();
    return `(@${prefix}i${index}, @${prefix}d${index}, @${prefix}a${index})`;
  });
  return { sql: `${name}(idx, day, as_of) AS (VALUES ${rows.join(', ')})`, params };
}

/**
 * `(idx, as_of, ...)` rows for the raw side.
 *
 * `extra` carries the columns a caller needs beside the as-of instant — churn's
 * rolling windows pass the window start alongside it — so the raw fallback can
 * stay the query it already was rather than growing a second shape.
 */
export function rawInstantCte(
  refs: RawRef[],
  name: string,
  prefix: string,
  extra: Array<{ column: string; valueOf: (ref: RawRef) => string }> = [],
): Fragment {
  const params: Record<string, unknown> = {};
  const rows = refs.map((ref, index) => {
    params[`${prefix}i${index}`] = ref.idx;
    params[`${prefix}a${index}`] = ref.asOf.toISOString();
    const cells = [`@${prefix}i${index}`, `@${prefix}a${index}`];
    extra.forEach((column, position) => {
      const name = `${prefix}x${position}_${index}`;
      params[name] = column.valueOf(ref);
      cells.push(`@${name}`);
    });
    return `(${cells.join(', ')})`;
  });
  const columns = ['idx', 'as_of', ...extra.map((column) => column.column)];
  return { sql: `${name}(${columns.join(', ')}) AS (VALUES ${rows.join(', ')})`, params };
}

/** `app_id IN (...)` over whichever alias, or nothing when the scope is every app. */
export function appIdIn(appIds: string[], column: string, prefix: string): Fragment {
  if (appIds.length === 0) return { sql: '', params: {} };
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    params[`${prefix}${index}`] = id;
    return `@${prefix}${index}`;
  });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

/**
 * Whether this database's snapshots can serve the timezone in force right now.
 *
 * Asked per read rather than cached in a module variable for the reason the
 * money rollup gives: the sync runs in a different process, and a cached `false`
 * would never learn that the build had finished.
 */
export function stockCoverage(db: Db): StockCoverage {
  const timeZone = getConfig().runtime.timezone;
  if (readSyncState(db, STOCK_ROLLUP_STATE_KEY).cursor !== timeZone) return NO_COVERAGE;
  const range = readSyncState(db, STOCK_ROLLUP_RANGE_KEY).cursor;
  if (!range) return NO_COVERAGE;
  const [first, last] = range.split('..');
  if (!first || !last || first > last) return NO_COVERAGE;
  return { ready: true, first, last };
}

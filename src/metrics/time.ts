/**
 * Period parsing, timezone-aware bucketing, and the single range->interval
 * ladder. Every report resolves its window through `resolveWindow` so there is
 * exactly one place that decides what "last_90_days at week granularity" means.
 */

export type Interval = 'hour' | 'day' | 'week' | 'month';

export const INTERVALS: readonly Interval[] = ['hour', 'day', 'week', 'month'];

export const PERIODS = [
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'last_12_months',
  'year_to_date',
  'all_time',
  'custom',
] as const;

export type Period = (typeof PERIODS)[number];

export class TimeRangeError extends Error {}

const MS_PER_DAY = 86_400_000;

/** Canonical UTC ISO-8601. Everything stored or compared goes through this. */
export function toUtcIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TimeRangeError(`Invalid date: ${String(value)}`);
  }
  return date.toISOString();
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function wallClockIn(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  return {
    year: lookup.year!,
    month: lookup.month!,
    day: lookup.day!,
    // Intl renders midnight as hour 24 in some locales/zones.
    hour: (lookup.hour ?? 0) % 24,
    minute: lookup.minute ?? 0,
    second: lookup.second ?? 0,
  };
}

export function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallClockIn(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // The wall clock has no milliseconds, so compare against a floored instant.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which `timeZone` reads the given wall clock. Solved by
 * iteration because the offset itself depends on the instant across DST edges.
 */
export function instantFromWallClock(wall: WallClock, timeZone: string): Date {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMs(new Date(guess), timeZone);
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function startOfInterval(instant: Date, interval: Interval, timeZone: string): Date {
  const wall = wallClockIn(instant, timeZone);
  switch (interval) {
    case 'hour':
      return instantFromWallClock({ ...wall, minute: 0, second: 0 }, timeZone);
    case 'day':
      return instantFromWallClock({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone);
    case 'week': {
      const midnight = instantFromWallClock({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone);
      // Weeks start Monday.
      const dow = (new Date(midnight.getTime() + offsetMs(midnight, timeZone)).getUTCDay() + 6) % 7;
      const shifted = wallClockIn(new Date(midnight.getTime() - dow * MS_PER_DAY), timeZone);
      return instantFromWallClock({ ...shifted, hour: 0, minute: 0, second: 0 }, timeZone);
    }
    case 'month':
      return instantFromWallClock({ ...wall, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  }
}

export function addInterval(
  instant: Date,
  interval: Interval,
  count: number,
  timeZone: string,
): Date {
  const wall = wallClockIn(instant, timeZone);
  switch (interval) {
    case 'hour':
      return instantFromWallClock({ ...wall, hour: wall.hour + count }, timeZone);
    case 'day':
      return instantFromWallClock({ ...wall, day: wall.day + count }, timeZone);
    case 'week':
      return instantFromWallClock({ ...wall, day: wall.day + count * 7 }, timeZone);
    case 'month':
      return instantFromWallClock({ ...wall, month: wall.month + count }, timeZone);
  }
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * MS_PER_DAY);
}

/**
 * A calendar date in the reporting timezone, `YYYY-MM-DD`.
 *
 * This is the key the transaction rollup is stored under, so it and
 * `dayKeyStart` below are the only definition of "what day is this row in"
 * that exists. Anything that reads the rollup must go through the same pair, or
 * the rollup's days and the reader's days are two different things that happen
 * to have the same name.
 */
export function dayKeyOf(instant: Date, timeZone: string): string {
  const wall = wallClockIn(instant, timeZone);
  const month = String(wall.month).padStart(2, '0');
  const day = String(wall.day).padStart(2, '0');
  return `${wall.year}-${month}-${day}`;
}

/** Calendar arithmetic on a day key. UTC only ever touches the digits here. */
export function addDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant at which the reporting timezone enters `dayKey`.
 *
 * Day `D` owns the half-open span `[dayKeyStart(D), dayKeyStart(D + 1))`, which
 * is 23, 24 or 25 hours long across a DST edge. That is the point of keying the
 * rollup on local days rather than UTC ones: a bucket boundary produced by
 * `startOfInterval` *is* one of these instants, so a bucket's interior is an
 * exact whole number of rollup days with nothing left over at the seam.
 *
 * The one shape this cannot express is a zone that skips midnight itself (a
 * transition at 00:00 moving the clock forward). `instantFromWallClock` settles
 * on the instant just after the gap there, which is still a single consistent
 * answer — and because the rollup builder resolves days through this same
 * function, builder and reader stay in agreement even then.
 */
export function dayKeyStart(dayKey: string, timeZone: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number) as [number, number, number];
  return instantFromWallClock({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

/**
 * The one range->interval ladder (spec 3.3). Do not inline this rule anywhere
 * else; the API and the UI must agree on granularity.
 *
 * Two rungs, not four. The dashboard no longer lets a reader pick granularity,
 * so the ladder is the only thing that decides it, and a two-way split is the
 * one a reader can predict without being told: daily up to a quarter, monthly
 * beyond. `hour` and `week` remain reachable through an explicit `interval=`
 * on the API for callers that want them.
 */
export function autoInterval(start: Date, end: Date): Interval {
  const days = (end.getTime() - start.getTime()) / MS_PER_DAY;
  return days <= 90 ? 'day' : 'month';
}

export interface Bucket {
  /** Inclusive start of the bucket. */
  start: Date;
  /** Exclusive end of the bucket, and the instant stock metrics are read at. */
  end: Date;
}

export interface Window {
  period: Period;
  start: Date;
  end: Date;
  interval: Interval;
  timeZone: string;
  /** Visible buckets, plus one hidden leading bucket at index -1. */
  buckets: Bucket[];
  /** The extra bucket before `start`, used only to seed the first delta. */
  leading: Bucket;
}

export interface ResolveWindowInput {
  period?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  interval?: string | undefined;
  timeZone: string;
  /** Floor for `all_time`, normally the configured sync start date. */
  allTimeStart: string;
  now?: Date;
  /** Only forecasting opts in; everything else clamps to now. */
  allowFutureDates?: boolean;
}

function parseBoundary(raw: string, timeZone: string, edge: 'start' | 'end'): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number) as [number, number, number];
    // A bare day string means the whole local day; the end edge is exclusive,
    // so it resolves to the following midnight.
    const wall = { year, month, day: edge === 'start' ? day : day + 1, hour: 0, minute: 0, second: 0 };
    return instantFromWallClock(wall, timeZone);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new TimeRangeError(`Invalid ${edge} date: ${raw}`);
  }
  return parsed;
}

export function resolveWindow(input: ResolveWindowInput): Window {
  const timeZone = input.timeZone;
  const now = input.now ?? new Date();

  if (input.period && !(PERIODS as readonly string[]).includes(input.period)) {
    throw new TimeRangeError(
      `Unknown period "${input.period}". Allowed: ${PERIODS.join(', ')}.`,
    );
  }
  if (input.interval && !(INTERVALS as readonly string[]).includes(input.interval)) {
    throw new TimeRangeError(
      `Unknown interval "${input.interval}". Allowed: ${INTERVALS.join(', ')}.`,
    );
  }

  const hasExplicitStart = Boolean(input.start);
  const period: Period =
    (input.period as Period | undefined) ?? (hasExplicitStart ? 'custom' : 'last_30_days');

  /**
   * The anchor is what "as of" means: every preset measures its span backwards
   * from here rather than from now. That is what lets "last 12 months as of
   * 2024-06-30" reconstruct the series as it stood on that date, instead of
   * collapsing to a bare custom range.
   */
  // Clamp before measuring the span backwards, or a future anchor produces a
  // start that is also in the future and the range inverts.
  const requestedAnchor = input.end ? parseBoundary(input.end, timeZone, 'end') : now;
  const anchor =
    !input.allowFutureDates && requestedAnchor.getTime() > now.getTime() ? now : requestedAnchor;

  let start: Date;
  let end: Date = anchor;

  if (period === 'custom' || hasExplicitStart) {
    start = input.start ? parseBoundary(input.start, timeZone, 'start') : addDays(anchor, -30);
  } else {
    switch (period) {
      case 'last_7_days':
        start = addDays(anchor, -7);
        break;
      case 'last_30_days':
        start = addDays(anchor, -30);
        break;
      case 'last_90_days':
        start = addDays(anchor, -90);
        break;
      case 'last_12_months':
        start = addInterval(anchor, 'month', -12, timeZone);
        break;
      case 'year_to_date': {
        const wall = wallClockIn(anchor, timeZone);
        start = instantFromWallClock(
          { year: wall.year, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
          timeZone,
        );
        break;
      }
      case 'all_time':
        start = parseBoundary(input.allTimeStart, timeZone, 'start');
        break;
      default:
        start = addDays(anchor, -30);
    }
  }

  if (start.getTime() >= end.getTime()) {
    throw new TimeRangeError('The start of the range must be before its end.');
  }

  const interval = (input.interval as Interval | undefined) ?? autoInterval(start, end);

  const buckets: Bucket[] = [];
  let cursor = startOfInterval(start, interval, timeZone);
  // Guard against a pathological range producing an unbounded series.
  const MAX_BUCKETS = 2000;
  while (cursor.getTime() < end.getTime() && buckets.length < MAX_BUCKETS) {
    const next = addInterval(cursor, interval, 1, timeZone);
    buckets.push({
      // Clamp the first bucket so it never claims data before the request.
      start: buckets.length === 0 && cursor.getTime() < start.getTime() ? start : cursor,
      end: next.getTime() > end.getTime() ? end : next,
    });
    cursor = next;
  }

  if (buckets.length === 0) {
    buckets.push({ start, end });
  }

  const firstStart = startOfInterval(buckets[0]!.start, interval, timeZone);
  const leading: Bucket = {
    start: addInterval(firstStart, interval, -1, timeZone),
    end: firstStart,
  };

  return { period, start, end, interval, timeZone, buckets, leading };
}

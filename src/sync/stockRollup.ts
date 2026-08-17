import { getConfig } from '../config.js';
import { readSyncState, writeSyncState, type Db } from '../db/index.js';
import { asOfPredicate } from '../metrics/predicate.js';
import {
  STOCK_ROLLUP_RANGE_KEY,
  STOCK_ROLLUP_STATE_KEY,
} from '../metrics/stockRollup.js';
import { addDayKey, dayKeyOf, dayKeyStart } from '../metrics/time.js';
import { dayExpression, offsetSegments } from './rollup.js';

/**
 * Maintenance of the subscription-side rollups: `subscription_daily`,
 * `population_daily` and `customer_event_daily`.
 *
 * The read side lives in `metrics/stockRollup.ts`; this half is only ever run by
 * the sync, in the sync's own child process, alongside the other derived tables.
 * Nothing here is reachable from a request: a reader who happens to arrive first
 * must never pay to build it.
 *
 * Three properties this module exists to hold.
 *
 *  - **A snapshot is the predicate, evaluated early.** The live-population SQL
 *    is `asOfPredicate` — the same text `asof.ts` runs against the raw table, out
 *    of the same module — with the bucket's instant replaced by a day's opening
 *    midnight. There is no second definition of "live" to drift from the first.
 *  - **A stock is repaired forward, not per day.** A backdated cancellation
 *    changes the population at every midnight from the backdate to now, so the
 *    dirty mark is a floor and everything above it is recomputed. The flow
 *    rollup's day-at-a-time repair would be wrong here, and quietly.
 *  - **A correction always lands, and lands once.** Every recomputed day is
 *    deleted and rebuilt from the raw rows rather than adjusted, so a
 *    restatement applied twice ends where applying it once ends.
 */

/**
 * Days recomputed per statement, and per write transaction.
 *
 * A snapshot day costs a pass over the live subscriptions, so a chunk is a
 * bounded amount of work *and* a bounded amount of memory: SQLite aggregates
 * into a temp b-tree whose size is the chunk's output rows — days x apps —
 * and nothing is materialised in JavaScript. This repository has OOMed its sync
 * worker once already with a derived table that built its whole output as one
 * array; that shape is not reintroduced here.
 */
const CHUNK_DAYS = 32;

/**
 * The event types logo churn counts, and the only ones `customer_event_daily`
 * stores.
 *
 * Rolling up every event would make the table far bigger than it needs to be to
 * answer the one question that reads it, and would turn its build from four
 * index seeks into a scan of the largest table in the database.
 */
const LIFECYCLE_TYPES = ['uninstalled', 'deactivated', 'reinstalled', 'reactivated'];

/** Far enough ahead to sort above every real timestamp. */
const NEVER = '9999-12-31T00:00:00.000Z';

/**
 * The fields each snapshot actually depends on, as one string per source row.
 *
 * A change to any of these can move a number; a change to anything else — a plan
 * renamed, a churn reason reworded — cannot, and marking it dirty would
 * recompute history for nothing. The digests are deliberately built from the
 * columns the predicate and the SUMs name, so the list is checkable against the
 * queries below rather than against a memory of them.
 */
const SUBSCRIPTION_DIGEST = `s.app_id || '|' || s.shop_id || '|' || s.is_test || '|' ||
   s.billing_interval || '|' || s.monthly_amount || '|' ||
   COALESCE(s.activated_at, '') || '|' || COALESCE(s.conversion_at, '') || '|' ||
   COALESCE(s.churn_at, '') || '|' || COALESCE(s.frozen_at, '') || '|' ||
   COALESCE(s.unfrozen_at, '') || '|' || COALESCE(s.trial_started_at, '') || '|' ||
   COALESCE(s.trial_ends_at, '')`;

/**
 * The earliest instant a change to a subscription can move a snapshot: the
 * first of its own dates. Every predicate term compares against one of them, so
 * no midnight before the earliest can be affected either way round.
 */
const SUBSCRIPTION_SINCE = `MIN(
     COALESCE(s.activated_at, '${NEVER}'), COALESCE(s.conversion_at, '${NEVER}'),
     COALESCE(s.churn_at, '${NEVER}'), COALESCE(s.frozen_at, '${NEVER}'),
     COALESCE(s.unfrozen_at, '${NEVER}'), COALESCE(s.trial_started_at, '${NEVER}'))`;

const INSTALL_ID = `i.app_id || '|' || i.shop_id || '|' || i.started_at`;
const INSTALL_DIGEST = `COALESCE(i.ended_at, '')`;
const EVENT_DIGEST = `e.app_id || '|' || e.type || '|' || e.occurred_at`;

interface Sources {
  /** `kind` in `stock_daily_seen`, and the query that produces its rows. */
  kind: string;
  select: string;
}

/**
 * The three sources, each reduced to `(id, digest, since)`.
 *
 * Expressed as SQL rather than as a JavaScript pass because the comparison is
 * over hundreds of thousands of rows on every sync, and pulling them through
 * JavaScript to compare strings is precisely the memory shape this file is
 * written to avoid.
 */
const SOURCES: Sources[] = [
  {
    kind: 'sub',
    select: `SELECT s.charge_id AS id, ${SUBSCRIPTION_DIGEST} AS digest, ${SUBSCRIPTION_SINCE} AS since
             FROM subscriptions s`,
  },
  {
    kind: 'install',
    select: `SELECT ${INSTALL_ID} AS id, ${INSTALL_DIGEST} AS digest, i.started_at AS since
             FROM install_intervals i`,
  },
  {
    kind: 'event',
    select: `SELECT e.event_id AS id, ${EVENT_DIGEST} AS digest, e.occurred_at AS since
             FROM customer_events e
             WHERE e.suppressed = 0
               AND e.type IN (${LIFECYCLE_TYPES.map((type) => `'${type}'`).join(', ')})`,
  },
];

const sourceTable = (kind: string): string => `temp.stock_source_${kind}`;

/**
 * Materialise each source's `(id, digest, since)` into a temp table keyed on id.
 *
 * The keying is the whole point, and it is not a micro-optimisation. Two of the
 * three sources have an identity SQLite cannot look a row up by: an install
 * interval is identified by `app_id || shop_id || started_at`, which is a
 * concatenation, so joining the stored record back to it on that expression
 * cannot use the table's primary key. Left as a subquery, the anti-join
 * degenerates into a rescan of the source per stored row — quadratic, and
 * measured at twenty minutes where the whole build is under a minute. Written
 * into a table with `id` as its primary key, both directions are index lookups.
 *
 * Bounded in memory: these hold one small row per source row and SQLite spills
 * them the same way it spills any temp b-tree. Nothing is pulled into
 * JavaScript.
 */
function loadSources(db: Db): void {
  for (const source of SOURCES) {
    const table = sourceTable(source.kind);
    db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(
      `CREATE TEMP TABLE stock_source_${source.kind} (
         id TEXT PRIMARY KEY, digest TEXT NOT NULL, since TEXT NOT NULL
       ) WITHOUT ROWID`,
    );
    db.prepare(
      `INSERT INTO ${table} (id, digest, since) SELECT id, digest, since FROM (${source.select})`,
    ).run();
  }
}

function dropSources(db: Db): void {
  for (const source of SOURCES) db.exec(`DROP TABLE IF EXISTS ${sourceTable(source.kind)}`);
}

/**
 * The earliest instant at which this sync's facts differ from the last one's,
 * or null when nothing the snapshots read has moved.
 *
 * Both directions matter and both are asked for. A row whose dates changed
 * contributes its *new* earliest instant through the first branch and its *old*
 * one through the second, because a cancellation moved from June to March
 * invalidates March onwards and a cancellation moved from March to June
 * invalidates March onwards too. A row that vanished contributes the instant it
 * used to have; a row that appeared contributes the instant it now has.
 */
function changedSince(db: Db): string | null {
  let earliest: string | null = null;
  for (const source of SOURCES) {
    const table = sourceTable(source.kind);
    const row = db
      .prepare(
        `SELECT MIN(since) AS since FROM (
           SELECT n.since AS since
           FROM ${table} n
           LEFT JOIN stock_daily_seen v ON v.kind = @kind AND v.id = n.id
           WHERE v.id IS NULL OR v.digest <> n.digest
           UNION ALL
           SELECT v.since AS since
           FROM stock_daily_seen v
           LEFT JOIN ${table} n ON n.id = v.id
           WHERE v.kind = @kind AND (n.id IS NULL OR n.digest <> v.digest)
         )`,
      )
      .get({ kind: source.kind }) as { since: string | null };
    if (row.since && row.since !== NEVER && (earliest === null || row.since < earliest)) {
      earliest = row.since;
    }
  }
  return earliest;
}

/** Replace the record of what the builder has seen with what is there now. */
function refreshSeen(db: Db): void {
  db.transaction(() => {
    for (const source of SOURCES) {
      db.prepare('DELETE FROM stock_daily_seen WHERE kind = ?').run(source.kind);
      db.prepare(
        `INSERT INTO stock_daily_seen (kind, id, digest, since)
         SELECT @kind, id, digest, since FROM ${sourceTable(source.kind)}`,
      ).run({ kind: source.kind });
    }
  })();
}

/** `(day, as_of)` for a run of days, as a VALUES list. */
function daysCte(days: string[], timeZone: string, params: Record<string, unknown>): string {
  const rows = days.map((day, index) => {
    params[`sd${index}`] = day;
    params[`sa${index}`] = dayKeyStart(day, timeZone).toISOString();
    return `(@sd${index}, @sa${index})`;
  });
  return `days(day, as_of) AS (VALUES ${rows.join(', ')})`;
}

/**
 * The live-population snapshot, once per gate.
 *
 * `includeAnnual` is deliberately fixed at true here: the annual and non-annual
 * halves are stored side by side and the reader adds the ones its flag asks for,
 * so the builder must see both. `includeTrials` is the flag that cannot be
 * stored that way, which is why it is the loop.
 */
function buildSubscriptionDays(db: Db, days: string[], timeZone: string): void {
  for (const gate of [0, 1]) {
    const params: Record<string, unknown> = { gate };
    const cte = daysCte(days, timeZone, params);
    const predicate = asOfPredicate(
      { appIds: [], includeAnnual: true, includeTrials: gate === 1 },
      'd.as_of',
    );
    Object.assign(params, predicate.params);

    db.prepare(
      `WITH ${cte}
       INSERT INTO subscription_daily
         (day, gate, app_id, monthly_mrr, annual_mrr, monthly_subs, annual_subs,
          subscribers_all, subscribers_monthly)
       SELECT d.day, @gate, s.app_id,
              COALESCE(SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0),
              COALESCE(SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0),
              SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN 1 ELSE 0 END),
              SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN 1 ELSE 0 END),
              COUNT(DISTINCT s.shop_id),
              COUNT(DISTINCT CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.shop_id END)
       FROM days d
       JOIN subscriptions s ON ${predicate.sql}
       GROUP BY d.day, s.app_id`,
    ).run(params);
  }
}

/**
 * Installs and running trials at the same midnights.
 *
 * One statement for two populations because they share the days and the app
 * grouping, and a row with an install count and no trials must not become two
 * rows that a reader has to reconcile.
 */
function buildPopulationDays(db: Db, days: string[], timeZone: string): void {
  const params: Record<string, unknown> = {};
  const cte = daysCte(days, timeZone, params);

  db.prepare(
    `WITH ${cte},
     installs AS (
       SELECT d.day AS day, i.app_id AS app_id,
              COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS n
       FROM days d
       JOIN install_intervals i
         ON i.started_at <= d.as_of
        AND (i.ended_at IS NULL OR i.ended_at > d.as_of)
       GROUP BY d.day, i.app_id
     ),
     trials AS (
       SELECT d.day AS day, s.app_id AS app_id, COUNT(s.charge_id) AS n
       FROM days d
       JOIN subscriptions s
         ON s.is_test = 0
        AND s.trial_started_at IS NOT NULL
        AND s.trial_ends_at IS NOT NULL
        AND s.trial_started_at < d.as_of
        AND s.trial_ends_at >= d.as_of
        AND (s.churn_at IS NULL OR s.churn_at >= d.as_of)
       GROUP BY d.day, s.app_id
     )
     INSERT INTO population_daily (day, app_id, active_installs, on_trial)
     SELECT day, app_id, SUM(installs), SUM(on_trial)
     FROM (
       SELECT day, app_id, n AS installs, 0 AS on_trial FROM installs
       UNION ALL
       SELECT day, app_id, 0 AS installs, n AS on_trial FROM trials
     )
     GROUP BY day, app_id`,
  ).run(params);
}

/**
 * Lifecycle movement per day: a flow, and rolled up the way flows are.
 *
 * The day expression is the money rollup's, offset segments and all, so an
 * event and a transaction on the same evening of a DST changeover are filed
 * under the same date.
 */
function buildEventDays(db: Db, days: string[], timeZone: string): void {
  const lo = dayKeyStart(days[0]!, timeZone);
  const hi = dayKeyStart(addDayKey(days[days.length - 1]!, 1), timeZone);
  const params: Record<string, unknown> = { lo: lo.toISOString(), hi: hi.toISOString() };
  const segments = offsetSegments(lo, hi, timeZone);
  const day = dayExpression('occurred_at', segments, params, 'ev');
  const types = LIFECYCLE_TYPES.map((type, index) => {
    params[`ct${index}`] = type;
    return `@ct${index}`;
  });

  db.prepare(
    `INSERT INTO customer_event_daily (day, app_id, type, event_count)
     SELECT ${day} AS day, app_id, type, COUNT(*)
     FROM customer_events
     WHERE suppressed = 0
       AND type IN (${types.join(', ')})
       AND occurred_at >= @lo
       AND occurred_at < @hi
     GROUP BY day, app_id, type`,
  ).run(params);
}

/** Recompute a run of days across all three tables, in one write transaction. */
function buildDays(db: Db, days: string[], timeZone: string): void {
  if (days.length === 0) return;
  const from = days[0]!;
  const toExclusive = addDayKey(days[days.length - 1]!, 1);

  db.transaction(() => {
    for (const table of ['subscription_daily', 'population_daily', 'customer_event_daily']) {
      db.prepare(`DELETE FROM ${table} WHERE day >= @from AND day < @to`).run({
        from,
        to: toExclusive,
      });
    }
    buildSubscriptionDays(db, days, timeZone);
    buildPopulationDays(db, days, timeZone);
    buildEventDays(db, days, timeZone);
  })();
}

/**
 * The first day worth holding a snapshot for: the earliest instant any source
 * carries.
 *
 * Days before it hold an empty population, and the reader answers those from the
 * raw tables, where they are empty too. Starting earlier would store thousands
 * of rows of nothing.
 */
function earliestDay(db: Db, timeZone: string): string | null {
  const row = db
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(COALESCE(activated_at, conversion_at)) AS at FROM subscriptions
         UNION ALL SELECT MIN(started_at) FROM install_intervals
         UNION ALL SELECT MIN(occurred_at) FROM customer_events WHERE suppressed = 0
       )`,
    )
    .get() as { at: string | null };
  return row.at ? dayKeyOf(new Date(row.at), timeZone) : null;
}

export interface StockRollupResult {
  /** True when every day was rewritten rather than a tail of them. */
  full: boolean;
  /** Days recomputed. */
  days: number;
  first: string;
  last: string;
}

/**
 * Bring the subscription-side snapshots up to date.
 *
 * Full when asked to be, when the reporting timezone has changed underneath
 * them — the day keys mean something else then and cannot be patched into
 * agreement — when there is nothing there to patch, or when the earliest fact in
 * the database has moved backwards, which a forward repair cannot reach.
 *
 * Incremental otherwise, and the increment is a *tail*: from the earliest
 * changed instant, or from the day after the last one built, whichever is
 * earlier, up to today. An ordinary sync changes recent subscriptions and
 * rebuilds a day or two.
 */
export function syncStockDaily(db: Db, options: { full?: boolean } = {}): StockRollupResult {
  const timeZone = getConfig().runtime.timezone;
  const storedTimeZone = readSyncState(db, STOCK_ROLLUP_STATE_KEY).cursor;
  const storedRange = readSyncState(db, STOCK_ROLLUP_RANGE_KEY).cursor;
  const [storedFirst, storedLast] = (storedRange ?? '').split('..');

  const last = dayKeyOf(new Date(), timeZone);
  const first = earliestDay(db, timeZone);

  loadSources(db);

  if (first === null) {
    // Nothing to snapshot. Clear rather than leave a stale table behind, and
    // record no coverage, so every read goes to the raw tables and finds the
    // same emptiness.
    db.transaction(() => {
      db.prepare('DELETE FROM subscription_daily').run();
      db.prepare('DELETE FROM population_daily').run();
      db.prepare('DELETE FROM customer_event_daily').run();
      db.prepare('DELETE FROM stock_daily_dirty').run();
      db.prepare('DELETE FROM stock_daily_seen').run();
    })();
    writeSyncState(db, STOCK_ROLLUP_STATE_KEY, { cursor: timeZone, syncedThrough: null });
    writeSyncState(db, STOCK_ROLLUP_RANGE_KEY, { cursor: '', syncedThrough: null });
    dropSources(db);
    return { full: true, days: 0, first: '', last: '' };
  }

  const full =
    Boolean(options.full) ||
    storedTimeZone !== timeZone ||
    !storedFirst ||
    !storedLast ||
    first < storedFirst;

  // Only when a floor is going to be used: on a full rebuild the comparison
  // would be a pass over every source row to decide something already decided.
  const floorRow = full
    ? { day: null }
    : (db.prepare('SELECT MIN(day) AS day FROM stock_daily_dirty').get() as { day: string | null });
  const changed = full ? null : changedSince(db);
  // Widened by a day. `changedSince` resolves an instant through `dayKeyOf` and
  // needs no slack, but an external mark left by `markStockFloor` may be a UTC
  // date, which overlaps two local ones. Recomputing a day that did not change
  // costs milliseconds; missing one is a wrong figure that nothing surfaces.
  const marks = [floorRow.day, changed ? dayKeyOf(new Date(changed), timeZone) : null]
    .filter((day): day is string => day !== null)
    .map((day) => addDayKey(day, -1));

  let from: string;
  if (full) {
    from = first;
  } else {
    // The day after the last one built is always due, so that a sync which
    // changes nothing still extends the snapshots to today.
    from = addDayKey(storedLast!, 1);
    for (const mark of marks) if (mark < from) from = mark;
    if (from < first) from = first;
  }

  const days: string[] = [];
  for (let day = from; day <= last; day = addDayKey(day, 1)) days.push(day);

  if (full) {
    db.transaction(() => {
      db.prepare('DELETE FROM subscription_daily').run();
      db.prepare('DELETE FROM population_daily').run();
      db.prepare('DELETE FROM customer_event_daily').run();
    })();
  }

  for (let at = 0; at < days.length; at += CHUNK_DAYS) {
    buildDays(db, days.slice(at, at + CHUNK_DAYS), timeZone);
  }

  refreshSeen(db);
  dropSources(db);

  // Only once the rows are in. A crash before this leaves the marks in place and
  // the stored range stale, and the next sync redoes the work — the failure mode
  // of these tables is always "rebuild them", never "trust them".
  db.prepare('DELETE FROM stock_daily_dirty').run();
  writeSyncState(db, STOCK_ROLLUP_STATE_KEY, {
    cursor: timeZone,
    syncedThrough: new Date().toISOString(),
  });
  writeSyncState(db, STOCK_ROLLUP_RANGE_KEY, {
    cursor: `${first}..${last}`,
    syncedThrough: null,
  });

  return { full, days: days.length, first, last };
}

/**
 * Record that facts on or after `day` have changed, so the next sync repairs the
 * snapshots from there forward.
 *
 * The comparison in `changedSince` finds this on its own for the three sources
 * it watches; this is the door for anything that knows it has invalidated
 * history and would rather say so than be discovered.
 */
export function markStockFloor(db: Db, days: Iterable<string>): void {
  const statement = db.prepare('INSERT OR IGNORE INTO stock_daily_dirty (day) VALUES (?)');
  for (const day of days) statement.run(day);
}

import type { Db } from '../db/index.js';
import {
  appFilter,
  asOfPredicate,
  COUNT_SUBSCRIBERS,
  gateColumn,
  type AsOfOptions,
  type Fragment,
} from './predicate.js';
import {
  appIdFilter,
  rollupReady,
  splitBuckets,
  splitCte,
  toHalfOpen,
  type BucketSplit,
} from './rollup.js';
import {
  appIdIn,
  rawInstantCte,
  snapshotCte,
  splitInstants,
  stockCoverage,
} from './stockRollup.js';
import { addDayKey, dayKeyOf, type Bucket } from './time.js';

/**
 * The as-of reconstruction engine (spec 2).
 *
 * Every stock figure answers "which subscriptions were live at instant D", using
 * the single predicate defined in `asOfPredicate`. It used to answer that by
 * scanning the raw tables once per bucket, which meant a twelve-point series
 * crossed `subscriptions`, `install_intervals` or `customer_events` twelve
 * times. It now answers it from a daily snapshot wherever the instant asked
 * about is one the snapshot holds — a local midnight, which is what every bucket
 * boundary except the last one is — and falls back to the raw scan for the rest.
 * `metrics/stockRollup.ts` is that rule; the raw halves below are unchanged.
 *
 * Because the snapshot is rebuilt rather than adjusted, a backdated cancellation
 * still corrects every past point automatically; it just does so in the sync
 * worker instead of on the request thread.
 *
 * Everything below binds values as named parameters. SQLite forbids mixing
 * named and positional binds, so the whole module uses `@name` consistently.
 */

export { asOfPredicate };
export type { AsOfOptions, Fragment };

const MS_PER_DAY = 86_400_000;

/**
 * Assemble the snapshot half and the raw half of one series into a single
 * statement.
 *
 * The two halves cover disjoint sets of buckets — an instant is a midnight the
 * snapshot holds or it is not — so no bucket is counted twice and none is
 * missed, and the union needs no re-aggregation on top. Either half may be
 * empty; a query with no buckets on one side simply does not contain it, which
 * is also why neither half needs a sentinel row.
 */
function unionParts(parts: string[], ctes: string[]): string {
  const body = parts.join('\nUNION ALL\n');
  return `${ctes.length > 0 ? `WITH ${ctes.join(', ')}\n` : ''}SELECT * FROM (\n${body}\n) ORDER BY idx`;
}

/** The as-of instants of a bucket list, indexed the way the reports expect. */
function instantsOf(buckets: Bucket[], pick: (bucket: Bucket) => Date): Array<{
  idx: number;
  asOf: Date;
}> {
  return buckets.map((bucket, idx) => ({ idx, asOf: pick(bucket) }));
}

/**
 * Builds a `buckets` CTE plus its bound parameters. Every per-bucket query
 * joins against this rather than issuing one query per point, which keeps even
 * a two-year daily series to a single round trip.
 *
 * Columns: `as_of` is the instant stock metrics are read at (the bucket's
 * exclusive end), `bucket_from` its inclusive start for flow metrics, and
 * `trailing_30` the start of a 30-day window ending at `as_of`.
 */
export function bucketsCte(buckets: Bucket[]): Fragment {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`bi${idx}`] = idx;
    params[`ba${idx}`] = bucket.end.toISOString();
    params[`bt${idx}`] = new Date(bucket.end.getTime() - 30 * MS_PER_DAY).toISOString();
    params[`bf${idx}`] = bucket.start.toISOString();
    return `(@bi${idx}, @ba${idx}, @bt${idx}, @bf${idx})`;
  });
  return {
    sql: `buckets(idx, as_of, trailing_30, bucket_from) AS (VALUES ${rows.join(', ')})`,
    params,
  };
}

export interface StockPoint {
  idx: number;
  asOf: string;
  monthlyMrr: number;
  annualMrr: number;
  subscriptions: number;
  subscribers: number;
}

/**
 * One aggregation per bucket over the as-of-live set. Returns the recurring
 * components; usage and trial add-ons are composed on top by the MRR report.
 *
 * The buckets whose as-of instant is a stored midnight read four sums out of
 * `subscription_daily`; the rest keep the join against the raw table. How the
 * two as-of flags are served is the whole of the table's design:
 *
 *  - **`includeTrials` picks the row.** It swaps the predicate's gate, so it
 *    selects a different population rather than a subset of one, and the
 *    snapshot stores a row per gate. Nothing here adds the two together.
 *  - **`includeAnnual` picks the columns.** It is a filter on a row attribute,
 *    so the annual and non-annual halves are stored apart and only the wanted
 *    ones are summed — except for the subscriber count, which is a distinct
 *    count and does not survive being added across the split, and is therefore
 *    stored once per answer.
 */
export function stockSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  timeZone: string,
): StockPoint[] {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'sbuckets', 'sb');
    const apps = appIdIn(options.appIds, 'r.app_id', 'sbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params, { sbGate: options.includeTrials ? 1 : 0 });
    parts.push(
      `SELECT b.idx AS idx,
              b.as_of AS asOf,
              COALESCE(SUM(r.monthly_mrr), 0) AS monthlyMrr,
              COALESCE(SUM(${options.includeAnnual ? 'r.annual_mrr' : '0'}), 0) AS annualMrr,
              COALESCE(SUM(r.monthly_subs${options.includeAnnual ? ' + r.annual_subs' : ''}), 0) AS subscriptions,
              COALESCE(SUM(${options.includeAnnual ? 'r.subscribers_all' : 'r.subscribers_monthly'}), 0) AS subscribers
       FROM sbuckets b
       LEFT JOIN subscription_daily r
         ON r.day = b.day AND r.gate = @sbGate
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx, b.as_of`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rbuckets', 'rb');
    const predicate = asOfPredicate(options, 'b.as_of');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, predicate.params);
    parts.push(
      `SELECT b.idx AS idx,
              b.as_of AS asOf,
              COALESCE(SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS monthlyMrr,
              COALESCE(SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS annualMrr,
              COUNT(s.charge_id) AS subscriptions,
              ${COUNT_SUBSCRIBERS} AS subscribers
       FROM rbuckets b
       LEFT JOIN subscriptions s
         ON ${predicate.sql}
       GROUP BY b.idx, b.as_of`,
    );
  }

  if (parts.length === 0) return [];
  return db.prepare(unionParts(parts, ctes)).all(params) as StockPoint[];
}

export interface AppStockPoint {
  idx: number;
  appId: string;
  appName: string | null;
  mrr: number;
}

/**
 * The same as-of reconstruction as `stockSeries`, split by the app that earns
 * the revenue. One extra GROUP BY column rather than a query per app, so the
 * per-app figures are guaranteed to sum to the total.
 */
export function stockSeriesByApp(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  timeZone: string,
): AppStockPoint[] {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'abuckets', 'ab');
    const apps = appIdIn(options.appIds, 'r.app_id', 'abapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params, { abGate: options.includeTrials ? 1 : 0 });
    // The raw form is an inner join, so an app with nothing live produces no
    // row at all. With `includeAnnual` off, an app holding only annual charges
    // is exactly that case even though the snapshot has a row for it, which is
    // what the `monthly_subs > 0` test reproduces.
    parts.push(
      `SELECT b.idx AS idx,
              r.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(r.monthly_mrr${options.includeAnnual ? ' + r.annual_mrr' : ''}), 0) AS mrr
       FROM abuckets b
       JOIN subscription_daily r
         ON r.day = b.day AND r.gate = @abGate
        ${options.includeAnnual ? '' : 'AND r.monthly_subs > 0'}
        ${apps.sql ? `AND ${apps.sql}` : ''}
       LEFT JOIN apps a ON a.id = r.app_id
       GROUP BY b.idx, r.app_id, a.name`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rabuckets', 'ra');
    const predicate = asOfPredicate(options, 'b.as_of');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, predicate.params);
    parts.push(
      `SELECT b.idx AS idx,
              s.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(s.monthly_amount), 0) AS mrr
       FROM rabuckets b
       JOIN subscriptions s
         ON ${predicate.sql}
       LEFT JOIN apps a ON a.id = s.app_id
       GROUP BY b.idx, s.app_id, a.name`,
    );
  }

  if (parts.length === 0) return [];
  return db.prepare(unionParts(parts, ctes)).all(params) as AppStockPoint[];
}

/**
 * Subscriptions that started paying inside each bucket (spec 4.6). A flow, and
 * gated on the same instant the stock metrics use, so a new subscription and the
 * MRR it brings appear in the same bucket.
 *
 * Plan changes are excluded for the same reason churn excludes them: Shopify
 * models an upgrade as a new charge, and counting those would report every
 * existing customer moving up a tier as a new one.
 *
 * Note which side of the pair carries the flag. `is_plan_change` marks the
 * charge that *ended*, because that is the one churn must not count. The
 * replacement carries nothing, so the exclusion here has to find it the same way
 * the derive step paired them: a sibling of this shop-and-app whose cancellation
 * sits within the plan-change window of this charge's activation.
 */
export function newSubscriptionSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  byShop: boolean,
  planChangeWindowDays: number,
): Map<number, number> {
  const cte = bucketsCte(buckets);
  const apps = appFilter(options.appIds, 's.app_id', 'napp');
  const gate = options.includeTrials ? 's.activated_at' : 's.conversion_at';
  const countExpr = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, ${countExpr} AS value
       FROM buckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        ${apps.sql ? `AND ${apps.sql}` : ''}
        ${options.includeAnnual ? '' : `AND s.billing_interval <> 'ANNUAL'`}
        AND ${gate} IS NOT NULL
        AND ${gate} >= b.bucket_from
        AND ${gate} < b.as_of
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions prior
          WHERE prior.app_id = s.app_id
            AND prior.shop_id = s.shop_id
            AND prior.charge_id <> s.charge_id
            AND prior.is_plan_change = 1
            AND prior.churn_at IS NOT NULL
            AND s.activated_at IS NOT NULL
            AND ABS(julianday(prior.churn_at) - julianday(s.activated_at)) <= @planChangeDays
        )
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params, planChangeDays: planChangeWindowDays }) as Array<{
    idx: number;
    value: number;
  }>;

  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * Subscriptions inside their free period as-of each bucket (spec 4.11).
 *
 * A trial is live at D when it had started by D and had neither ended nor been
 * cancelled by then. Trials whose outcome was never recorded — activated, never
 * billed, never cancelled, no billing date — have no end instant to test, so
 * they are excluded rather than counted as trialling forever.
 */
export function onTrialSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  timeZone: string,
): Map<number, number> {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'tbuckets', 'tb');
    const apps = appIdIn(appIds, 'p.app_id', 'tbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.on_trial), 0) AS value
       FROM tbuckets b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'rtbuckets', 'rt');
    const apps = appFilter(appIds, 's.app_id', 'otapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COUNT(s.charge_id) AS value
       FROM rtbuckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        ${apps.sql ? `AND ${apps.sql}` : ''}
        AND s.trial_started_at IS NOT NULL
        AND s.trial_ends_at IS NOT NULL
        AND s.trial_started_at < b.as_of
        AND s.trial_ends_at >= b.as_of
        AND (s.churn_at IS NULL OR s.churn_at >= b.as_of)
       GROUP BY b.idx`,
    );
  }

  if (parts.length === 0) return new Map();
  const rows = db.prepare(unionParts(parts, ctes)).all(params) as Array<{
    idx: number;
    value: number;
  }>;
  return new Map(rows.map((row) => [row.idx, row.value]));
}

const USAGE_TYPE = 'AppUsageSale';

/**
 * Metered usage revenue attributed to each bucket as a trailing-30-day rate, so
 * it is comparable with a monthly subscription figure. Usage is billed in
 * arrears and lumpy; reading it at a single instant would be meaningless.
 *
 * Twelve trailing-30-day windows over the raw ledger is twelve overlapping
 * range scans of the largest table in the database, which is why MRR was the
 * second most expensive metric on the dashboard despite the subscription half of
 * it being a cheap read of a small table. The windows are served out of the
 * daily rollup instead, with only their sub-day ends coming from the raw rows —
 * twenty-nine or thirty of each window's thirty days are whole.
 *
 * The window is `(trailing_30, as_of]` rather than `[from, to)` like every other
 * window here, and that asymmetry is preserved exactly: `toHalfOpen` shifts both
 * ends by a millisecond, which selects the identical set of rows over
 * millisecond-precision timestamps. See its comment.
 */
export function usageSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  timeZone: string,
): Map<number, number> {
  const ready = rollupReady(db);
  const split = splitBuckets(
    buckets.map((bucket, idx) => ({
      idx,
      ...toHalfOpen(new Date(bucket.end.getTime() - 30 * MS_PER_DAY), bucket.end),
    })),
    timeZone,
    ready,
  );
  const cte = splitCte(split);
  const rollupApps = appIdFilter(appIds, 'r.app_id', 'urapp');
  const rawApps = appIdFilter(appIds, 't.app_id', 'uapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT idx, COALESCE(SUM(value), 0) AS value
       FROM (
         SELECT b.idx AS idx, r.gross_amount AS value
         FROM rdays b
         JOIN transaction_daily r
           ON r.day >= b.day_from AND r.day < b.day_to
          AND r.type = @usageType
          ${rollupApps.sql ? `AND ${rollupApps.sql}` : ''}
         UNION ALL
         SELECT e.idx AS idx, t.gross_amount AS value
         FROM redges e
         JOIN transactions t
           ON t.created_at >= e.lo AND t.created_at < e.hi
          AND t.type = @usageType
          ${rawApps.sql ? `AND ${rawApps.sql}` : ''}
       )
       GROUP BY idx
       ORDER BY idx`,
    )
    .all({
      ...cte.params,
      ...rollupApps.params,
      ...rawApps.params,
      usageType: USAGE_TYPE,
    }) as Array<{ idx: number; value: number }>;

  return new Map(rows.map((row) => [row.idx, row.value]));
}

/**
 * Active installs as-of each bucket (spec 4.5). An install is live when some
 * half-open interval covers the instant, which is why sync collapses the
 * install/uninstall/reinstall stream into intervals up front.
 */
export function activeInstallSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  timeZone: string,
): Map<number, number> {
  const split = splitInstants(
    instantsOf(buckets, (bucket) => bucket.end),
    timeZone,
    stockCoverage(db),
  );
  const ctes: string[] = [];
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'ibuckets', 'ib');
    const apps = appIdIn(appIds, 'p.app_id', 'ibapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    // A distinct count of shop-and-app pairs is additive across apps, which is
    // why one stored count per app answers every app scope.
    parts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.active_installs), 0) AS value
       FROM ibuckets b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'ribuckets', 'ri');
    const apps = appFilter(appIds, 'i.app_id', 'iapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    parts.push(
      `SELECT b.idx AS idx, COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS value
       FROM ribuckets b
       LEFT JOIN install_intervals i
         ON i.started_at <= b.as_of
        AND (i.ended_at IS NULL OR i.ended_at > b.as_of)
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (parts.length === 0) return new Map();
  const rows = db.prepare(unionParts(parts, ctes)).all(params) as Array<{
    idx: number;
    value: number;
  }>;
  return new Map(rows.map((row) => [row.idx, row.value]));
}

/** Recurring MRR at a single instant, used for churn denominators and LTV. */
export function mrrAt(db: Db, asOf: Date, options: AsOfOptions): number {
  const predicate = asOfPredicate(options, '@asOf');
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(s.monthly_amount), 0) AS value
       FROM subscriptions s
       WHERE ${predicate.sql}`,
    )
    .get({ ...predicate.params, asOf: asOf.toISOString() }) as { value: number };
  return row.value;
}

/** Active population at a single instant, by subscriber or by subscription. */
export function populationAt(db: Db, asOf: Date, options: AsOfOptions, byShop: boolean): number {
  const predicate = asOfPredicate(options, '@asOf');
  const expression = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  const row = db
    .prepare(
      `SELECT ${expression} AS value
       FROM subscriptions s
       WHERE ${predicate.sql}`,
    )
    .get({ ...predicate.params, asOf: asOf.toISOString() }) as { value: number };
  return row.value;
}

export interface ChurnPoint {
  idx: number;
  /** Population alive at the start of the rolling window. */
  population: number;
  /** MRR alive at the start of the rolling window. */
  baseMrr: number;
  churned: number;
  lostMrr: number;
}

/**
 * Rolling-window churn (spec 4.7).
 *
 * The denominator is the start-of-window base, never the end-of-window one, or
 * churn is understated exactly when a business is shrinking. Only subscriptions
 * that were already live at the window start can count as churned inside it.
 *
 * Plan changes are excluded: Shopify models an upgrade as cancel-old plus
 * create-new, so counting raw cancels would report every upgrade as a lost
 * customer.
 */
export function churnSeries(
  db: Db,
  buckets: Bucket[],
  options: AsOfOptions,
  windowDays: number,
  byShop: boolean,
  timeZone: string,
): ChurnPoint[] {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`ci${idx}`] = idx;
    params[`ca${idx}`] = bucket.end.toISOString();
    params[`cw${idx}`] = new Date(bucket.end.getTime() - windowDays * MS_PER_DAY).toISOString();
    return `(@ci${idx}, @ca${idx}, @cw${idx})`;
  });

  const apps = appFilter(options.appIds, 's.app_id', 'app');
  const countExpr = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  const gate = gateColumn(options.includeTrials);

  /*
   * Only the denominator can come out of the snapshot, and it is the half that
   * costs. The base is a stock — the population alive when the window opened —
   * so it is a lookup whenever that instant is a stored midnight, which a
   * bucket end minus a whole number of days usually is.
   *
   * The numerator stays on the raw table, and deliberately. What was lost inside
   * a window is not a daily flow: the rule excludes anything that both started
   * and ended inside the window (`gate < window_start`), so a day's contribution
   * depends on where the window opened, not only on the day. Rolling it up would
   * need a table keyed on both dates — quadratic in days — to answer a query
   * that is already an indexed range seek on `churn_at` over the smallest of the
   * three tables. See the note in `docs/architecture.md` §2.5.
   */
  const baseCtes: string[] = [];
  const baseParts: string[] = [];
  const split = splitInstants(
    buckets.map((bucket, idx) => ({
      idx,
      asOf: new Date(bucket.end.getTime() - windowDays * MS_PER_DAY),
    })),
    timeZone,
    stockCoverage(db),
  );

  if (split.snapshots.length > 0) {
    const cte = snapshotCte(split.snapshots, 'cbase', 'cb');
    const snapshotApps = appIdIn(options.appIds, 'r.app_id', 'cbapp');
    baseCtes.push(cte.sql);
    Object.assign(params, cte.params, snapshotApps.params, {
      cbGate: options.includeTrials ? 1 : 0,
    });
    const population = byShop
      ? options.includeAnnual
        ? 'r.subscribers_all'
        : 'r.subscribers_monthly'
      : options.includeAnnual
        ? 'r.monthly_subs + r.annual_subs'
        : 'r.monthly_subs';
    baseParts.push(
      `SELECT b.idx AS idx,
              COALESCE(SUM(${population}), 0) AS population,
              COALESCE(SUM(r.monthly_mrr${options.includeAnnual ? ' + r.annual_mrr' : ''}), 0) AS baseMrr
       FROM cbase b
       LEFT JOIN subscription_daily r
         ON r.day = b.day AND r.gate = @cbGate
        ${snapshotApps.sql ? `AND ${snapshotApps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (split.raw.length > 0) {
    const cte = rawInstantCte(split.raw, 'crbase', 'cr');
    const predicate = asOfPredicate(options, 'b.as_of');
    baseCtes.push(cte.sql);
    Object.assign(params, cte.params, predicate.params);
    baseParts.push(
      `SELECT b.idx AS idx,
              ${countExpr} AS population,
              COALESCE(SUM(s.monthly_amount), 0) AS baseMrr
       FROM crbase b
       LEFT JOIN subscriptions s ON ${predicate.sql}
       GROUP BY b.idx`,
    );
  }

  return db
    .prepare(
      `WITH cbuckets(idx, as_of, window_start) AS (VALUES ${rows.join(', ')}),
       ${baseCtes.length > 0 ? `${baseCtes.join(', ')},` : ''}
       base AS (
         ${baseParts.join('\n         UNION ALL\n         ')}
       ),
       lost AS (
         SELECT b.idx AS idx,
                ${countExpr} AS churned,
                COALESCE(SUM(s.monthly_amount), 0) AS lostMrr
         FROM cbuckets b
         LEFT JOIN subscriptions s
           ON s.is_test = 0
          ${apps.sql ? `AND ${apps.sql}` : ''}
          AND s.is_plan_change = 0
          AND s.churn_at IS NOT NULL
          AND s.churn_at >= b.window_start
          AND s.churn_at < b.as_of
          AND ${gate} IS NOT NULL
          AND ${gate} < b.window_start
         GROUP BY b.idx
       )
       SELECT base.idx AS idx,
              base.population AS population,
              base.baseMrr AS baseMrr,
              lost.churned AS churned,
              lost.lostMrr AS lostMrr
       FROM base
       JOIN lost ON lost.idx = base.idx
       ORDER BY base.idx`,
    )
    .all({ ...params, ...apps.params }) as ChurnPoint[];
}

/** Monthly churn rate as a fraction, guarded against an empty base. */
export function churnRate(point: ChurnPoint | undefined): number {
  if (!point || point.population <= 0) return 0;
  return point.churned / point.population;
}

export interface InstallChurnPoint {
  idx: number;
  /** Active installs at the instant the rolling window opened. */
  population: number;
  /** Uninstall and deactivation events inside the window. */
  uninstalled: number;
  /** Reinstall and reactivation events inside the window. */
  reinstalled: number;
}

/**
 * Rolling-window logo churn (spec 4.7): `(uninstalls − reinstalls) ÷ active
 * installs at the window start`.
 *
 * It reads the install ledger, not the subscription index, and that is the
 * whole reason it is a separate metric. A free install that never paid is a
 * logo; a shop that cancels but keeps the app installed has not churned as one.
 * Counting logos off `subscriptions` makes this metric a copy of subscription
 * churn — identical SQL over identical rows — which is exactly what it was.
 *
 * Deactivation counts as an uninstall and reactivation as a return, per spec
 * 4.5 ("deactivation == uninstall unless reactivated") and the net-install
 * formula in 4.6. Movement is counted in events, so a shop that uninstalls
 * twice inside one window counts twice, matching how growth reads the same
 * ledger.
 */
export function installChurnSeries(
  db: Db,
  buckets: Bucket[],
  appIds: string[],
  windowDays: number,
  timeZone: string,
): InstallChurnPoint[] {
  const coverage = stockCoverage(db);
  const params: Record<string, unknown> = {};
  const ctes: string[] = [];

  /*
   * Logo churn is the one metric that needs both shapes of rollup at once, and
   * it is the clearest illustration of why there are two.
   *
   * Its denominator is a *stock* — installs live at the instant the window
   * opened — and comes from `population_daily` by the midnight rule. Its
   * numerator is a *flow* — uninstalls and reinstalls inside the window — and
   * comes from `customer_event_daily` the way the money rollup serves a window:
   * whole days from the rollup, sub-day remainders from the raw table. The event
   * ledger is the largest table in the database, and crossing it once per bucket
   * with a thirty-day window was the most expensive read left on this side.
   */
  const baseParts: string[] = [];
  const baseSplit = splitInstants(
    buckets.map((bucket, idx) => ({
      idx,
      asOf: new Date(bucket.end.getTime() - windowDays * MS_PER_DAY),
    })),
    timeZone,
    coverage,
  );

  if (baseSplit.snapshots.length > 0) {
    const cte = snapshotCte(baseSplit.snapshots, 'lbase', 'lb');
    const apps = appIdIn(appIds, 'p.app_id', 'lbsapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    baseParts.push(
      `SELECT b.idx AS idx, COALESCE(SUM(p.active_installs), 0) AS population
       FROM lbase b
       LEFT JOIN population_daily p
         ON p.day = b.day
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  if (baseSplit.raw.length > 0) {
    const cte = rawInstantCte(baseSplit.raw, 'lrbase', 'lr');
    const apps = appFilter(appIds, 'i.app_id', 'lbapp');
    ctes.push(cte.sql);
    Object.assign(params, cte.params, apps.params);
    baseParts.push(
      `SELECT b.idx AS idx,
              COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS population
       FROM lrbase b
       LEFT JOIN install_intervals i
         ON i.started_at <= b.as_of
        AND (i.ended_at IS NULL OR i.ended_at > b.as_of)
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx`,
    );
  }

  /*
   * The flow half. `splitBuckets` is asked one window at a time so that a window
   * reaching outside the days the rollup has built — the opening buckets of an
   * `all_time` series can start before the first event there is — degenerates to
   * a raw range for that window alone rather than for the whole series.
   */
  const movementSplit: BucketSplit = { days: [], edges: [] };
  buckets.forEach((bucket, idx) => {
    const range = {
      idx,
      from: new Date(bucket.end.getTime() - windowDays * MS_PER_DAY),
      to: bucket.end,
    };
    const usable =
      coverage.ready &&
      dayKeyOf(range.from, timeZone) >= coverage.first &&
      dayKeyOf(range.to, timeZone) <= addDayKey(coverage.last, 1);
    const one = splitBuckets([range], timeZone, usable);
    movementSplit.days.push(...one.days);
    movementSplit.edges.push(...one.edges);
  });

  const movementCte = splitCte(movementSplit);
  const rollupApps = appIdFilter(appIds, 'r.app_id', 'lmrapp');
  const rawEventApps = appFilter(appIds, 'e.app_id', 'leapp');
  ctes.push(movementCte.sql);
  Object.assign(params, movementCte.params, rollupApps.params, rawEventApps.params);

  const idxRows = buckets.map((_, idx) => {
    params[`lx${idx}`] = idx;
    return `(@lx${idx})`;
  });

  const UNINSTALL = `('uninstalled', 'deactivated')`;
  const REINSTALL = `('reinstalled', 'reactivated')`;

  /*
   * Both halves of the flow are LEFT JOINs, and that is load-bearing rather
   * than stylistic. An inner join lets SQLite pick either side as the outer
   * loop, and with an app filter on `customer_events` it picks the event
   * ledger: one walk of every event for every app, probing the fourteen-row
   * bucket list for each. Measured at seventeen seconds against a quarter of
   * one. A LEFT JOIN fixes the bucket list as the outer table, which is the
   * order the query was written for and the one the raw form already had.
   *
   * The extra unmatched rows a LEFT JOIN produces carry NULL in `r.type` and
   * `e.type`, which both CASE expressions score as zero, so they add nothing.
   */

  const SQL = `WITH ${ctes.join(', ')},
       lidx(idx) AS (VALUES ${idxRows.join(', ')}),
       base AS (
         ${baseParts.join('\n         UNION ALL\n         ')}
       ),
       movement AS (
         SELECT idx,
                COALESCE(SUM(gone), 0) AS uninstalled,
                COALESCE(SUM(back), 0) AS reinstalled
         FROM (
           SELECT b.idx AS idx,
                  CASE WHEN r.type IN ${UNINSTALL} THEN r.event_count ELSE 0 END AS gone,
                  CASE WHEN r.type IN ${REINSTALL} THEN r.event_count ELSE 0 END AS back
           FROM rdays b
           LEFT JOIN customer_event_daily r
             ON r.day >= b.day_from AND r.day < b.day_to
            ${rollupApps.sql ? `AND ${rollupApps.sql}` : ''}
           UNION ALL
           SELECT e2.idx AS idx,
                  CASE WHEN e.type IN ${UNINSTALL} THEN 1 ELSE 0 END AS gone,
                  CASE WHEN e.type IN ${REINSTALL} THEN 1 ELSE 0 END AS back
           FROM redges e2
           LEFT JOIN customer_events e
             ON e.suppressed = 0
            AND e.type IN ('uninstalled', 'deactivated', 'reinstalled', 'reactivated')
            AND e.occurred_at >= e2.lo
            AND e.occurred_at < e2.hi
            ${rawEventApps.sql ? `AND ${rawEventApps.sql}` : ''}
         )
         GROUP BY idx
       )
       SELECT lidx.idx AS idx,
              COALESCE(base.population, 0) AS population,
              COALESCE(movement.uninstalled, 0) AS uninstalled,
              COALESCE(movement.reinstalled, 0) AS reinstalled
       FROM lidx
       LEFT JOIN base ON base.idx = lidx.idx
       LEFT JOIN movement ON movement.idx = lidx.idx
       ORDER BY lidx.idx`;
  return db.prepare(SQL).all(params) as InstallChurnPoint[];
}

/**
 * Net logo churn as a fraction. Negative when reinstalls outrun uninstalls,
 * the same way net revenue churn goes negative when expansion outruns
 * contraction. Zero base means zero rate (spec 4.7).
 */
export function installChurnRate(point: InstallChurnPoint | undefined): number {
  if (!point || point.population <= 0) return 0;
  return (point.uninstalled - point.reinstalled) / point.population;
}

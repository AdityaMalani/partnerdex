import type { Db } from '../db/index.js';
import { appIdFilter, rollupReady, splitBuckets, splitCte, toHalfOpen } from './rollup.js';
import type { Bucket } from './time.js';

/**
 * The as-of reconstruction engine (spec 2).
 *
 * There are no snapshot tables. Every stock figure is rebuilt per bucket by
 * asking "which subscriptions were live at instant D", using the single
 * predicate defined in `asOfPredicate`. Because history is recomputed on every
 * read, a backdated cancellation corrects every past point automatically.
 *
 * Everything below binds values as named parameters. SQLite forbids mixing
 * named and positional binds, so the whole module uses `@name` consistently.
 */

export interface AsOfOptions {
  /** Empty means every app currently in reporting scope. */
  appIds: string[];
  /** Fold annual plans in at 1/12 of their annual price. */
  includeAnnual: boolean;
  /** Gate on activation rather than first payment, so trials count. */
  includeTrials: boolean;
}

export interface Fragment {
  sql: string;
  params: Record<string, unknown>;
}

const MS_PER_DAY = 86_400_000;

/**
 * A subscriber is a shop's relationship with one app, not the shop itself. A
 * merchant running two of your apps is two subscribers, which is how each app's
 * own numbers count them — and it means dropping one app registers as churn
 * rather than hiding behind the other.
 */
const SUBSCRIBER_KEY = "s.app_id || ' ' || s.shop_id";
const COUNT_SUBSCRIBERS = `COUNT(DISTINCT ${SUBSCRIBER_KEY})`;

function appFilter(appIds: string[], column: string, prefix: string): Fragment {
  if (appIds.length === 0) return { sql: '', params: {} };
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    const name = `${prefix}${index}`;
    params[name] = id;
    return `@${name}`;
  });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

/**
 * "Subscription s is live as of <asOfExpr>". The instant is passed as an
 * expression so the identical predicate serves both a scalar lookup
 * (`@asOf`) and a per-bucket join (`b.as_of`).
 *
 * `asOfExpr` is a bucket's *exclusive* end, so the comparisons are half-open:
 * an event landing exactly on the boundary belongs to the next bucket, matching
 * how the flow metrics slice the same instant. Using `<=` on the gate instead
 * would credit a subscription that started at midnight on the 1st to the month
 * that just ended.
 *
 * Missing fields are meaningful (spec 2.2): a NULL churn_at means "never
 * churned", not "unknown". Testing `churn_at = NULL` instead would silently
 * empty out all of history.
 */
export function asOfPredicate(options: AsOfOptions, asOfExpr: string): Fragment {
  const clauses: string[] = ['s.is_test = 0'];
  const apps = appFilter(options.appIds, 's.app_id', 'app');
  if (apps.sql) clauses.push(apps.sql);

  // The MRR gate is the first real payment. Including trials moves the gate
  // back to activation, so a subscription still in its free period counts at
  // the price it will eventually pay.
  const gate = options.includeTrials ? 's.activated_at' : 's.conversion_at';
  clauses.push(`${gate} IS NOT NULL`);
  clauses.push(`${gate} < ${asOfExpr}`);
  clauses.push(`(s.churn_at IS NULL OR s.churn_at >= ${asOfExpr})`);

  // A frozen subscription is still installed but bills nothing. Frozen wins
  // unless an unfreeze has already landed by the as-of instant.
  clauses.push(
    `NOT (s.frozen_at IS NOT NULL AND s.frozen_at < ${asOfExpr}
          AND (s.unfrozen_at IS NULL OR s.unfrozen_at <= s.frozen_at OR s.unfrozen_at >= ${asOfExpr}))`,
  );

  if (!options.includeAnnual) clauses.push(`s.billing_interval <> 'ANNUAL'`);

  return { sql: clauses.join('\n           AND '), params: apps.params };
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
 * One aggregation per bucket over the as-of-live set, expressed as a single
 * join so SQLite does the fan-out. Returns the recurring components; usage and
 * trial add-ons are composed on top by the MRR report.
 */
export function stockSeries(db: Db, buckets: Bucket[], options: AsOfOptions): StockPoint[] {
  const cte = bucketsCte(buckets);
  const predicate = asOfPredicate(options, 'b.as_of');

  return db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              b.as_of AS asOf,
              COALESCE(SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS monthlyMrr,
              COALESCE(SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS annualMrr,
              COUNT(s.charge_id) AS subscriptions,
              ${COUNT_SUBSCRIBERS} AS subscribers
       FROM buckets b
       LEFT JOIN subscriptions s
         ON ${predicate.sql}
       GROUP BY b.idx, b.as_of
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...predicate.params }) as StockPoint[];
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
export function stockSeriesByApp(db: Db, buckets: Bucket[], options: AsOfOptions): AppStockPoint[] {
  const cte = bucketsCte(buckets);
  const predicate = asOfPredicate(options, 'b.as_of');

  return db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              s.app_id AS appId,
              a.name AS appName,
              COALESCE(SUM(s.monthly_amount), 0) AS mrr
       FROM buckets b
       JOIN subscriptions s
         ON ${predicate.sql}
       LEFT JOIN apps a ON a.id = s.app_id
       GROUP BY b.idx, s.app_id, a.name
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...predicate.params }) as AppStockPoint[];
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
): Map<number, number> {
  const cte = bucketsCte(buckets);
  const apps = appFilter(appIds, 's.app_id', 'otapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, COUNT(s.charge_id) AS value
       FROM buckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        ${apps.sql ? `AND ${apps.sql}` : ''}
        AND s.trial_started_at IS NOT NULL
        AND s.trial_ends_at IS NOT NULL
        AND s.trial_started_at < b.as_of
        AND s.trial_ends_at >= b.as_of
        AND (s.churn_at IS NULL OR s.churn_at >= b.as_of)
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as Array<{ idx: number; value: number }>;

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
): Map<number, number> {
  const cte = bucketsCte(buckets);
  const apps = appFilter(appIds, 'i.app_id', 'iapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx, COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS value
       FROM buckets b
       LEFT JOIN install_intervals i
         ON i.started_at <= b.as_of
        AND (i.ended_at IS NULL OR i.ended_at > b.as_of)
        ${apps.sql ? `AND ${apps.sql}` : ''}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as Array<{ idx: number; value: number }>;

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
): ChurnPoint[] {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`ci${idx}`] = idx;
    params[`ca${idx}`] = bucket.end.toISOString();
    params[`cw${idx}`] = new Date(bucket.end.getTime() - windowDays * MS_PER_DAY).toISOString();
    return `(@ci${idx}, @ca${idx}, @cw${idx})`;
  });

  const predicate = asOfPredicate(options, 'b.window_start');
  const apps = appFilter(options.appIds, 's.app_id', 'app');
  const countExpr = byShop ? COUNT_SUBSCRIBERS : 'COUNT(s.charge_id)';
  const gate = options.includeTrials ? 's.activated_at' : 's.conversion_at';

  return db
    .prepare(
      `WITH cbuckets(idx, as_of, window_start) AS (VALUES ${rows.join(', ')}),
       base AS (
         SELECT b.idx AS idx,
                ${countExpr} AS population,
                COALESCE(SUM(s.monthly_amount), 0) AS baseMrr
         FROM cbuckets b
         LEFT JOIN subscriptions s ON ${predicate.sql}
         GROUP BY b.idx
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
    .all({ ...params, ...predicate.params, ...apps.params }) as ChurnPoint[];
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
): InstallChurnPoint[] {
  const params: Record<string, unknown> = {};
  const rows = buckets.map((bucket, idx) => {
    params[`li${idx}`] = idx;
    params[`la${idx}`] = bucket.end.toISOString();
    params[`lw${idx}`] = new Date(bucket.end.getTime() - windowDays * MS_PER_DAY).toISOString();
    return `(@li${idx}, @la${idx}, @lw${idx})`;
  });

  const baseApps = appFilter(appIds, 'i.app_id', 'lbapp');
  const eventApps = appFilter(appIds, 'e.app_id', 'leapp');

  return db
    .prepare(
      `WITH lbuckets(idx, as_of, window_start) AS (VALUES ${rows.join(', ')}),
       base AS (
         SELECT b.idx AS idx,
                COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS population
         FROM lbuckets b
         LEFT JOIN install_intervals i
           ON i.started_at <= b.window_start
          AND (i.ended_at IS NULL OR i.ended_at > b.window_start)
          ${baseApps.sql ? `AND ${baseApps.sql}` : ''}
         GROUP BY b.idx
       ),
       movement AS (
         SELECT b.idx AS idx,
                COALESCE(SUM(CASE WHEN e.type IN ('uninstalled', 'deactivated') THEN 1 ELSE 0 END), 0) AS uninstalled,
                COALESCE(SUM(CASE WHEN e.type IN ('reinstalled', 'reactivated') THEN 1 ELSE 0 END), 0) AS reinstalled
         FROM lbuckets b
         LEFT JOIN customer_events e
           ON e.suppressed = 0
          AND e.type IN ('uninstalled', 'deactivated', 'reinstalled', 'reactivated')
          AND e.occurred_at >= b.window_start
          AND e.occurred_at < b.as_of
          ${eventApps.sql ? `AND ${eventApps.sql}` : ''}
         GROUP BY b.idx
       )
       SELECT base.idx AS idx,
              base.population AS population,
              movement.uninstalled AS uninstalled,
              movement.reinstalled AS reinstalled
       FROM base
       JOIN movement ON movement.idx = base.idx
       ORDER BY base.idx`,
    )
    .all({ ...params, ...baseApps.params, ...eventApps.params }) as InstallChurnPoint[];
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

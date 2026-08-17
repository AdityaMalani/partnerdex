import { stockSeries, stockSeriesByApp, usageSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
import { appIdFilter, rollupReady, splitBuckets, splitCte } from '../rollup.js';
import { growthFrom } from '../growth.js';
import { buildResponse, type MetricResponse, type NamedSeries } from '../response.js';
import type { Bucket } from '../time.js';

/**
 * Recurring revenue reports (spec 4.1-4.3).
 *
 * MRR composes three independently-reconstructed components so the dashboard
 * can show where the money comes from, and so a surprise in the total can be
 * traced to one of them.
 */

interface MrrComponents {
  /** One entry per bucket, including the hidden leading bucket at index 0. */
  monthly: number[];
  annual: number[];
  usage: number[];
  total: number[];
}

function mrrComponents(context: MetricContext, buckets: Bucket[]): MrrComponents {
  const stock = stockSeries(context.db, buckets, context.asOf);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const usage = context.includeUsage
    ? usageSeries(context.db, buckets, context.appIds, context.window.timeZone)
    : new Map<number, number>();

  const monthly: number[] = [];
  const annual: number[] = [];
  const usageValues: number[] = [];
  const total: number[] = [];

  for (let idx = 0; idx < buckets.length; idx += 1) {
    const point = byIndex.get(idx);
    const m = point?.monthlyMrr ?? 0;
    // The as-of predicate already drops annual plans when includeAnnual is off,
    // so this column is zero in that case rather than needing a second guard.
    const a = point?.annualMrr ?? 0;
    const u = usage.get(idx) ?? 0;
    monthly.push(m);
    annual.push(a);
    usageValues.push(u);
    total.push(m + a + u);
  }

  return { monthly, annual, usage: usageValues, total };
}

function componentSeries(
  buckets: Bucket[],
  components: MrrComponents,
  includeUsage: boolean,
): NamedSeries[] {
  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const build = (key: string, name: string, values: number[]): NamedSeries => ({
    key,
    name,
    data: dates.map((date, index) => ({ date, value: Math.round((values[index] ?? 0) * 100) / 100 })),
  });

  const series = [
    build('monthly', 'Monthly plans', components.monthly),
    build('annual', 'Annual plans', components.annual),
  ];
  if (includeUsage) series.push(build('usage', 'Usage', components.usage));
  return series;
}

export function mrrReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const [leading, ...visible] = components.total;

  return buildResponse({
    metric: 'mrr',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    series: componentSeries(
      context.window.buckets,
      {
        monthly: components.monthly.slice(1),
        annual: components.annual.slice(1),
        usage: components.usage.slice(1),
        total: visible,
      },
      context.includeUsage,
    ),
    meta: {
      includeAnnual: context.asOf.includeAnnual,
      includeUsage: context.includeUsage,
      includeTrials: context.asOf.includeTrials,
    },
  });
}

/**
 * MRR growth as a percentage per bucket, and across the window as a whole.
 *
 * The headline is the period figure, not the last bucket: "MRR grew 8% over the
 * last 12 months" is the question this metric answers, and the final month's
 * rate would answer a much smaller one.
 */
export function mrrGrowthReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const growth = growthFrom(components.total);

  return buildResponse({
    metric: 'mrr_growth',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: growth.values,
    summaryOverride: growth.periodGrowth,
    meta: {
      formula: 'MRR change against the previous bucket',
      summaryBasis: 'whole window: MRR at the end against MRR at the start',
      bucketsWithoutBase: growth.undefinedBuckets,
    },
  });
}

/**
 * The palette carries four categorical slots, so at most four series can be
 * told apart by colour. Beyond that the tail folds into "Other" rather than
 * inventing a fifth hue.
 */
const MAX_APP_SERIES = 4;

/**
 * MRR split by the app earning it. The components sum to the MRR report's total
 * by construction — same predicate, one more GROUP BY column.
 */
export function mrrByAppReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const points = stockSeriesByApp(context.db, buckets, context.asOf);

  const totalByApp = new Map<string, number>();
  const nameByApp = new Map<string, string>();
  for (const point of points) {
    totalByApp.set(point.appId, (totalByApp.get(point.appId) ?? 0) + point.mrr);
    if (point.appName) nameByApp.set(point.appId, point.appName);
  }

  /**
   * Which apps get their own slot is a size question, but their colour is not:
   * the kept ids are sorted by id so a slot belongs to an app rather than to a
   * rank, and adding a bigger app later does not repaint the others.
   */
  const ranked = [...totalByApp.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const folds = ranked.length > MAX_APP_SERIES;
  const kept = new Set(ranked.slice(0, folds ? MAX_APP_SERIES - 1 : MAX_APP_SERIES));
  const keptIds = [...kept].sort();

  const byIdxAndApp = new Map<string, number>();
  for (const point of points) {
    const app = kept.has(point.appId) ? point.appId : 'other';
    const key = `${point.idx} ${app}`;
    byIdxAndApp.set(key, (byIdxAndApp.get(key) ?? 0) + point.mrr);
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const seriesFor = (key: string, name: string): NamedSeries => ({
    key,
    name,
    data: dates.map((date, idx) => ({
      date,
      value: Math.round((byIdxAndApp.get(`${idx} ${key}`) ?? 0) * 100) / 100,
    })),
  });

  const series = keptIds.map((id) => seriesFor(id, nameByApp.get(id) ?? `App ${id}`));
  if (folds) series.push(seriesFor('other', `Other (${ranked.length - kept.size} apps)`));

  const values = buckets.map((_, idx) =>
    series.reduce((total, item) => total + (item.data[idx]?.value ?? 0), 0),
  );

  return buildResponse({
    metric: 'mrr_by_app',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values,
    currency: context.currency,
    series,
    meta: {
      apps: totalByApp.size,
      note: folds
        ? `Only the ${MAX_APP_SERIES - 1} largest apps get their own band; the rest are folded into "Other".`
        : undefined,
    },
  });
}

/** ARR is a pure run-rate: the current MRR annualized, with no growth model. */
export function arrReport(context: MetricContext): MetricResponse {
  const components = mrrComponents(context, context.bucketsWithLead);
  const annualized = components.total.map((value) => value * 12);
  const [leading, ...visible] = annualized;

  return buildResponse({
    metric: 'arr',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    meta: {
      basis: 'latest MRR x 12',
      includeAnnual: context.asOf.includeAnnual,
      includeUsage: context.includeUsage,
    },
  });
}

/** Transaction types that make up what merchants actually paid. */
const EARNING_TYPES = [
  'AppSubscriptionSale',
  'AppOneTimeSale',
  'AppUsageSale',
  'AppSaleAdjustment',
  'AppSaleCredit',
];

interface EarningsRow {
  idx: number;
  gross: number;
  net: number;
  subscription: number;
  oneTime: number;
  usage: number;
  adjustments: number;
}

/**
 * Gross earnings (spec 4.3) is a flow: what merchants paid inside each bucket,
 * summed over the range. It comes from the transactions feed rather than the
 * subscription index, because billed money and contracted price diverge
 * (proration, refunds, failed charges).
 */
/**
 * Gross earnings is the metric the rollup was built for: it is a flow, so every
 * bucket sums a disjoint slice of the ledger, and reading it from the raw table
 * meant one full pass per bucket — a dozen passes over millions of rows to
 * produce a dozen numbers.
 *
 * The bucket interiors come from `transaction_daily`, which carries `type`, so
 * the component breakdown splits the same way the total does. Only the two
 * outermost buckets have a remainder to read raw: the first bucket is clamped to
 * the requested start and the last to `now`, and every boundary between them is
 * a local midnight the rollup is keyed on.
 */
export function grossEarningsReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const split = splitBuckets(
    buckets.map((bucket, idx) => ({ idx, from: bucket.start, to: bucket.end })),
    context.window.timeZone,
    rollupReady(context.db),
  );
  const cte = splitCte(split);
  const rollupApps = appIdFilter(context.appIds, 'r.app_id', 'erapp');
  const rawApps = appIdFilter(context.appIds, 't.app_id', 'eapp');

  const params: Record<string, unknown> = {
    ...cte.params,
    ...rollupApps.params,
    ...rawApps.params,
  };
  const typeNames = EARNING_TYPES.map((type, index) => {
    params[`etype${index}`] = type;
    return `@etype${index}`;
  });
  const typeFilter = `type IN (${typeNames.join(', ')})`;

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT idx,
              COALESCE(SUM(gross), 0) AS gross,
              COALESCE(SUM(net), 0) AS net,
              COALESCE(SUM(CASE WHEN type = 'AppSubscriptionSale' THEN gross ELSE 0 END), 0) AS subscription,
              COALESCE(SUM(CASE WHEN type = 'AppOneTimeSale' THEN gross ELSE 0 END), 0) AS oneTime,
              COALESCE(SUM(CASE WHEN type = 'AppUsageSale' THEN gross ELSE 0 END), 0) AS usage,
              COALESCE(SUM(CASE WHEN type IN ('AppSaleAdjustment', 'AppSaleCredit') THEN gross ELSE 0 END), 0) AS adjustments
       FROM (
         SELECT b.idx AS idx, r.type AS type, r.gross_amount AS gross, r.net_amount AS net
         FROM rdays b
         JOIN transaction_daily r
           ON r.day >= b.day_from AND r.day < b.day_to
          AND r.${typeFilter}
          ${rollupApps.sql ? `AND ${rollupApps.sql}` : ''}
         UNION ALL
         SELECT e.idx AS idx, t.type AS type, t.gross_amount AS gross, t.net_amount AS net
         FROM redges e
         JOIN transactions t
           ON t.created_at >= e.lo AND t.created_at < e.hi
          AND t.${typeFilter}
          ${rawApps.sql ? `AND ${rawApps.sql}` : ''}
       )
       GROUP BY idx
       ORDER BY idx`,
    )
    .all(params) as EarningsRow[];

  const byIndex = new Map(rows.map((row) => [row.idx, row]));
  const values = buckets.map((_, idx) => byIndex.get(idx)?.gross ?? 0);
  const dates = buckets.map((bucket) => bucket.start.toISOString());

  const series: NamedSeries[] = (
    [
      ['subscription', 'Subscriptions', (row: EarningsRow) => row.subscription],
      ['oneTime', 'One-time charges', (row: EarningsRow) => row.oneTime],
      ['usage', 'Usage charges', (row: EarningsRow) => row.usage],
      ['adjustments', 'Refunds & credits', (row: EarningsRow) => row.adjustments],
    ] as const
  ).map(([key, name, pick]) => ({
    key,
    name,
    data: dates.map((date, idx) => {
      const row = byIndex.get(idx);
      return { date, value: row ? Math.round(pick(row) * 100) / 100 : 0 };
    }),
  }));

  const netTotal = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.net ?? 0), 0);

  return buildResponse({
    metric: 'gross_earnings',
    kind: 'flow',
    format: 'money',
    window: context.window,
    values,
    currency: context.currency,
    series,
    meta: {
      // Net is what actually reaches the payout after Shopify's revenue share;
      // carried in meta so the headline stays unambiguously gross.
      netEarnings: Math.round(netTotal * 100) / 100,
    },
  });
}

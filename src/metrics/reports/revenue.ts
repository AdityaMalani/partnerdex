import { bucketsCte, stockSeries, stockSeriesByApp, usageSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
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
    ? usageSeries(context.db, buckets, context.appIds)
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
 * MRR split by the app earning it. The components sum to the MRR report's total
 * by construction — same predicate, one more GROUP BY column.
 *
 * Every app gets its own row. This used to fold the tail past the fourth into
 * an "Other" band, because the palette carries four categorical slots and a
 * fifth hue would not have been distinguishable from the others. The dashboard
 * reads this as a table now, where a row is identified by its name rather than
 * its colour, so the cap has nothing left to protect — and folding the tail
 * would have hidden exactly the figure the table exists to show.
 *
 * Ordered largest first. The old order was by app id, which kept a colour
 * attached to an app as the ranking moved underneath it; a table has no colours
 * to keep stable, and size is the order a reader wants to scan.
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

  const ranked = [...totalByApp.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const byIdxAndApp = new Map<string, number>();
  for (const point of points) {
    const key = `${point.idx} ${point.appId}`;
    byIdxAndApp.set(key, (byIdxAndApp.get(key) ?? 0) + point.mrr);
  }

  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const series: NamedSeries[] = ranked.map((id) => ({
    key: id,
    name: nameByApp.get(id) ?? `App ${id}`,
    data: dates.map((date, idx) => ({
      date,
      value: Math.round((byIdxAndApp.get(`${idx} ${id}`) ?? 0) * 100) / 100,
    })),
  }));

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
      basis: 'MRR as of the end of the range, split by app and ordered largest first',
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
export function grossEarningsReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);

  const params: Record<string, unknown> = { ...cte.params };
  const appNames = context.appIds.map((id, index) => {
    params[`eapp${index}`] = id;
    return `@eapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND t.app_id IN (${appNames.join(', ')})` : '';
  const typeNames = EARNING_TYPES.map((type, index) => {
    params[`etype${index}`] = type;
    return `@etype${index}`;
  });

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COALESCE(SUM(t.gross_amount), 0) AS gross,
              COALESCE(SUM(t.net_amount), 0) AS net,
              COALESCE(SUM(CASE WHEN t.type = 'AppSubscriptionSale' THEN t.gross_amount ELSE 0 END), 0) AS subscription,
              COALESCE(SUM(CASE WHEN t.type = 'AppOneTimeSale' THEN t.gross_amount ELSE 0 END), 0) AS oneTime,
              COALESCE(SUM(CASE WHEN t.type = 'AppUsageSale' THEN t.gross_amount ELSE 0 END), 0) AS usage,
              COALESCE(SUM(CASE WHEN t.type IN ('AppSaleAdjustment', 'AppSaleCredit') THEN t.gross_amount ELSE 0 END), 0) AS adjustments
       FROM buckets b
       LEFT JOIN transactions t
         ON t.created_at >= b.bucket_from
        AND t.created_at < b.as_of
        AND t.type IN (${typeNames.join(', ')})
        ${appFilter}
       GROUP BY b.idx
       ORDER BY b.idx`,
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

/**
 * How MRR moved inside each bucket, as an accounting ledger rather than a level
 * (spec 2.4 — the "movement" view).
 *
 * The source is `customer_events.net_change`, not the as-of reconstruction: a
 * level tells you MRR fell by 400 last month, and only the ledger tells you
 * that 900 arrived, 500 was upgraded onto, and 1,800 walked out. The six
 * categories below are exhaustive over the events that carry a delta at all, so
 * every row adds across to `Net` with nothing unattributed — `test/metrics`
 * asserts it rather than trusting it.
 *
 * Signs are kept as the ledger stores them: losses are negative. That is what
 * lets a reader sum a row by eye instead of tracking which columns to subtract.
 */
const MOVEMENTS = [
  // Money arrives at the first paid charge, so a trial converting is an
  // acquisition here even though the subscription activated months earlier.
  // Win-backs join it: both are an install that was paying nothing and now is.
  ['added', 'New', ['subscribed', 'resubscribed', 'trial_converted']],
  ['frozen', 'Frozen', ['subscription_frozen']],
  ['unfrozen', 'Unfrozen', ['subscription_unfrozen']],
  ['churned', 'Churned', ['unsubscribed']],
  // Direction is the plan's list price, the delta is what is actually earned,
  // and the two can disagree — an upgrade taken mid-trial moves less money than
  // the price list suggests. Summing signed deltas keeps the ledger balanced
  // whichever way an individual movement lands.
  ['upgraded', 'Upgraded', ['upgraded']],
  ['downgraded', 'Downgraded', ['downgraded']],
] as const satisfies ReadonlyArray<readonly [string, string, readonly string[]]>;

type MovementRow = { idx: number; net: number } & Record<string, number>;

export function mrrMovementReport(context: MetricContext): MetricResponse {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);
  const params: Record<string, unknown> = { ...cte.params };

  const appNames = context.appIds.map((id, index) => {
    params[`mapp${index}`] = id;
    return `@mapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND e.app_id IN (${appNames.join(', ')})` : '';

  // The same gate the MRR report applies, so the two agree on which
  // subscriptions are in scope. NULL is kept: an event with no charge behind it
  // has no cadence to exclude on.
  const annualFilter = context.asOf.includeAnnual
    ? ''
    : `AND (e.billing_interval IS NULL OR e.billing_interval <> 'ANNUAL')`;

  const columns = MOVEMENTS.map(([key, , types]) => {
    const names = types.map((type, index) => {
      const name = `${key}_t${index}`;
      params[name] = type;
      return `@${name}`;
    });
    return `COALESCE(SUM(CASE WHEN e.type IN (${names.join(', ')}) THEN e.net_change ELSE 0 END), 0) AS ${key}`;
  });

  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              ${columns.join(',\n              ')},
              COALESCE(SUM(e.net_change), 0) AS net
       FROM buckets b
       LEFT JOIN customer_events e
         ON e.suppressed = 0
        AND e.net_change IS NOT NULL
        AND e.occurred_at >= b.bucket_from
        AND e.occurred_at < b.as_of
        ${appFilter}
        ${annualFilter}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all(params) as MovementRow[];

  const byIndex = new Map(rows.map((row) => [row.idx, row]));
  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const round = (value: number): number => Math.round(value * 100) / 100;
  const cell = (idx: number, key: string): number => round(byIndex.get(idx)?.[key] ?? 0);

  /**
   * Net is the sum of the columns as *displayed*, not an independently rounded
   * total of the same events. The two differ by a cent often enough to matter,
   * and a ledger the reader adds across has to close: a row that lands a penny
   * short reads as a bug in the figures rather than as rounding.
   */
  const net = buckets.map((_, idx) =>
    round(MOVEMENTS.reduce((sum, [key]) => sum + cell(idx, key), 0)),
  );

  const series: NamedSeries[] = [
    ...MOVEMENTS.map(([key, name]) => ({
      key,
      name,
      data: dates.map((date, idx) => ({ date, value: cell(idx, key) })),
    })),
    { key: 'net', name: 'Net', data: dates.map((date, idx) => ({ date, value: net[idx]! })) },
  ];

  /**
   * What the ledger moved that no column claimed. Zero by construction — the six
   * categories cover every event type that carries a delta — so it is carried as
   * an observable rather than an assurance: an event type that gains a
   * `net_change` later shows up here instead of quietly going missing.
   */
  const unattributed = round(
    buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.net ?? 0), 0) -
      net.reduce((total, value) => total + value, 0),
  );

  return buildResponse({
    metric: 'mrr_movement',
    kind: 'flow',
    format: 'money',
    window: context.window,
    values: net,
    currency: context.currency,
    series,
    meta: {
      basis: 'customer_events.net_change, suppressed rows excluded',
      // Rounding alone, unless a delta-carrying event type has escaped the six
      // categories — in which case this is the size of what is missing.
      unattributed,
      includeAnnual: context.asOf.includeAnnual,
      // Worth stating rather than leaving to be discovered: the trials toggle
      // moves the MRR card beside this one and cannot move this table. The
      // ledger records money from the first paid charge, and a trial-inclusive
      // delta is not a figure it holds.
      includeTrials: false,
      trialsNote:
        'The ledger counts money from the first paid charge, so the trials filter does not apply here.',
      note: 'Movement view. It may differ slightly from the change in the reconstructed MRR level, which reads a state rather than summing events.',
    },
  });
}

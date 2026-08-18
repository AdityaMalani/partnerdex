import {
  activeInstallSeries,
  churnRate,
  churnSeries,
  installChurnRate,
  installChurnSeries,
  newSubscriptionSeries,
  stockSeries,
  type ChurnPoint,
} from '../asof.js';
import type { MetricContext } from '../context.js';
import { growthFrom } from '../growth.js';
import { buildResponse, type MetricResponse } from '../response.js';

/**
 * Subscriber and install counts (spec 4.4-4.5) and churn (spec 4.7). All four
 * read through the same as-of predicate the MRR report uses, so a count and a
 * revenue figure can never disagree about who was live at a given instant.
 */

export function activeSubscriptionsReport(context: MetricContext): MetricResponse {
  const stock = stockSeries(context.db, context.bucketsWithLead, context.asOf, context.window.timeZone);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const values = context.bucketsWithLead.map((_, idx) => byIndex.get(idx)?.subscriptions ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'active_subscriptions',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: { includeTrials: context.asOf.includeTrials },
  });
}

/**
 * Subscribers: distinct shop-and-app pairs currently paying. A merchant running
 * two of your apps counts twice, matching how each app reports its own numbers,
 * and so that dropping one app shows up as churn instead of being masked by the
 * other.
 */
export function subscribersReport(context: MetricContext): MetricResponse {
  const stock = stockSeries(context.db, context.bucketsWithLead, context.asOf, context.window.timeZone);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const values = context.bucketsWithLead.map((_, idx) => byIndex.get(idx)?.subscribers ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'subscribers',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      definition: 'Shop-and-app pairs with a live paid subscription.',
      includeTrials: context.asOf.includeTrials,
    },
  });
}

/**
 * Active installs counts every shop with the app installed, paying or not, so
 * it sits well above active shops. It reads the install intervals rather than
 * the subscription index.
 */
export function activeInstallsReport(context: MetricContext): MetricResponse {
  const series = activeInstallSeries(context.db, context.bucketsWithLead, context.appIds, context.window.timeZone);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx) ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'active_installs',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      note: 'Installs whose history begins before SYNC_START_DATE cannot be dated and are excluded.',
    },
  });
}

/**
 * New subscriptions per bucket: the inflow side of the same ledger churn reads
 * the outflow of. Both gate on the instant a subscription starts paying, so a
 * bucket's net movement is exactly new minus churned.
 */
export function newSubscriptionsReport(context: MetricContext): MetricResponse {
  const series = newSubscriptionSeries(
    context.db,
    context.window.buckets,
    context.asOf,
    context.byShop,
    context.planChangeWindowDays,
  );
  const values = context.window.buckets.map((_, idx) => series.get(idx) ?? 0);

  return buildResponse({
    metric: 'new_subscriptions',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values,
    meta: {
      basis: context.byShop ? 'subscribers' : 'subscriptions',
      gate: context.asOf.includeTrials ? 'activation' : 'first paid charge',
      excludes: 'plan changes (upgrade or downgrade to a new charge)',
    },
  });
}

/** Subscription growth, derived from the same live counts the stock report reads. */
export function subscriptionGrowthReport(context: MetricContext): MetricResponse {
  const stock = stockSeries(context.db, context.bucketsWithLead, context.asOf, context.window.timeZone);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const levels = context.bucketsWithLead.map((_, idx) => byIndex.get(idx)?.subscriptions ?? 0);
  const growth = growthFrom(levels);

  return buildResponse({
    metric: 'subscription_growth',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: growth.values,
    summaryOverride: growth.periodGrowth,
    meta: {
      formula: 'live subscriptions against the previous bucket',
      summaryBasis: 'whole window: the count at the end against the count at the start',
      bucketsWithoutBase: growth.undefinedBuckets,
    },
  });
}

/**
 * The two subscription-ledger churn rates share one window and one exclusion
 * rule and differ only in what they divide: money or contracts. Deriving both
 * from a single `churnSeries` call is what keeps them consistent — a revenue
 * churn that disagreed with subscription churn about who was live would be
 * worse than either number alone.
 *
 * Logo churn is deliberately not routed through here: it divides installs, and
 * installs live in a different ledger.
 */
function churnVariant(
  context: MetricContext,
  metric: string,
  basis: 'revenue' | 'subscriptions',
): MetricResponse {
  const points = churnSeries(
    context.db,
    context.bucketsWithLead,
    context.asOf,
    context.churnWindowDays,
    false,
    context.window.timeZone,
  );
  const byIndex = new Map(points.map((point) => [point.idx, point]));

  const rateOf = (point: ChurnPoint | undefined): number => {
    if (basis !== 'revenue') return churnRate(point) * 100;
    if (!point || point.baseMrr <= 0) return 0;
    return (point.lostMrr / point.baseMrr) * 100;
  };

  const values = context.bucketsWithLead.map((_, idx) => rateOf(byIndex.get(idx)));
  const [leading, ...visible] = values;

  const dates = context.window.buckets.map((bucket) => bucket.start.toISOString());
  const lostName = { revenue: 'MRR lost', subscriptions: 'Subscriptions lost' };
  const lost = dates.map((date, index) => {
    const point = byIndex.get(index + 1);
    const amount = basis === 'revenue' ? point?.lostMrr ?? 0 : point?.churned ?? 0;
    return { date, value: Math.round(amount * 100) / 100 };
  });

  return buildResponse({
    metric,
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    series: [{ key: 'lost', name: lostName[basis], data: lost }],
    meta: {
      windowDays: context.churnWindowDays,
      basis,
      denominator:
        basis === 'revenue'
          ? 'MRR live at the start of the rolling window'
          : 'subscriptions live at the start of the rolling window',
      excludes: 'plan changes (upgrade or downgrade to a new charge)',
    },
  });
}

/** MRR lost in the window over the MRR that was live when it opened. */
export function revenueChurnReport(context: MetricContext): MetricResponse {
  return churnVariant(context, 'revenue_churn', 'revenue');
}

/** Contracts lost. A shop dropping one of two subscriptions counts here. */
export function subscriptionChurnReport(context: MetricContext): MetricResponse {
  return churnVariant(context, 'subscription_churn', 'subscriptions');
}

/**
 * Logos lost: `(uninstalls − reinstalls) ÷ active installs at the window start`
 * (spec 4.7). Alone among the three churn rates it reads the install ledger
 * rather than the subscription index, so it counts free installs, and a shop
 * that cancels but leaves the app installed is not yet a lost logo.
 *
 * Running it through `churnVariant` instead made it count churned shop-and-app
 * pairs off `subscriptions` — the same rows subscription churn divides, which
 * is why the two reported the same number for any app whose shops hold one
 * charge apiece.
 */
export function logoChurnReport(context: MetricContext): MetricResponse {
  const points = installChurnSeries(
    context.db,
    context.bucketsWithLead,
    context.appIds,
    context.churnWindowDays,
    context.window.timeZone,
  );
  const byIndex = new Map(points.map((point) => [point.idx, point]));

  const values = context.bucketsWithLead.map((_, idx) => installChurnRate(byIndex.get(idx)) * 100);
  const [leading, ...visible] = values;

  const lost = context.window.buckets.map((bucket, index) => {
    const point = byIndex.get(index + 1);
    return {
      date: bucket.start.toISOString(),
      value: point ? point.uninstalled - point.reinstalled : 0,
    };
  });

  return buildResponse({
    metric: 'logo_churn',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    series: [{ key: 'lost', name: 'Installs lost, net of reinstalls', data: lost }],
    meta: {
      windowDays: context.churnWindowDays,
      basis: 'installs',
      formula: '(uninstalls − reinstalls) / active installs at the window start',
      denominator: 'active installs at the start of the rolling window',
      counts: 'a deactivation as an uninstall, a reactivation as a return',
      note: 'Installs whose history begins before SYNC_START_DATE cannot be dated and are excluded.',
    },
  });
}

export function churnReport(context: MetricContext): MetricResponse {
  const points = churnSeries(
    context.db,
    context.bucketsWithLead,
    context.asOf,
    context.churnWindowDays,
    context.byShop,
    context.window.timeZone,
  );
  const byIndex = new Map(points.map((point) => [point.idx, point]));

  const values = context.bucketsWithLead.map(
    (_, idx) => churnRate(byIndex.get(idx)) * 100,
  );
  const [leading, ...visible] = values;

  const dates = context.window.buckets.map((bucket) => bucket.start.toISOString());
  const revenueChurn = dates.map((date, index) => {
    const point = byIndex.get(index + 1);
    const rate = point && point.baseMrr > 0 ? (point.lostMrr / point.baseMrr) * 100 : 0;
    return { date, value: Math.round(rate * 100) / 100 };
  });
  const churnedCount = dates.map((date, index) => ({
    date,
    value: byIndex.get(index + 1)?.churned ?? 0,
  }));

  return buildResponse({
    metric: 'churn',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    series: [
      { key: 'revenue_churn', name: 'Revenue churn %', data: revenueChurn },
      {
        key: 'churned',
        name: context.byShop ? 'Subscribers lost' : 'Subscriptions lost',
        data: churnedCount,
      },
    ],
    meta: {
      windowDays: context.churnWindowDays,
      basis: context.byShop ? 'subscribers' : 'subscriptions',
      denominator: 'population live at the start of the rolling window',
      excludes: 'plan changes (upgrade or downgrade to a new charge)',
    },
  });
}

import { churnRate, churnSeries, stockSeries, usageSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse } from '../response.js';

/**
 * Unit economics (spec 4.9-4.10).
 *
 * Both metrics are ratios over figures the other reports already produce, which
 * is the point: ARPU and LTV must move consistently with MRR and churn rather
 * than being derived from a parallel definition.
 *
 * Every division here is guarded. A zero population or a month with no churn is
 * normal for a small app, and an unguarded divide turns the whole dashboard
 * into NaN or Infinity.
 */

interface Inputs {
  /** MRR per bucket, including the hidden leading bucket at index 0. */
  mrr: number[];
  population: number[];
}

function gatherInputs(context: MetricContext): Inputs {
  const buckets = context.bucketsWithLead;
  const stock = stockSeries(context.db, buckets, context.asOf);
  const byIndex = new Map(stock.map((point) => [point.idx, point]));
  const usage = context.includeUsage
    ? usageSeries(context.db, buckets, context.appIds, context.window.timeZone)
    : new Map<number, number>();

  const mrr: number[] = [];
  const population: number[] = [];

  for (let idx = 0; idx < buckets.length; idx += 1) {
    const point = byIndex.get(idx);
    mrr.push((point?.monthlyMrr ?? 0) + (point?.annualMrr ?? 0) + (usage.get(idx) ?? 0));
    population.push(context.byShop ? point?.subscribers ?? 0 : point?.subscriptions ?? 0);
  }

  return { mrr, population };
}

export function arpuReport(context: MetricContext): MetricResponse {
  const { mrr, population } = gatherInputs(context);
  const values = mrr.map((value, index) => {
    const people = population[index] ?? 0;
    return people > 0 ? value / people : 0;
  });
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'arpu',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    meta: {
      population: context.byShop ? 'paying subscribers' : 'live subscriptions',
      includeTrials: context.asOf.includeTrials,
      note: context.asOf.includeTrials
        ? 'Trials are in the denominator, which deflates ARPU.'
        : undefined,
    },
  });
}

/**
 * Predicted LTV = ARPU / monthly churn rate. This is the instantaneous,
 * forward-looking form: what the current cohort is worth if today's churn rate
 * held forever. It is not a cohort-cumulative measurement of realized revenue,
 * and it swings hard when churn is near zero.
 */
export function ltvReport(context: MetricContext): MetricResponse {
  const { mrr, population } = gatherInputs(context);
  const churn = churnSeries(
    context.db,
    context.bucketsWithLead,
    context.asOf,
    context.churnWindowDays,
    context.byShop,
  );
  const byIndex = new Map(churn.map((point) => [point.idx, point]));

  let undefinedBuckets = 0;
  const values = mrr.map((value, index) => {
    const people = population[index] ?? 0;
    const arpu = people > 0 ? value / people : 0;
    const rate = churnRate(byIndex.get(index));
    if (rate <= 0) {
      // No churn in the window means LTV is unbounded, not enormous. Reporting
      // zero keeps the series readable and the count of such buckets is in meta.
      undefinedBuckets += 1;
      return 0;
    }
    return arpu / rate;
  });

  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'ltv',
    kind: 'stock',
    format: 'money',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    currency: context.currency,
    meta: {
      formula: 'ARPU / monthly churn rate',
      churnWindowDays: context.churnWindowDays,
      basis: context.byShop ? 'subscribers' : 'subscriptions',
      bucketsWithoutChurn: undefinedBuckets,
      note: 'Directional. Buckets with zero churn have no finite LTV and are reported as 0.',
    },
  });
}

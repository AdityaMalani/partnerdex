import { bucketsCte, onTrialSeries } from '../asof.js';
import type { MetricContext } from '../context.js';
import { buildResponse, type MetricResponse } from '../response.js';

/**
 * Trials (spec 4.11).
 *
 * The Partner API does not report trial periods. A trial is inferred at sync
 * time from the gap between a subscription activating and its first paid
 * charge landing: no gap means the merchant paid immediately, a gap means they
 * were trialling. `TRIAL_MIN_GAP_DAYS` sets the threshold, which also absorbs
 * the short lag between a charge and its transaction being recorded.
 *
 * The resulting statuses live on `subscriptions.trial_status`:
 *   converted - a paid charge eventually landed
 *   canceled  - the subscription ended before any paid charge
 *   in_trial  - still inside the free period right now
 *   unknown   - activated, never billed, never cancelled, past its billing date
 *               (a data gap rather than a real outcome; excluded from the rate)
 */

interface TrialRow {
  idx: number;
  started: number;
  converted: number;
  canceled: number;
}

function trialCounts(context: MetricContext): Map<number, TrialRow> {
  const buckets = context.window.buckets;
  const cte = bucketsCte(buckets);

  const params: Record<string, unknown> = { ...cte.params };
  const appNames = context.appIds.map((id, index) => {
    params[`tapp${index}`] = id;
    return `@tapp${index}`;
  });
  const appFilter = appNames.length > 0 ? `AND s.app_id IN (${appNames.join(', ')})` : '';

  // Bucketed by when the trial started, so a conversion is credited to the
  // cohort that produced it rather than to the month the money arrived.
  const rows = context.db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COUNT(s.charge_id) AS started,
              COALESCE(SUM(CASE WHEN s.trial_status = 'converted' THEN 1 ELSE 0 END), 0) AS converted,
              COALESCE(SUM(CASE WHEN s.trial_status = 'canceled'  THEN 1 ELSE 0 END), 0) AS canceled
       FROM buckets b
       LEFT JOIN subscriptions s
         ON s.is_test = 0
        AND s.trial_started_at IS NOT NULL
        AND s.trial_started_at >= b.bucket_from
        AND s.trial_started_at < b.as_of
        ${appFilter}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all(params) as TrialRow[];

  return new Map(rows.map((row) => [row.idx, row]));
}

export function trialsReport(context: MetricContext): MetricResponse {
  const byIndex = trialCounts(context);
  const buckets = context.window.buckets;
  const dates = buckets.map((bucket) => bucket.start.toISOString());
  const values = buckets.map((_, idx) => byIndex.get(idx)?.started ?? 0);

  const converted = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.converted ?? 0), 0);
  const canceled = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.canceled ?? 0), 0);
  const decided = converted + canceled;

  return buildResponse({
    metric: 'trials',
    kind: 'flow',
    format: 'count',
    window: context.window,
    values,
    series: [
      {
        key: 'converted',
        name: 'Converted',
        data: dates.map((date, idx) => ({ date, value: byIndex.get(idx)?.converted ?? 0 })),
      },
      {
        key: 'canceled',
        name: 'Cancelled',
        data: dates.map((date, idx) => ({ date, value: byIndex.get(idx)?.canceled ?? 0 })),
      },
    ],
    meta: {
      converted,
      canceled,
      // Trials still running have no outcome yet and stay out of the rate.
      conversionRate: decided > 0 ? Math.round((converted / decided) * 10000) / 100 : 0,
      minGapDays: 'TRIAL_MIN_GAP_DAYS',
      note: 'Trials are inferred from the gap between activation and first payment; the Partner API does not expose trial length.',
    },
  });
}

/**
 * How many trials were running at each instant — a stock, where `trials` is the
 * flow that feeds it. This is the number that answers "how big is the pipeline
 * right now", which trials-started cannot: a bucket with 40 starts and 40
 * decisions has an empty pipeline.
 */
export function onTrialReport(context: MetricContext): MetricResponse {
  const series = onTrialSeries(context.db, context.bucketsWithLead, context.appIds, context.window.timeZone);
  const values = context.bucketsWithLead.map((_, idx) => series.get(idx) ?? 0);
  const [leading, ...visible] = values;

  return buildResponse({
    metric: 'on_trial',
    kind: 'stock',
    format: 'count',
    window: context.window,
    values: visible,
    leadingValue: leading ?? null,
    meta: {
      definition: 'Trials started but neither converted nor cancelled as of the instant.',
      excludes: 'trials whose outcome was never recorded, which have no end instant to test',
    },
  });
}

/**
 * Trial conversion rate as its own time series, bucketed by trial start so each
 * point answers "of the trials that began here, what share converted?".
 */
export function trialConversionReport(context: MetricContext): MetricResponse {
  const byIndex = trialCounts(context);
  const buckets = context.window.buckets;

  const values = buckets.map((_, idx) => {
    const row = byIndex.get(idx);
    const decided = (row?.converted ?? 0) + (row?.canceled ?? 0);
    return decided > 0 ? ((row?.converted ?? 0) / decided) * 100 : 0;
  });

  const converted = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.converted ?? 0), 0);
  const canceled = buckets.reduce((total, _, idx) => total + (byIndex.get(idx)?.canceled ?? 0), 0);
  const decided = converted + canceled;

  return buildResponse({
    metric: 'trial_conversion_rate',
    kind: 'stock',
    format: 'percent',
    window: context.window,
    values,
    // A rate is neither a level nor a total. The last bucket is always the
    // least resolved — trials started there have had the least time to decide —
    // so the headline is the rate across the whole window instead.
    summaryOverride: decided > 0 ? (converted / decided) * 100 : 0,
    meta: {
      converted,
      canceled,
      denominator: 'trials with a decided outcome (converted or cancelled)',
      summaryBasis: 'whole window, not the final bucket',
      note: 'Recent buckets are provisional: trials started there may not have resolved yet.',
    },
  });
}

import { getConfig } from '../config.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { buildContext, MetricRequestError, type MetricContext, type RawMetricQuery } from './context.js';
import type { MetricComparison, MetricResponse } from './response.js';
import {
  arrReport,
  grossEarningsReport,
  mrrByAppReport,
  mrrGrowthReport,
  mrrMovementReport,
  mrrReport,
} from './reports/revenue.js';
import {
  activeInstallsReport,
  subscribersReport,
  activeSubscriptionsReport,
  churnReport,
  logoChurnReport,
  newSubscriptionsReport,
  revenueChurnReport,
  subscriptionChurnReport,
  subscriptionGrowthReport,
} from './reports/subscribers.js';
import {
  onTrialReport,
  trialConversionReport,
  trialingReport,
  trialsReport,
} from './reports/trials.js';
import { arpuReport, ltvReport } from './reports/unitEconomics.js';
import {
  reviewsAverageRatingReport,
  reviewsLiveReport,
  reviewsPostedReport,
  reviewsRemovedReport,
} from './reports/reviews.js';

/**
 * The single front door. Both the HTTP API and the CLI dispatch through here,
 * so there is exactly one implementation of each metric (spec 3.1).
 */

export interface MetricDefinition {
  key: string;
  label: string;
  description: string;
  run: (context: MetricContext) => MetricResponse;
  /** Forecasts and other point-in-time projections have no prior-period analogue. */
  comparison?: boolean;
}

export const METRICS: MetricDefinition[] = [
  {
    key: 'mrr',
    label: 'MRR',
    description: 'Monthly recurring revenue reconstructed as-of each bucket.',
    run: mrrReport,
  },
  {
    key: 'arr',
    label: 'ARR',
    description: 'Annual run-rate: MRR x 12.',
    run: arrReport,
  },
  {
    key: 'gross_earnings',
    label: 'Gross earnings',
    description: 'What merchants paid in each bucket, before Shopify’s revenue share.',
    run: grossEarningsReport,
  },
  {
    key: 'mrr_growth',
    label: 'MRR growth',
    description: 'Bucket-over-bucket percentage change in MRR.',
    run: mrrGrowthReport,
  },
  {
    key: 'mrr_movement',
    label: 'MRR movement',
    description:
      'Where MRR moved inside each bucket: new, frozen, unfrozen, churned, upgraded, downgraded, and the net of them.',
    run: mrrMovementReport,
  },
  {
    key: 'mrr_by_app',
    label: 'MRR contribution by app',
    description: 'MRR split by the app that earns it.',
    run: mrrByAppReport,
  },
  {
    key: 'arpu',
    label: 'ARPU',
    description: 'MRR divided by the active paying population.',
    run: arpuReport,
  },
  {
    key: 'ltv',
    label: 'LTV',
    description: 'Predicted lifetime value: ARPU divided by the monthly churn rate.',
    run: ltvReport,
  },
  {
    key: 'trials',
    label: 'Trials',
    description: 'Trials started per bucket, split by eventual outcome.',
    run: trialsReport,
  },
  {
    key: 'trial_conversion_rate',
    label: 'Trial conversion',
    description: 'Share of decided trials that converted to a paid charge.',
    run: trialConversionReport,
  },
  {
    key: 'on_trial',
    label: 'On trial',
    description: 'Subscriptions inside their free period as-of each bucket.',
    run: onTrialReport,
  },
  {
    key: 'trialing',
    label: 'Trialing',
    description: 'Current trial subscription value grouped by expected trial end date.',
    run: trialingReport,
    comparison: false,
  },
  {
    key: 'active_subscriptions',
    label: 'Active subscriptions',
    description: 'Live paid subscriptions as-of each bucket.',
    run: activeSubscriptionsReport,
  },
  {
    key: 'subscribers',
    label: 'Subscribers',
    description: 'Shop-and-app pairs with a live paid subscription.',
    run: subscribersReport,
  },
  {
    key: 'active_installs',
    label: 'Active installs',
    description: 'Shops with the app installed, paying or not.',
    run: activeInstallsReport,
  },
  {
    key: 'new_subscriptions',
    label: 'New subscriptions',
    description: 'Subscriptions that began paying inside each bucket, excluding plan changes.',
    run: newSubscriptionsReport,
  },
  {
    key: 'subscription_growth',
    label: 'Subscription growth',
    description: 'Bucket-over-bucket percentage change in live subscriptions.',
    run: subscriptionGrowthReport,
  },
  {
    key: 'churn',
    label: 'Churn',
    description: 'Rolling-window churn rate against the start-of-window base.',
    run: churnReport,
  },
  {
    key: 'revenue_churn',
    label: 'Revenue churn',
    description: 'MRR lost in the rolling window over the MRR live at its start.',
    run: revenueChurnReport,
  },
  {
    key: 'subscription_churn',
    label: 'Subscription churn',
    description: 'Subscriptions lost in the rolling window over those live at its start.',
    run: subscriptionChurnReport,
  },
  {
    key: 'logo_churn',
    label: 'Logo churn',
    description:
      'Uninstalls net of reinstalls in the rolling window over the installs active at its start.',
    run: logoChurnReport,
  },
  {
    key: 'reviews_posted',
    label: 'Reviews',
    description: 'Reviews posted to your App Store listing in each bucket, split by rating.',
    run: reviewsPostedReport,
  },
  {
    key: 'reviews_live',
    label: 'Reviews on the listing',
    description: 'Reviews live on the listing as-of each bucket.',
    run: reviewsLiveReport,
  },
  {
    key: 'reviews_average_rating',
    label: 'Average rating',
    description: 'Mean rating of the reviews live as-of each bucket.',
    run: reviewsAverageRatingReport,
  },
  {
    key: 'reviews_removed',
    label: 'Reviews removed',
    description: 'Reviews that stopped appearing on the listing in each bucket.',
    run: reviewsRemovedReport,
  },
];

const BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]));

export function listMetrics(): Array<Omit<MetricDefinition, 'run'>> {
  return METRICS.map(({ key, label, description }) => ({ key, label, description }));
}

/**
 * Runs the same metric over the equal-length span that ends where this one
 * begins, so a card can say "up 12% on the previous 30 days" rather than
 * "up 12% on yesterday".
 *
 * The previous window is bucketed at the *same* interval as the primary one.
 * Letting it resolve its own granularity would compare a sum of daily buckets
 * against a sum of monthly ones at the boundary of the ladder.
 */
function comparisonFor(
  definition: MetricDefinition,
  query: RawMetricQuery,
  context: MetricContext,
  currentValue: number,
  now: Date | undefined,
): MetricComparison | undefined {
  const { window } = context;
  const span = window.end.getTime() - window.start.getTime();
  const previousStart = new Date(window.start.getTime() - span);

  // Before the sync floor there is no history, only absence. Comparing against
  // it would report every metric as infinite growth out of nothing.
  const floor = new Date(`${getConfig().scope.syncStartDate}T00:00:00Z`);
  if (previousStart.getTime() < floor.getTime()) return undefined;

  const previous = definition.run(
    buildContext(
      {
        ...query,
        period: 'custom',
        start: previousStart.toISOString(),
        end: window.start.toISOString(),
        interval: window.interval,
      },
      now,
    ),
  );

  const change = currentValue - previous.value;
  return {
    previousValue: previous.value,
    change: Math.round(change * 100) / 100,
    changePercent:
      previous.value === 0 ? null : Math.round((change / Math.abs(previous.value)) * 10000) / 100,
    periodStart: previous.periodStart,
    periodEnd: previous.periodEnd,
  };
}

export function runMetric(
  metricKey: string,
  query: RawMetricQuery,
  options: { now?: Date } = {},
): MetricResponse {
  const definition = BY_KEY.get(metricKey);
  if (!definition) {
    throw new MetricRequestError(
      `Unknown metric "${metricKey}". Available: ${METRICS.map((m) => m.key).join(', ')}.`,
      404,
    );
  }

  const context = buildContext(query, options.now);

  const key = cacheKey(metricKey, {
    ...query,
    nocache: undefined,
    // Resolved scope is part of the identity: "all apps" today may mean a
    // different set tomorrow.
    scope: context.appIds.join(','),
  });

  const bypass = query.nocache === '1' || query.nocache === 'true';
  if (!bypass) {
    const cached = readCache<MetricResponse>(context.db, key);
    if (cached) return cached;
  }

  const response = definition.run(context);
  const comparison =
    definition.comparison === false
      ? undefined
      : comparisonFor(definition, query, context, response.value, options.now);
  if (comparison) response.comparison = comparison;

  if (!bypass) writeCache(context.db, key, response);
  return response;
}

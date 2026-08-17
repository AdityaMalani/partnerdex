import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetEnvironment, seed, type SubscriptionFixture } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { runMetric } from '../src/metrics/registry.js';
import { stockCoverage } from '../src/metrics/stockRollup.js';
import { syncStockDaily } from '../src/sync/stockRollup.js';

/**
 * The read half: that reading the snapshots changes no metric's answer.
 *
 * The comparison is available in-process because the fallback is a real code
 * path rather than a branch left behind for tests. A database whose snapshots
 * have never been built — a fresh install, or one whose `REPORTING_TIMEZONE`
 * changed since the last sync — answers every metric out of the raw tables, the
 * slow way. So each case below runs the whole metric with the coverage withdrawn
 * and again with it restored, and requires the two responses to be identical.
 *
 * That is the same proof the production comparison makes across two checkouts,
 * done small enough to run on every commit.
 */

const NOW = new Date('2024-04-01T09:41:07.000Z');

const FIXTURES: SubscriptionFixture[] = [
  { chargeRef: 'a', shopId: '1', amount: 30, activatedAt: '2024-01-03T00:00:00Z', firstSaleAt: '2024-01-03T00:00:00Z' },
  { chargeRef: 'b', shopId: '2', amount: 50, activatedAt: '2024-01-09T11:20:00Z', firstSaleAt: '2024-01-20T09:00:00Z' },
  { chargeRef: 'c', shopId: '3', amount: 120, activatedAt: '2024-01-11T06:00:00Z', firstSaleAt: '2024-01-11T06:00:00Z', billingInterval: 'ANNUAL' },
  { chargeRef: 'd', shopId: '4', amount: 20, activatedAt: '2024-01-05T00:00:00Z', firstSaleAt: '2024-01-05T00:00:00Z', churnedAt: '2024-02-02T13:00:00Z' },
  { chargeRef: 'e', shopId: '5', amount: 45, activatedAt: '2024-01-07T00:00:00Z', firstSaleAt: '2024-01-07T00:00:00Z', frozenAt: '2024-01-25T00:00:00Z', unfrozenAt: '2024-02-14T00:00:00Z' },
  { chargeRef: 'f', shopId: '6', amount: 15, activatedAt: '2024-01-08T00:00:00Z', firstSaleAt: '2024-01-08T00:00:00Z', frozenAt: '2024-02-01T00:00:00Z' },
  { chargeRef: 'g', shopId: '7', amount: 99, activatedAt: '2024-01-12T00:00:00Z', firstSaleAt: '2024-01-12T00:00:00Z', test: true },
  { chargeRef: 'h', shopId: '1', amount: 60, activatedAt: '2024-01-18T00:00:00Z', firstSaleAt: '2024-01-18T00:00:00Z', billingInterval: 'ANNUAL' },
  { chargeRef: 'i', shopId: '8', amount: 25, activatedAt: '2024-01-14T00:00:00Z', firstSaleAt: '2024-01-14T00:00:00Z', churnedAt: '2024-01-30T10:00:00Z' },
  { chargeRef: 'j', shopId: '8', amount: 75, activatedAt: '2024-01-30T10:30:00Z', firstSaleAt: '2024-01-30T10:30:00Z' },
  { chargeRef: 'k', shopId: '9', amount: 40, activatedAt: '2024-02-05T00:00:00Z', billingOn: '2024-03-05' },
  { chargeRef: 'l', shopId: '10', amount: 240, activatedAt: '2024-02-11T04:15:00Z', firstSaleAt: '2024-02-25T04:15:00Z', billingInterval: 'ANNUAL' },
];

const INSTALLS = {
  installs: [
    { shopId: '20', at: '2024-01-04T00:00:00Z' },
    { shopId: '21', at: '2024-01-06T12:00:00Z' },
    { shopId: '22', at: '2024-01-15T00:00:00Z' },
    { shopId: '23', at: '2024-02-19T21:05:00Z' },
  ],
  uninstalls: [
    { shopId: '20', at: '2024-02-03T08:00:00Z' },
    { shopId: '22', at: '2024-01-28T00:00:00Z' },
    { shopId: '23', at: '2024-03-11T02:30:00Z' },
  ],
  reopens: [{ shopId: '22', at: '2024-02-10T00:00:00Z' }],
  closes: [{ shopId: '21', at: '2024-02-20T00:00:00Z' }],
};

/** Every metric that reads a stock, plus the ones derived from one. */
const METRIC_KEYS = [
  'mrr',
  'arr',
  'mrr_growth',
  'mrr_by_app',
  'arpu',
  'ltv',
  'on_trial',
  'trials',
  'trial_conversion_rate',
  'active_subscriptions',
  'subscribers',
  'active_installs',
  'new_subscriptions',
  'subscription_growth',
  'churn',
  'revenue_churn',
  'subscription_churn',
  'logo_churn',
];

/** The window shapes, chosen so both sides of the midnight rule are exercised. */
const SHAPES: Array<[string, Record<string, string>]> = [
  ['last_7_days', { period: 'last_7_days' }],
  ['last_30_days', { period: 'last_30_days' }],
  ['last_90_days', { period: 'last_90_days' }],
  ['last_12_months', { period: 'last_12_months' }],
  ['year_to_date', { period: 'year_to_date' }],
  ['all_time', { period: 'all_time' }],
  // Every bucket boundary is an hour, so nothing is a midnight and every read
  // takes the raw path. It has to come back with the same numbers anyway.
  ['hourly', { period: 'last_7_days', interval: 'hour' }],
  ['weekly', { period: 'last_90_days', interval: 'week' }],
  ['daily', { period: 'last_12_months', interval: 'day' }],
  ['monthly', { period: 'last_90_days', interval: 'month' }],
  ['custom-midday', { period: 'custom', start: '2024-01-11T13:47:19Z', end: '2024-03-02T09:12:53Z' }],
  ['custom-future-end', { period: 'custom', start: '2024-02-01T00:00:00Z', end: '2024-12-01T00:00:00Z' }],
];

/** The four combinations of the two as-of flags, and the two population bases. */
const FLAGS: Array<[string, Record<string, string>]> = [
  ['annual+trials', { includeAnnual: 'true', includeTrials: 'true' }],
  ['annual-only', { includeAnnual: 'true', includeTrials: 'false' }],
  ['trials-only', { includeAnnual: 'false', includeTrials: 'true' }],
  ['neither', { includeAnnual: 'false', includeTrials: 'false' }],
  ['by-shop', { byShop: 'true' }],
];

/** Withdraw the coverage without deleting a row, which is the cold-database state. */
function withoutSnapshots(): void {
  getDb().prepare(`DELETE FROM sync_state WHERE key LIKE 'rollup:stock_daily%'`).run();
  assert.equal(stockCoverage(getDb()).ready, false);
}

function withSnapshots(): void {
  syncStockDaily(getDb(), { full: true });
  assert.equal(stockCoverage(getDb()).ready, true);
}

function sweep(cases: Array<[string, Record<string, string>]>): number {
  const raw = new Map<string, string>();
  withoutSnapshots();
  for (const [label, query] of cases) {
    for (const key of METRIC_KEYS) {
      raw.set(
        `${key}@${label}`,
        JSON.stringify(runMetric(key, { ...query, nocache: 'true' }, { now: NOW })),
      );
    }
  }

  withSnapshots();
  let compared = 0;
  for (const [label, query] of cases) {
    for (const key of METRIC_KEYS) {
      const name = `${key}@${label}`;
      const rolled = JSON.stringify(runMetric(key, { ...query, nocache: 'true' }, { now: NOW }));
      assert.equal(rolled, raw.get(name), `${name} differs`);
      compared += 1;
    }
  }
  return compared;
}

describe('reading the snapshots changes no answer', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  it('across every window shape', () => {
    seed(FIXTURES, INSTALLS);
    assert.ok(sweep(SHAPES) >= METRIC_KEYS.length * SHAPES.length);
  });

  it('across every combination of the as-of flags', () => {
    seed(FIXTURES, INSTALLS);
    const cases = FLAGS.flatMap(([label, flags]) =>
      [
        ['last_12_months', { period: 'last_12_months' }],
        ['last_30_days', { period: 'last_30_days' }],
        ['all_time', { period: 'all_time' }],
      ].map(
        ([window, query]) =>
          [`${label}/${window as string}`, { ...(query as Record<string, string>), ...flags }] as [
            string,
            Record<string, string>,
          ],
      ),
    );
    assert.ok(sweep(cases) >= METRIC_KEYS.length * cases.length);
  });

  it('in a timezone with a DST transition inside the window', () => {
    resetEnvironment({ METRICS_INCLUDE_USAGE: 'true', REPORTING_TIMEZONE: 'America/New_York' });
    seed(FIXTURES, INSTALLS);
    // 2024-03-10 is a 23-hour day in New York, and it sits inside every window
    // below. The snapshot for the 11th is taken an hour earlier in UTC than the
    // 10th's was, which is exactly the case a UTC-keyed table would get wrong.
    sweep([
      ['dst-daily', { period: 'custom', start: '2024-03-01T00:00:00Z', end: '2024-03-20T00:00:00Z', interval: 'day' }],
      ['dst-months', { period: 'last_12_months' }],
    ]);
  });

  it('after a backdated cancellation has been repaired into the snapshots', () => {
    seed(FIXTURES, INSTALLS);
    const db = getDb();
    withSnapshots();
    db.prepare(`UPDATE subscriptions SET churn_at = '2024-01-22T00:00:00Z' WHERE charge_ref = 'a'`).run();
    // The repair is the sync's, not a reader's: nothing has read the tables
    // between the correction landing and this call.
    syncStockDaily(db);
    sweep([['after-restatement', { period: 'last_12_months' }]]);
  });

  it('on a database whose subscriptions are empty', () => {
    seed([], INSTALLS);
    sweep([['empty', { period: 'last_12_months' }]]);
  });
});

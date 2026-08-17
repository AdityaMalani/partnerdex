import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { APP_ID, pointAt, resetEnvironment, seed, seedForApp } from './helpers.js';
import { runMetric } from '../src/metrics/registry.js';
import { monthlyAmountFor } from '../src/sync/derive.js';
import { autoInterval, resolveWindow } from '../src/metrics/time.js';
import { getDb } from '../src/db/index.js';
import { listCustomers } from '../src/customers/index.js';
import { transactionVariables } from '../src/sync/index.js';
import {
  computeCurrencyProfile,
  currencyProfile,
  currencyProfileKey,
  warmCurrencyProfiles,
} from '../src/metrics/context.js';

const NOW = new Date('2024-07-01T00:00:00.000Z');

const monthly = { period: 'last_12_months', interval: 'month', end: '2024-06-30' };

describe('cadence normalization (spec 7.2)', () => {
  it('spreads an annual plan across twelve months', () => {
    assert.equal(monthlyAmountFor(1200, 'ANNUAL'), 100);
  });

  it('passes a 30-day plan through untouched', () => {
    assert.equal(monthlyAmountFor(49, 'EVERY_30_DAYS'), 49);
  });

  it('treats a zero or negative amount as no revenue', () => {
    assert.equal(monthlyAmountFor(0, 'EVERY_30_DAYS'), 0);
    assert.equal(monthlyAmountFor(-10, 'ANNUAL'), 0);
  });
});

describe('as-of MRR reconstruction (spec 7.1)', () => {
  beforeEach(() => resetEnvironment());

  it('counts a subscription from its first paid charge until it churns', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-01'), 0, 'not yet live in January');
    assert.equal(pointAt(response, '2024-02'), 50, 'live from February');
    assert.equal(pointAt(response, '2024-05'), 50, 'still live in May');
  });

  it('rewrites history when a cancellation is backdated', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        churnedAt: '2024-04-10T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-03'), 50, 'live before the cancellation');
    assert.equal(pointAt(response, '2024-04'), 0, 'gone from the month it cancelled');
    assert.equal(pointAt(response, '2024-05'), 0);
  });

  it('sums an annual plan at a twelfth of its price', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
    ]);

    assert.equal(pointAt(runMetric('mrr', monthly, { now: NOW }), '2024-03'), 100);
  });

  it('excludes annual plans entirely when includeAnnual is off', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 30,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', { ...monthly, includeAnnual: 'false' }, { now: NOW });
    assert.equal(pointAt(response, '2024-03'), 30);
  });

  it('excludes test subscriptions', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 99,
        test: true,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
    ]);

    assert.equal(pointAt(runMetric('mrr', monthly, { now: NOW }), '2024-03'), 0);
  });

  it('drops a frozen subscription to zero and restores it on unfreeze', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 60,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
        frozenAt: '2024-03-01T00:00:00Z',
        unfrozenAt: '2024-05-01T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-02'), 60);
    assert.equal(pointAt(response, '2024-03'), 0, 'frozen contributes nothing');
    assert.equal(pointAt(response, '2024-04'), 0);
    assert.equal(pointAt(response, '2024-05'), 60, 'restored after unfreeze');
  });

  it('ends a subscription when the merchant uninstalls the app', () => {
    seed(
      [
        {
          chargeRef: '1',
          shopId: '10',
          amount: 40,
          activatedAt: '2024-01-05T00:00:00Z',
          firstSaleAt: '2024-01-05T00:00:00Z',
        },
      ],
      { uninstalls: [{ shopId: '10', at: '2024-04-02T00:00:00Z' }] },
    );

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-03'), 40);
    assert.equal(pointAt(response, '2024-04'), 0);
  });
});

describe('uninstalls, reinstalls and settlement lag', () => {
  beforeEach(() => resetEnvironment());

  it('keeps a subscription alive when the shop reinstalls and keeps paying', () => {
    // The regression that under-counted paying shops: an uninstall mid-history
    // used to churn the subscription permanently, ignoring both the reinstall
    // and every payment that followed.
    seed(
      [
        {
          chargeRef: '1',
          shopId: '10',
          amount: 29,
          activatedAt: '2024-01-05T00:00:00Z',
          firstSaleAt: '2024-01-05T00:00:00Z',
          extraSales: [
            { at: '2024-04-05T00:00:00Z', gross: 29 },
            { at: '2024-05-05T00:00:00Z', gross: 29 },
          ],
        },
      ],
      {
        installs: [
          { shopId: '10', at: '2024-01-01T00:00:00Z' },
          { shopId: '10', at: '2024-02-10T00:00:00Z' },
        ],
        uninstalls: [{ shopId: '10', at: '2024-02-01T00:00:00Z' }],
      },
    );

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-02'), 29, 'reinstalled inside the month');
    assert.equal(pointAt(response, '2024-05'), 29, 'still paying months later');
  });

  it('ends a subscription at an uninstall the shop never returned from', () => {
    seed(
      [
        {
          chargeRef: '1',
          shopId: '10',
          amount: 29,
          activatedAt: '2024-01-05T00:00:00Z',
          firstSaleAt: '2024-01-05T00:00:00Z',
        },
      ],
      {
        installs: [{ shopId: '10', at: '2024-01-01T00:00:00Z' }],
        uninstalls: [{ shopId: '10', at: '2024-03-02T00:00:00Z' }],
      },
    );

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-02'), 29);
    assert.equal(pointAt(response, '2024-03'), 0);
  });

  it('does not resurrect a cancelled subscription because its last sale settled late', () => {
    // Partner transactions carry the date they landed in a payout batch, so a
    // final sale routinely posts days after the cancellation.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 29,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
        churnedAt: '2024-03-05T00:00:00Z',
        extraSales: [{ at: '2024-03-14T00:00:00Z', gross: 29 }],
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-02'), 29);
    assert.equal(pointAt(response, '2024-03'), 0, 'cancelled, despite the trailing transaction');
  });

  it('counts a converted trial whose first charge has not settled yet', () => {
    // Activated, trial ended, no cancellation, and no transaction recorded yet.
    // Without the billing-date fallback every recent conversion reads as unpaid.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 29,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2024-05-15T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-05'), 29, 'paying from its billing date');
  });

  it('still treats a subscription inside its trial as unpaid', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 29,
        activatedAt: '2024-06-25T00:00:00Z',
        billingOn: '2024-07-09T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-06'), 0, 'trial has not ended at NOW');
  });
});

describe('trial gating (spec 7.12)', () => {
  beforeEach(() => resetEnvironment());

  it('keeps an unconverted trial out of MRR but counts it when trials are included', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 80,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-02-15T00:00:00Z',
      },
    ]);

    const excluded = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(excluded, '2024-02'), 80, 'converted mid-February, live at month end');

    const included = runMetric('mrr', { ...monthly, includeTrials: 'true' }, { now: NOW });
    assert.equal(pointAt(included, '2024-02'), 80);
  });

  it('splits trials into converted and cancelled, and rates only decided ones', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 80,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-15T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 80,
        activatedAt: '2024-03-02T00:00:00Z',
        churnedAt: '2024-03-10T00:00:00Z',
      },
      {
        chargeRef: '3',
        shopId: '12',
        amount: 80,
        activatedAt: '2024-03-03T00:00:00Z',
        churnedAt: '2024-03-11T00:00:00Z',
      },
    ]);

    const response = runMetric('trials', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-03'), 3, 'three trials began in March');
    assert.equal(response.meta?.converted, 1);
    assert.equal(response.meta?.canceled, 2);
    assert.equal(response.meta?.conversionRate, 33.33);
  });

  it('does not call an immediate paid charge a trial', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 80,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T06:00:00Z',
      },
    ]);

    const response = runMetric('trials', monthly, { now: NOW });
    assert.equal(response.value, 0, 'no gap means no trial');
  });
});

describe('reading billing_on correctly', () => {
  beforeEach(() => resetEnvironment());

  it('treats a full-cycle billing date as paid at activation, not a trial', () => {
    // billing_on is the NEXT billing date. A full cycle away means the merchant
    // already paid; only a part-cycle gap is a trial.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 29,
        activatedAt: '2024-05-02T11:13:37Z',
        billingOn: '2024-06-01T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-05'), 29, 'paying from activation');
    assert.equal(runMetric('trials', monthly, { now: NOW }).value, 0, 'not a trial');
  });

  it('still reads a part-cycle billing date as a trial', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 29,
        activatedAt: '2024-06-25T10:24:36Z',
        billingOn: '2024-07-09T00:00:00Z',
      },
    ]);

    assert.equal(pointAt(runMetric('mrr', monthly, { now: NOW }), '2024-06'), 0, 'trial earns nothing');
  });

  it('treats a mid-cycle plan change as paying, not as a new trial', () => {
    // Upgrading mid-cycle creates a new charge whose billing_on is whatever
    // remained of the cycle the merchant already paid for.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 19,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
        churnedAt: '2024-05-10T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '10',
        amount: 49,
        activatedAt: '2024-05-10T00:00:00Z',
        billingOn: '2024-05-21T00:00:00Z',
      },
    ]);

    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-05'), 49, 'continues paying on the new plan');
    assert.equal(runMetric('trials', monthly, { now: NOW }).value, 0, 'a plan change is not a trial');
  });
});

describe('summaries, edge buckets and guards', () => {
  beforeEach(() => resetEnvironment());

  it('summarizes a stock metric to its last point and a flow metric to its sum', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
        extraSales: [
          { at: '2024-02-05T00:00:00Z', gross: 100 },
          { at: '2024-03-05T00:00:00Z', gross: 100 },
        ],
      },
    ]);

    const mrr = runMetric('mrr', monthly, { now: NOW });
    assert.equal(mrr.value, 100, 'MRR is a level, not a total');

    const earnings = runMetric('gross_earnings', monthly, { now: NOW });
    assert.equal(earnings.value, 300, 'earnings accumulate across the range');
  });

  it('uses the hidden leading bucket for the first visible delta and hides it', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 25,
        activatedAt: '2023-01-01T00:00:00Z',
        firstSaleAt: '2023-01-01T00:00:00Z',
      },
    ]);

    const response = runMetric(
      'mrr',
      { period: 'last_90_days', interval: 'month', end: '2024-06-30' },
      { now: NOW },
    );
    const first = response.timeSeries[0]!;
    assert.equal(first.change, 0, 'the baseline exists, so the first change is real');
    assert.ok(
      new Date(first.periodStart) >= new Date(response.periodStart),
      'the leading bucket is not returned',
    );
  });

  it('returns a full envelope with zeroes when there is no data', () => {
    seed([]);
    const response = runMetric('mrr', monthly, { now: NOW });
    assert.equal(response.value, 0);
    assert.ok(Array.isArray(response.timeSeries));
    assert.ok(response.timeSeries.length > 0);
  });

  it('reports ARPU as zero rather than NaN when nobody is paying', () => {
    seed([]);
    const response = runMetric('arpu', monthly, { now: NOW });
    assert.equal(response.value, 0);
    assert.ok(response.timeSeries.every((point) => Number.isFinite(point.value)));
  });

  it('guards LTV when no one churned in the window', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
    ]);

    const response = runMetric('ltv', monthly, { now: NOW });
    assert.ok(response.timeSeries.every((point) => Number.isFinite(point.value)));
    assert.ok((response.meta?.bucketsWithoutChurn as number) > 0);
  });

  it('divides MRR by the population to get ARPU', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 50,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
    ]);

    assert.equal(pointAt(runMetric('arpu', monthly, { now: NOW }), '2024-03'), 75);
    assert.equal(pointAt(runMetric('active_subscriptions', monthly, { now: NOW }), '2024-03'), 2);
  });
});

describe('subscribers count shop-and-app pairs', () => {
  beforeEach(() => resetEnvironment({ PARTNER_APP_IDS: '', METRICS_BY_SHOP: 'true' }));

  it('counts one merchant on two apps as two subscribers', () => {
    const db = getDb();
    const events = [111, 222].map((appId, index) => ({
      appId: String(appId),
      chargeRef: String(index + 1),
    }));
    for (const { appId, chargeRef } of events) {
      seedForApp(appId, chargeRef);
    }

    // Both charges belong to the same shop, on different apps.
    const response = runMetric('subscribers', monthly, { now: NOW });
    assert.equal(pointAt(response, '2024-03'), 2, 'one shop, two apps, two subscribers');
    assert.equal(
      db.prepare('SELECT COUNT(DISTINCT shop_id) n FROM subscriptions').get().n,
      1,
      'still a single shop',
    );
  });
});

describe('churn (spec 7.9)', () => {
  beforeEach(() => resetEnvironment());

  it('measures churn against the population at the window start', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-03-20T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
      {
        chargeRef: '3',
        shopId: '12',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
      {
        chargeRef: '4',
        shopId: '13',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
    ]);

    // The March bucket ends 2024-04-01; its rolling window opens 2024-03-02,
    // when all four were live. One left inside the window.
    assert.equal(pointAt(runMetric('churn', monthly, { now: NOW }), '2024-03'), 25);
  });

  it('does not count an upgrade as churn', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 20,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-03-15T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '10',
        amount: 80,
        activatedAt: '2024-03-15T00:00:00Z',
        firstSaleAt: '2024-03-15T00:00:00Z',
      },
    ]);

    const churn = runMetric('churn', monthly, { now: NOW });
    assert.equal(pointAt(churn, '2024-03'), 0, 'the shop replaced its plan, it did not leave');

    const mrr = runMetric('mrr', monthly, { now: NOW });
    assert.equal(pointAt(mrr, '2024-03'), 80, 'MRR follows the new plan');
  });

  it('reports zero churn rather than dividing by an empty base', () => {
    seed([]);
    const response = runMetric('churn', monthly, { now: NOW });
    assert.ok(response.timeSeries.every((point) => point.value === 0));
  });

  it('separates the money lost from the customers who left', () => {
    // Two shops, one paying twice as much as the other. The expensive one goes.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-03-20T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
    ]);

    assert.equal(
      pointAt(runMetric('subscription_churn', monthly, { now: NOW }), '2024-03'),
      50,
      'one of two subscriptions left',
    );
    assert.equal(
      pointAt(runMetric('revenue_churn', monthly, { now: NOW }), '2024-03'),
      66.67,
      'but it carried two thirds of the MRR',
    );
  });

  it('does not count a second subscription from the same shop as a lost logo', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-03-20T00:00:00Z',
      },
    ]);
    // A second app for the same shop makes it two subscribers but one shop, so
    // the two bases differ; see the subscriber definition in asof.ts.
    seedForApp('222', '2', '10');

    assert.equal(
      pointAt(runMetric('subscription_churn', monthly, { now: NOW }), '2024-03'),
      100,
      'the only in-scope subscription ended',
    );
  });

  // Spec 4.7: (uninstalls − reinstalls) / active installs at the window start.
  // Logo churn reads the install ledger, which is what stops it from being a
  // second copy of subscription churn.
  it('divides uninstalls by installs, not by subscriptions', () => {
    seed(
      [
        {
          chargeRef: '1',
          shopId: '10',
          amount: 50,
          activatedAt: '2024-01-01T00:00:00Z',
          firstSaleAt: '2024-01-01T00:00:00Z',
          churnedAt: '2024-03-20T00:00:00Z',
        },
      ],
      {
        // Four shops installed; only shop 10 ever paid, and only shop 11 left.
        installs: [
          { shopId: '10', at: '2024-01-01T00:00:00Z' },
          { shopId: '11', at: '2024-01-01T00:00:00Z' },
          { shopId: '12', at: '2024-01-01T00:00:00Z' },
          { shopId: '13', at: '2024-01-01T00:00:00Z' },
        ],
        uninstalls: [{ shopId: '11', at: '2024-03-20T00:00:00Z' }],
      },
    );

    assert.equal(
      pointAt(runMetric('subscription_churn', monthly, { now: NOW }), '2024-03'),
      100,
      'the only subscription ended',
    );
    assert.equal(
      pointAt(runMetric('logo_churn', monthly, { now: NOW }), '2024-03'),
      25,
      'one of four active installs left, and the paying shop kept the app',
    );
  });

  it('nets a reinstall off the uninstall it reverses', () => {
    seed([], {
      installs: [
        { shopId: '10', at: '2024-01-01T00:00:00Z' },
        { shopId: '11', at: '2024-01-01T00:00:00Z' },
        { shopId: '12', at: '2024-01-01T00:00:00Z' },
        { shopId: '13', at: '2024-01-01T00:00:00Z' },
        // Shop 11 comes back inside the same rolling window it left in.
        { shopId: '11', at: '2024-03-25T00:00:00Z' },
      ],
      uninstalls: [
        { shopId: '11', at: '2024-03-20T00:00:00Z' },
        { shopId: '12', at: '2024-03-21T00:00:00Z' },
      ],
    });

    assert.equal(
      pointAt(runMetric('logo_churn', monthly, { now: NOW }), '2024-03'),
      25,
      'two left, one returned, over four active at the window start',
    );
  });

  it('reports zero logo churn when nothing was installed at the window start', () => {
    seed([], { installs: [{ shopId: '10', at: '2024-05-02T00:00:00Z' }] });

    assert.equal(pointAt(runMetric('logo_churn', monthly, { now: NOW }), '2024-01'), 0);
  });
});

describe('growth, inflow and live trials', () => {
  beforeEach(() => resetEnvironment());

  const twoShops = [
    {
      chargeRef: '1',
      shopId: '10',
      amount: 100,
      activatedAt: '2024-02-01T00:00:00Z',
      firstSaleAt: '2024-02-01T00:00:00Z',
    },
    {
      chargeRef: '2',
      shopId: '11',
      amount: 50,
      activatedAt: '2024-03-01T00:00:00Z',
      firstSaleAt: '2024-03-01T00:00:00Z',
    },
  ];

  it('derives MRR growth from the MRR series it describes', () => {
    seed(twoShops);
    // March opens at 100 and closes at 150.
    assert.equal(pointAt(runMetric('mrr_growth', monthly, { now: NOW }), '2024-03'), 50);
  });

  it('reports zero growth rather than infinity when the base is empty', () => {
    seed(twoShops);
    const growth = runMetric('mrr_growth', monthly, { now: NOW });
    assert.equal(pointAt(growth, '2024-02'), 0, 'February grew out of nothing');
    assert.ok((growth.meta?.bucketsWithoutBase as number) > 0, 'and says so in meta');
  });

  it('credits a new subscription to the bucket it starts paying in', () => {
    seed(twoShops);
    const created = runMetric('new_subscriptions', monthly, { now: NOW });
    assert.equal(pointAt(created, '2024-02'), 1);
    assert.equal(pointAt(created, '2024-03'), 1);
    assert.equal(pointAt(created, '2024-04'), 0);
    assert.equal(created.value, 2, 'a flow sums across the window');
  });

  it('does not count a plan change as a new subscription', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 20,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        churnedAt: '2024-03-15T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '10',
        amount: 80,
        activatedAt: '2024-03-15T00:00:00Z',
        firstSaleAt: '2024-03-15T00:00:00Z',
      },
    ]);

    assert.equal(pointAt(runMetric('new_subscriptions', monthly, { now: NOW }), '2024-03'), 0);
  });

  it('counts a trial only while it is actually running', () => {
    // Activated 1 February, first paid charge 20 March: trialling in between.
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-03-20T00:00:00Z',
      },
    ]);

    const onTrial = runMetric('on_trial', monthly, { now: NOW });
    assert.equal(pointAt(onTrial, '2024-01'), 0, 'not yet activated');
    assert.equal(pointAt(onTrial, '2024-02'), 1, 'inside the free period');
    assert.equal(pointAt(onTrial, '2024-03'), 0, 'the charge landed, so it is a customer now');
  });
});

describe('period-over-period comparison', () => {
  beforeEach(() => resetEnvironment());

  it('compares against the equal-length span before the window', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        extraSales: [
          { at: '2024-05-15T00:00:00Z', gross: 100 },
          { at: '2024-06-15T00:00:00Z', gross: 150 },
        ],
      },
    ]);

    // The window runs 1 June to 1 July, so the comparison runs 2 May to 1 June:
    // one sale of 150 in the current span against one of 100 in the previous.
    const earnings = runMetric(
      'gross_earnings',
      { period: 'last_30_days', end: '2024-06-30' },
      { now: NOW },
    );

    assert.equal(earnings.value, 150);
    assert.equal(earnings.comparison?.previousValue, 100);
    assert.equal(earnings.comparison?.change, 50);
    assert.equal(earnings.comparison?.changePercent, 50);
  });

  it('offers no percentage when the previous period was empty', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-05-01T00:00:00Z',
        firstSaleAt: '2024-05-01T00:00:00Z',
      },
    ]);

    const earnings = runMetric(
      'gross_earnings',
      { period: 'last_30_days', end: '2024-05-15' },
      { now: NOW },
    );
    assert.equal(earnings.comparison?.previousValue, 0);
    assert.equal(earnings.comparison?.changePercent, null, 'no finite growth out of nothing');
  });

  it('does not compare against history that predates the sync floor', () => {
    seed([]);
    const response = runMetric('mrr', { period: 'all_time' }, { now: NOW });
    assert.equal(response.comparison, undefined);
  });
});

describe('scope and access', () => {
  beforeEach(() => resetEnvironment());

  it('rejects a request for an app outside the configured scope', () => {
    seed([]);
    assert.throws(
      () => runMetric('mrr', { ...monthly, appIds: '424242' }, { now: NOW }),
      /outside the configured reporting scope/,
    );
  });

  it('accepts an app that is in scope', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 10,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
    ]);
    const response = runMetric('mrr', { ...monthly, appIds: APP_ID }, { now: NOW });
    assert.equal(response.value, 10);
  });

  it('rejects an unknown metric and an invalid period', () => {
    seed([]);
    assert.throws(() => runMetric('nonsense', monthly, { now: NOW }), /Unknown metric/);
    assert.throws(() => runMetric('mrr', { period: 'last_decade' }, { now: NOW }), /Unknown period/);
  });
});

describe('Partner API request shape', () => {
  it('omits appId entirely when reporting on every app', () => {
    const variables = transactionVariables(null, '2015-01-01T00:00:00.000Z', ['APP_SUBSCRIPTION_SALE']);
    // Not `appId: null` — the Partner API turns that into an empty string and
    // answers "Invalid GID ''".
    assert.equal('appId' in variables, false);
    assert.equal(variables.createdAtMin, '2015-01-01T00:00:00.000Z');
  });

  it('sends a full gid when scoped to one app', () => {
    const variables = transactionVariables('1234', '2015-01-01T00:00:00.000Z', ['APP_SUBSCRIPTION_SALE']);
    assert.equal(variables.appId, 'gid://partners/App/1234');
  });
});

describe('period resolution', () => {
  it('follows one range-to-interval ladder', () => {
    const day = new Date('2024-01-02T00:00:00Z');
    assert.equal(autoInterval(new Date('2024-01-01T00:00:00Z'), day), 'day');
    assert.equal(autoInterval(new Date('2023-12-10T00:00:00Z'), day), 'day');
    // 90 days is the last rung of "daily"; a day past it is monthly.
    assert.equal(autoInterval(new Date('2023-10-04T00:00:00Z'), day), 'day');
    assert.equal(autoInterval(new Date('2023-10-03T00:00:00Z'), day), 'month');
    assert.equal(autoInterval(new Date('2023-01-01T00:00:00Z'), day), 'month');
  });

  it('anchors a preset range on the as-of date', () => {
    const window = resolveWindow({
      period: 'last_30_days',
      end: '2022-05-20',
      timeZone: 'UTC',
      allTimeStart: '2020-01-01',
      now: new Date('2024-07-01T00:00:00Z'),
    });
    assert.equal(window.end.toISOString().slice(0, 10), '2022-05-21', 'end of the requested day');
    assert.equal(window.start.toISOString().slice(0, 10), '2022-04-21');
  });

  it('clamps a future end date back to now', () => {
    const now = new Date('2024-07-01T00:00:00Z');
    const window = resolveWindow({
      period: 'last_7_days',
      end: '2030-01-01',
      timeZone: 'UTC',
      allTimeStart: '2020-01-01',
      now,
    });
    assert.equal(window.end.getTime(), now.getTime());
  });
});

describe('as-of history is reconstructed, not stored', () => {
  beforeEach(() => resetEnvironment());

  it('gives the same past value whether asked today or anchored back then', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 70,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 30,
        activatedAt: '2024-05-01T00:00:00Z',
        firstSaleAt: '2024-05-01T00:00:00Z',
      },
    ]);

    const today = runMetric('mrr', monthly, { now: NOW });
    const backThen = runMetric(
      'mrr',
      { period: 'last_12_months', interval: 'month', end: '2024-03-31' },
      { now: NOW },
    );

    assert.equal(pointAt(today, '2024-03'), 70);
    assert.equal(backThen.value, 70, 'the March view knows nothing about the May signup');
  });

  it('keeps derived tables consistent with their source events', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
    ]);

    const row = getDb()
      .prepare('SELECT monthly_amount AS m, billing_interval AS i FROM subscriptions')
      .get() as { m: number; i: string };
    assert.equal(row.i, 'ANNUAL');
    assert.equal(row.m, 100);
  });
});

/**
 * Shopify models a plan change as *cancel one charge, activate another*, and
 * carries any unused trial days onto the new charge. Whether that replacement
 * is already earning depends entirely on whether the merchant had ever paid.
 */
describe('a plan change that lands mid-trial', () => {
  beforeEach(() => resetEnvironment());

  const stateOf = (chargeRef: string) =>
    getDb()
      .prepare(
        `SELECT trial_status AS trial, conversion_at AS conversion, ROUND(monthly_amount, 2) AS mrr
         FROM subscriptions WHERE charge_ref = ?`,
      )
      .get(chargeRef) as { trial: string; conversion: string | null; mrr: number };

  /**
   * `derive` reads the wall clock to decide whether a billing date has passed,
   * so a trial that is still open has to be dated against the same clock. Fixed
   * 2024 dates would describe a trial that ended two years ago.
   */
  const daysFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();

  it('keeps a merchant who switched plans inside their trial on trial', () => {
    seed([
      // A 14-day trial, never billed, abandoned on day 7 for another plan.
      {
        chargeRef: 'trial',
        shopId: '10',
        amount: 14,
        activatedAt: daysFromNow(-7),
        billingOn: daysFromNow(7),
        churnedAt: daysFromNow(-0.01),
      },
      // Shopify carries the unused trial days across, so the replacement bills
      // on the date the *original* trial would have ended.
      {
        chargeRef: 'switched',
        shopId: '10',
        amount: 140,
        activatedAt: daysFromNow(-0.009),
        billingOn: daysFromNow(7),
      },
    ]);

    const row = stateOf('switched');
    assert.equal(row.trial, 'in_trial', 'still trialling — nothing has been billed');
    assert.equal(row.conversion, null, 'and so contributes nothing to MRR');
    assert.equal(
      listCustomers({ search: 's10.example' }).customers[0]!.status,
      'trialing',
      'the merchant reads as trialing, not paying',
    );
    assert.equal(runMetric('mrr', { period: 'last_12_months', interval: 'month' }).value, 0);
  });

  it('still credits a merchant who upgrades a plan they were already paying for', () => {
    seed([
      {
        chargeRef: 'paid',
        shopId: '11',
        amount: 30,
        activatedAt: daysFromNow(-60),
        firstSaleAt: daysFromNow(-60),
        churnedAt: daysFromNow(-0.01),
      },
      // Mid-cycle upgrade: the days already paid for make the billing gap look
      // short, but this merchant has been paying for two months.
      {
        chargeRef: 'upgrade',
        shopId: '11',
        amount: 60,
        activatedAt: daysFromNow(-0.009),
        billingOn: daysFromNow(12),
      },
    ]);

    const row = stateOf('upgrade');
    assert.equal(row.trial, 'none', 'no trial — they are mid-cycle on a paid plan');
    assert.ok(row.conversion !== null, 'and they keep earning through the change');
    assert.equal(
      listCustomers({ search: 's11.example' }).customers[0]!.status,
      'paying',
    );
    assert.equal(runMetric('mrr', { period: 'last_12_months', interval: 'month' }).value, 60);
  });
});

/**
 * Only `AppSubscriptionSale.billingInterval` states a cadence, and it arrives
 * with the payout batch rather than the activation. Everything here is about the
 * window in between, where an annual charge that is assumed monthly is counted
 * at twelve times its worth.
 */
describe('billing cadence before the first sale settles', () => {
  beforeEach(() => resetEnvironment());

  const intervalOf = (chargeRef: string) =>
    getDb()
      .prepare(
        'SELECT billing_interval AS i, monthly_amount AS m FROM subscriptions WHERE charge_ref = ?',
      )
      .get(chargeRef) as { i: string; m: number };

  it('reads the cadence off a price point a settled sale already identified', () => {
    seed([
      // The app's annual price point, proven by a sale that has landed.
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      // Same plan, same price, no sale yet: annual, not $1200/mo.
      {
        chargeRef: '2',
        shopId: '11',
        amount: 1200,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2024-05-15T00:00:00Z',
      },
    ]);

    const row = intervalOf('2');
    assert.equal(row.i, 'ANNUAL');
    assert.equal(row.m, 100);
  });

  it('does not read a monthly charge as annual just because a pricier annual plan exists', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 120,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2024-05-15T00:00:00Z',
      },
    ]);

    const row = intervalOf('2');
    assert.equal(row.i, 'EVERY_30_DAYS', 'a price the book has never seen stays on the default');
    assert.equal(row.m, 120);
  });

  it('abstains where the same price point has been billed both ways', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      {
        chargeRef: '2',
        shopId: '11',
        amount: 1200,
        billingInterval: 'EVERY_30_DAYS',
        activatedAt: '2024-02-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
      {
        chargeRef: '3',
        shopId: '12',
        amount: 1200,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2024-05-15T00:00:00Z',
      },
    ]);

    assert.equal(intervalOf('3').i, 'EVERY_30_DAYS', 'an ambiguous price point teaches nothing');
  });

  it('reads a billing date a year out as annual, with no price point to learn from', () => {
    seed([
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2025-05-01T00:00:00Z',
      },
    ]);

    const row = intervalOf('1');
    assert.equal(row.i, 'ANNUAL');
    assert.equal(row.m, 100);
  });

  it('holds an annual upgrade to a twelfth of its price on the day it activates', () => {
    seed([
      // The price point, learned from another shop.
      {
        chargeRef: '1',
        shopId: '10',
        amount: 1200,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
      },
      // A shop on the monthly plan...
      {
        chargeRef: '2',
        shopId: '11',
        amount: 120,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
        churnedAt: '2024-05-01T00:00:00Z',
      },
      // ...moving to annual. The cancel and the activation share an instant, so
      // this is billed at activation and gated into MRR immediately — which is
      // exactly why its cadence has to be right before the sale settles.
      {
        chargeRef: '3',
        shopId: '11',
        amount: 1200,
        activatedAt: '2024-05-01T00:00:00Z',
        billingOn: '2025-05-01T00:00:00Z',
      },
    ]);

    assert.equal(intervalOf('3').m, 100);
    assert.equal(
      pointAt(runMetric('mrr', monthly, { now: NOW }), '2024-05'),
      200,
      'the upgrading shop contributes 100, not 1200, alongside the annual shop',
    );
  });
});

/**
 * The currency profile is the one part of building a metric context that reads
 * the whole transactions table, so it is cached and warmed by the sync. Two
 * paths to one answer means the answer has to be the same on both — a warm
 * pass that disagreed with the scan would silently relabel every figure on the
 * dashboard.
 */
describe('currency profile: cached, warmed, and identical either way', () => {
  beforeEach(() => {
    resetEnvironment({ CACHE_TTL_SECONDS: '600' });
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 30,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
      },
    ]);
  });

  it('warms the same answer the scan would compute', () => {
    const db = getDb();
    const scanned = computeCurrencyProfile(db, [APP_ID]);

    db.prepare('DELETE FROM metric_cache').run();
    warmCurrencyProfiles(db, [APP_ID]);

    // Read through the cache: this must be the warmed row, not a recomputation.
    assert.deepEqual(currencyProfile(db, [APP_ID]), scanned);
    // One entry per distinct warmed scope. With a single app in scope, "every
    // app" and "that app" are the same set and therefore the same entry.
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM metric_cache').get() as { n: number }).n,
      1,
    );
  });

  it('answers correctly with an empty cache, and fills it', () => {
    const db = getDb();
    db.prepare('DELETE FROM metric_cache').run();

    const first = currencyProfile(db, [APP_ID]);
    assert.equal(first.currency, 'USD');
    assert.equal(first.mixed, false);

    // Poison the stored entry: if the second call still says USD, it never
    // reached the cache at all and the caching is doing nothing.
    db.prepare('UPDATE metric_cache SET payload = ? WHERE key = ?').run(
      JSON.stringify({ currency: 'EUR', mixed: true }),
      currencyProfileKey([APP_ID]),
    );
    assert.equal(currencyProfile(db, [APP_ID]).currency, 'EUR');
  });
});

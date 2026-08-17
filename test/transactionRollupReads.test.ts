import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { APP_GID, resetEnvironment } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { insertTransactions, type TransactionNode } from '../src/sync/ingest.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { splitBuckets, toHalfOpen } from '../src/metrics/rollup.js';
import { dayKeyOf, dayKeyStart, resolveWindow } from '../src/metrics/time.js';
import { runMetric } from '../src/metrics/registry.js';
import { computeCurrencyProfile } from '../src/metrics/context.js';

/**
 * The read half of the rollup's claim: every window a metric can ask about is
 * cut into whole rollup days plus its sub-day remainders, and reassembling it
 * that way gives the number the raw table gives.
 */

const NOW = new Date('2024-07-01T00:00:00.000Z');

function sale(
  id: string,
  createdAt: string,
  gross: number,
  overrides: Partial<TransactionNode> = {},
): TransactionNode {
  return {
    id: `gid://partners/AppUsageSale/${id}`,
    createdAt,
    __typename: 'AppUsageSale',
    app: { id: APP_GID, name: 'Test App' },
    shop: { id: 'gid://partners/Shop/10', name: 'Shop 10', myshopifyDomain: 's10.example' },
    chargeId: '',
    billingInterval: null,
    grossAmount: { amount: String(gross), currencyCode: 'USD' },
    netAmount: { amount: String(gross - 1), currencyCode: 'USD' },
    shopifyFee: { amount: '1', currencyCode: 'USD' },
    ...overrides,
  };
}

/** Amounts with awkward decimal expansions, so a rounding bug has room to show. */
const AMOUNTS = [0.07, 12.34, 199.99, 3.33, 0.01, 47.61, 1234.56, 0.99];

function seedLedger(): void {
  const db = getDb();
  const nodes: TransactionNode[] = [];
  // Several transactions per day across a couple of months, at a spread of
  // times of day, so both the whole-day interiors and the partial-day ends of a
  // window carry rows.
  for (let day = 0; day < 60; day += 1) {
    for (let n = 0; n < 4; n += 1) {
      const at = new Date(Date.UTC(2024, 3, 1, n * 6 + 1, 17, 33) + day * 86_400_000);
      nodes.push(
        sale(`${day}-${n}`, at.toISOString(), AMOUNTS[(day * 4 + n) % AMOUNTS.length]!),
      );
    }
  }
  insertTransactions(db, nodes);
  rebuildDerivedTables(db);
}

/** Every figure the rollup stores, recomputed straight off the raw table. */
function rawTotals(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, type, app_id, currency,
              SUM(gross_amount) AS gross_amount, SUM(net_amount) AS net_amount,
              SUM(shopify_fee) AS shopify_fee, COUNT(*) AS txn_count
         FROM transactions
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4`,
    )
    .all() as Array<Record<string, unknown>>;
}

function rollupRows(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT day, type, app_id, currency, gross_amount, net_amount, shopify_fee, txn_count
         FROM transaction_daily ORDER BY day, type, app_id, currency`,
    )
    .all() as Array<Record<string, unknown>>;
}

/**
 * The comparison that matters: the same question asked of the same data, once
 * through the rollup and once around it.
 *
 * Emptying `transaction_daily` puts every metric back on the raw path — that is
 * the cold-database branch, and it makes the pre-rollup answer reproducible
 * inside a test instead of only against a checkout of the old code.
 */
describe('metrics answer identically with and without the rollup', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  const WINDOWS: Array<Record<string, string>> = [
    { period: 'last_7_days', end: '2024-05-20' },
    { period: 'last_30_days', end: '2024-05-20' },
    { period: 'last_90_days', end: '2024-05-20' },
    { period: 'last_12_months', end: '2024-05-20' },
    { period: 'custom', start: '2024-04-03', end: '2024-05-11' },
    { period: 'custom', start: '2024-04-10', end: '2024-04-12', interval: 'hour' },
    { period: 'custom', start: '2024-04-08', end: '2024-05-06', interval: 'week' },
    // Both ends mid-day, which is the shape every relative period really has
    // once `now` is not a midnight.
    { period: 'custom', start: '2024-04-07T09:41:12.000Z', end: '2024-05-19T22:03:58.000Z' },
  ];

  const METRICS = ['gross_earnings', 'mrr', 'arr', 'mrr_growth', 'arpu', 'ltv'];

  for (const window of WINDOWS) {
    it(`is exact over ${JSON.stringify(window)}`, () => {
      seedLedger();
      const db = getDb();

      const withRollup: Record<string, unknown> = {};
      for (const metric of METRICS) {
        withRollup[metric] = runMetric(metric, { ...window, nocache: '1' }, { now: NOW });
      }

      db.prepare('DELETE FROM transaction_daily').run();
      for (const metric of METRICS) {
        assert.deepEqual(
          runMetric(metric, { ...window, nocache: '1' }, { now: NOW }),
          withRollup[metric],
          `${metric} moved when the rollup was taken away`,
        );
      }
    });
  }

  it('reports the same currency profile from the rollup as from a full scan', () => {
    seedLedger();
    const db = getDb();
    const fromRollup = computeCurrencyProfile(db, []);
    db.prepare('DELETE FROM transaction_daily').run();
    assert.deepEqual(fromRollup, computeCurrencyProfile(db, []));
    assert.deepEqual(fromRollup, { currency: 'USD', mixed: false });
  });
});

describe('cutting a window into whole days and remainders', () => {
  beforeEach(() => resetEnvironment());

  it('leaves nothing over when both ends are local midnights', () => {
    const split = splitBuckets(
      [{ idx: 0, from: new Date('2024-04-01T00:00:00.000Z'), to: new Date('2024-04-08T00:00:00.000Z') }],
      'UTC',
      true,
    );
    assert.deepEqual(split.days, [{ idx: 0, from: '2024-04-01', to: '2024-04-08' }]);
    assert.deepEqual(split.edges, []);
  });

  it('reads the part-days at each end from the raw table', () => {
    const split = splitBuckets(
      [{ idx: 0, from: new Date('2024-04-01T09:30:00.000Z'), to: new Date('2024-04-08T14:15:00.000Z') }],
      'UTC',
      true,
    );
    assert.deepEqual(split.days, [{ idx: 0, from: '2024-04-02', to: '2024-04-08' }]);
    assert.deepEqual(split.edges, [
      { idx: 0, lo: '2024-04-01T09:30:00.000Z', hi: '2024-04-02T00:00:00.000Z' },
      { idx: 0, lo: '2024-04-08T00:00:00.000Z', hi: '2024-04-08T14:15:00.000Z' },
    ]);
  });

  it('uses no rollup at all for a window narrower than a day', () => {
    const split = splitBuckets(
      [{ idx: 0, from: new Date('2024-04-01T09:00:00.000Z'), to: new Date('2024-04-01T10:00:00.000Z') }],
      'UTC',
      true,
    );
    assert.deepEqual(split.days, [{ idx: 0, from: '', to: '' }]);
    assert.equal(split.edges.length, 1);
  });

  it('puts the whole window on the raw path when the rollup is not usable', () => {
    const from = new Date('2024-04-01T00:00:00.000Z');
    const to = new Date('2024-05-01T00:00:00.000Z');
    const split = splitBuckets([{ idx: 0, from, to }], 'UTC', false);
    assert.deepEqual(split.days, [{ idx: 0, from: '', to: '' }]);
    assert.deepEqual(split.edges, [{ idx: 0, lo: from.toISOString(), hi: to.toISOString() }]);
  });

  it('shifts an inclusive upper bound by the one millisecond that cannot hold a row', () => {
    const { from, to } = toHalfOpen(
      new Date('2024-04-01T00:00:00.000Z'),
      new Date('2024-05-01T00:00:00.000Z'),
    );
    assert.equal(from.toISOString(), '2024-04-01T00:00:00.001Z');
    assert.equal(to.toISOString(), '2024-05-01T00:00:00.001Z');
  });

  it('cuts every bucket of a real window and covers it exactly once', () => {
    const window = resolveWindow({
      period: 'last_30_days',
      timeZone: 'UTC',
      allTimeStart: '2020-01-01',
      now: new Date('2024-05-20T13:47:02.000Z'),
    });
    const split = splitBuckets(
      window.buckets.map((bucket, idx) => ({ idx, from: bucket.start, to: bucket.end })),
      'UTC',
      true,
    );

    // Reassemble each bucket from its pieces and check the pieces tile it.
    for (const [idx, bucket] of window.buckets.entries()) {
      const days = split.days.find((entry) => entry.idx === idx)!;
      const edges = split.edges.filter((entry) => entry.idx === idx);
      const pieces = [
        ...(days.from === days.to
          ? []
          : [[dayKeyStart(days.from, 'UTC').getTime(), dayKeyStart(days.to, 'UTC').getTime()] as const]),
        ...edges.map((edge) => [new Date(edge.lo).getTime(), new Date(edge.hi).getTime()] as const),
      ].sort((a, b) => a[0] - b[0]);

      assert.equal(pieces[0]![0], bucket.start.getTime());
      assert.equal(pieces[pieces.length - 1]![1], bucket.end.getTime());
      for (let at = 1; at < pieces.length; at += 1) {
        assert.equal(pieces[at]![0], pieces[at - 1]![1], `bucket ${idx} has a gap or an overlap`);
      }
    }

    // Every bucket key the split names is a day the rollup can hold.
    for (const day of split.days) {
      if (day.from === '') continue;
      assert.equal(dayKeyOf(dayKeyStart(day.from, 'UTC'), 'UTC'), day.from);
    }
  });

  it('keeps every day whole across a DST edge', () => {
    const zone = 'America/Los_Angeles';
    // The 23-hour day. Its start and its successor's start are what the rollup
    // reads as its boundaries, and a bucket cut on those boundaries must not
    // leave a remainder.
    const short = dayKeyStart('2024-03-10', zone);
    const next = dayKeyStart('2024-03-11', zone);
    assert.equal(next.getTime() - short.getTime(), 23 * 3_600_000);

    const split = splitBuckets([{ idx: 0, from: short, to: next }], zone, true);
    assert.deepEqual(split.days, [{ idx: 0, from: '2024-03-10', to: '2024-03-11' }]);
    assert.deepEqual(split.edges, []);
  });
});

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { resetEnvironment, seed, type SubscriptionFixture } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { resetConfig } from '../src/config.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { markStockFloor, syncStockDaily } from '../src/sync/stockRollup.js';
import { asOfPredicate } from '../src/metrics/predicate.js';
import { splitInstants, stockCoverage } from '../src/metrics/stockRollup.js';
import { dayKeyStart } from '../src/metrics/time.js';

/**
 * The write half of the subscription-side rollups.
 *
 * Their claim is narrower and stronger than the money rollup's: not that a sum
 * of days equals a sum of rows, but that a stored day *is* the as-of predicate's
 * answer at that day's opening midnight. So these tests re-run the predicate
 * against the raw table for every day the snapshot holds, for both gates, and
 * compare cell for cell. The read half — that no metric's answer moves — is in
 * `stockRollupReads.test.ts`.
 */

/**
 * A population with every shape the predicate distinguishes: annual and
 * monthly, trials that converted and trials that did not, a freeze that was
 * lifted and one that was not, a test subscription, a shop holding two charges
 * at once, and a plan change.
 */
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
];

const INSTALLS = {
  installs: [
    { shopId: '20', at: '2024-01-04T00:00:00Z' },
    { shopId: '21', at: '2024-01-06T12:00:00Z' },
    { shopId: '22', at: '2024-01-15T00:00:00Z' },
  ],
  uninstalls: [
    { shopId: '20', at: '2024-02-03T08:00:00Z' },
    { shopId: '22', at: '2024-01-28T00:00:00Z' },
  ],
  reopens: [{ shopId: '22', at: '2024-02-10T00:00:00Z' }],
  closes: [{ shopId: '21', at: '2024-02-20T00:00:00Z' }],
};

function seedAll() {
  return seed(FIXTURES, INSTALLS);
}

/** The predicate, run against the raw table, at every midnight the snapshot holds. */
function rawSubscriptionSnapshots(timeZone: string): Array<Record<string, unknown>> {
  const db = getDb();
  const days = (
    db.prepare('SELECT DISTINCT day FROM subscription_daily ORDER BY day').all() as Array<{
      day: string;
    }>
  ).map((row) => row.day);

  const out: Array<Record<string, unknown>> = [];
  for (const day of days) {
    for (const gate of [0, 1]) {
      const predicate = asOfPredicate(
        { appIds: [], includeAnnual: true, includeTrials: gate === 1 },
        '@asOf',
      );
      const rows = db
        .prepare(
          `SELECT s.app_id AS app_id,
                  COALESCE(SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS monthly_mrr,
                  COALESCE(SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN s.monthly_amount ELSE 0 END), 0) AS annual_mrr,
                  SUM(CASE WHEN s.billing_interval <> 'ANNUAL' THEN 1 ELSE 0 END) AS monthly_subs,
                  SUM(CASE WHEN s.billing_interval =  'ANNUAL' THEN 1 ELSE 0 END) AS annual_subs,
                  COUNT(DISTINCT s.shop_id) AS subscribers_all,
                  COUNT(DISTINCT CASE WHEN s.billing_interval <> 'ANNUAL' THEN s.shop_id END) AS subscribers_monthly
             FROM subscriptions s
            WHERE ${predicate.sql}
            GROUP BY s.app_id
            ORDER BY s.app_id`,
        )
        .all({ ...predicate.params, asOf: dayKeyStart(day, timeZone).toISOString() }) as Array<
        Record<string, unknown>
      >;
      for (const row of rows) out.push({ day, gate, ...row });
    }
  }
  return out;
}

function storedSubscriptionSnapshots(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT day, gate, app_id, monthly_mrr, annual_mrr, monthly_subs, annual_subs,
              subscribers_all, subscribers_monthly
         FROM subscription_daily ORDER BY day, gate, app_id`,
    )
    .all() as Array<Record<string, unknown>>;
}

function rawPopulation(timeZone: string): Array<Record<string, unknown>> {
  const db = getDb();
  const days = (
    db.prepare('SELECT DISTINCT day FROM population_daily ORDER BY day').all() as Array<{
      day: string;
    }>
  ).map((row) => row.day);

  const out: Array<Record<string, unknown>> = [];
  for (const day of days) {
    const asOf = dayKeyStart(day, timeZone).toISOString();
    const rows = db
      .prepare(
        `SELECT app_id, SUM(installs) AS active_installs, SUM(trials) AS on_trial FROM (
           SELECT i.app_id AS app_id, COUNT(DISTINCT i.app_id || ' ' || i.shop_id) AS installs, 0 AS trials
             FROM install_intervals i
            WHERE i.started_at <= @asOf AND (i.ended_at IS NULL OR i.ended_at > @asOf)
            GROUP BY i.app_id
           UNION ALL
           SELECT s.app_id, 0, COUNT(s.charge_id)
             FROM subscriptions s
            WHERE s.is_test = 0
              AND s.trial_started_at IS NOT NULL AND s.trial_ends_at IS NOT NULL
              AND s.trial_started_at < @asOf AND s.trial_ends_at >= @asOf
              AND (s.churn_at IS NULL OR s.churn_at >= @asOf)
            GROUP BY s.app_id
         ) GROUP BY app_id ORDER BY app_id`,
      )
      .all({ asOf }) as Array<Record<string, unknown>>;
    for (const row of rows) out.push({ day, ...row });
  }
  return out;
}

describe('the subscription-side daily snapshots', () => {
  beforeEach(() => resetEnvironment());

  it('stores the as-of predicate’s own answer, day for day and gate for gate', () => {
    seedAll();
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('UTC'));
    assert.ok(storedSubscriptionSnapshots().length > 0);
  });

  it('stores installs and running trials the same way', () => {
    seedAll();
    const stored = getDb()
      .prepare('SELECT day, app_id, active_installs, on_trial FROM population_daily ORDER BY day, app_id')
      .all();
    assert.deepEqual(stored, rawPopulation('UTC'));
  });

  it('counts lifecycle movement per day, excluding suppressed events', () => {
    seedAll();
    const db = getDb();
    const stored = db
      .prepare('SELECT day, app_id, type, event_count FROM customer_event_daily ORDER BY day, type, app_id')
      .all();
    const raw = db
      .prepare(
        `SELECT substr(occurred_at, 1, 10) AS day, app_id, type, COUNT(*) AS event_count
           FROM customer_events
          WHERE suppressed = 0
            AND type IN ('uninstalled', 'deactivated', 'reinstalled', 'reactivated')
          GROUP BY 1, 2, 3 ORDER BY day, type, app_id`,
      )
      .all();
    assert.deepEqual(stored, raw);
    assert.ok(raw.length > 0);
  });

  it('declares the span it built, from the first fact to today', () => {
    seedAll();
    const coverage = stockCoverage(getDb());
    assert.equal(coverage.ready, true);
    assert.equal(coverage.first, '2024-01-03');
    assert.equal(coverage.last, new Date().toISOString().slice(0, 10));

    // Inside the span a day with no rows means an empty population, not a
    // missing one — the reader's LEFT JOIN reads it as zero, which is what the
    // raw query answers too. What must never happen is a *stored* day outside
    // the declared span, which is the case a reader has no way to detect.
    const outside = getDb()
      .prepare(
        'SELECT COUNT(*) AS n FROM subscription_daily WHERE day < @first OR day > @last',
      )
      .get(coverage) as { n: number };
    assert.equal(outside.n, 0);
  });

  it('repairs forward from a backdated change rather than only its own day', () => {
    seedAll();
    const db = getDb();
    const before = storedSubscriptionSnapshots();

    // A cancellation arrives late, dated well before the last sync. Every
    // midnight from that instant on holds a different population.
    db.prepare(`UPDATE subscriptions SET churn_at = '2024-01-20T00:00:00Z' WHERE charge_id LIKE '%a%' AND charge_ref = 'a'`).run();
    const result = syncStockDaily(db);

    assert.equal(result.full, false);
    assert.ok(result.days > 1, 'a backdated fact must repair a tail, not a day');
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('UTC'));
    assert.notDeepEqual(storedSubscriptionSnapshots(), before);
  });

  it('lands in the same place whether a correction is applied once or twice', () => {
    seedAll();
    const db = getDb();
    db.prepare(`UPDATE subscriptions SET monthly_amount = 31.5 WHERE charge_ref = 'a'`).run();

    syncStockDaily(db);
    const once = storedSubscriptionSnapshots();

    // The same correction re-served by the API: the value is already what it
    // will be set to, and the day is marked dirty regardless.
    db.prepare(`UPDATE subscriptions SET monthly_amount = 31.5 WHERE charge_ref = 'a'`).run();
    markStockFloor(db, ['2024-01-01']);
    syncStockDaily(db);

    assert.deepEqual(storedSubscriptionSnapshots(), once);
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('UTC'));
  });

  it('recomputes a dirty day from the raw rows, so a hand-corrupted cell heals', () => {
    seedAll();
    const db = getDb();
    db.prepare(`UPDATE subscription_daily SET monthly_mrr = monthly_mrr + 1000 WHERE day = '2024-01-20'`).run();
    markStockFloor(db, ['2024-01-20']);
    syncStockDaily(db);
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('UTC'));
  });

  it('does nothing but extend the range when nothing has changed', () => {
    seedAll();
    const db = getDb();
    const before = storedSubscriptionSnapshots();
    const result = syncStockDaily(db);
    // The day after the last one built is always due, so a quiet sync is one
    // day of work rather than none — never a rebuild.
    assert.equal(result.full, false);
    assert.ok(result.days <= 2, `expected a day or two, got ${result.days}`);
    assert.deepEqual(storedSubscriptionSnapshots(), before);
  });

  it('rebuilds from scratch when the reporting timezone changes underneath it', () => {
    seedAll();
    const db = getDb();
    const utc = storedSubscriptionSnapshots();
    assert.equal(stockCoverage(db).ready, true);

    // The setting changes under the same database, which is what a redeploy
    // with a new `REPORTING_TIMEZONE` does. The table is still there and still
    // means UTC days, so the reader must refuse it until it has been rebuilt.
    process.env.REPORTING_TIMEZONE = 'America/New_York';
    resetConfig();
    assert.equal(stockCoverage(db).ready, false);

    const result = syncStockDaily(db);
    assert.equal(result.full, true);
    assert.equal(stockCoverage(db).ready, true);
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('America/New_York'));
    assert.notDeepEqual(storedSubscriptionSnapshots(), utc);
  });

  it('files each snapshot at the local midnight, across a DST change', () => {
    resetEnvironment({ REPORTING_TIMEZONE: 'America/New_York' });
    seed(
      [
        {
          chargeRef: 'dst',
          shopId: '1',
          amount: 10,
          activatedAt: '2024-03-10T06:30:00Z',
          firstSaleAt: '2024-03-10T06:30:00Z',
        },
      ],
      {},
    );
    const db = getDb();
    // 2024-03-10T06:30Z is 01:30 on the 10th in New York, before the 07:00Z
    // spring-forward. The 10th's midnight is 05:00Z, the 11th's is 04:00Z, and
    // the subscription must be absent from the first and present in the second.
    const rows = db
      .prepare(
        `SELECT day, monthly_subs FROM subscription_daily
          WHERE gate = 0 AND day IN ('2024-03-10', '2024-03-11') ORDER BY day`,
      )
      .all() as Array<{ day: string; monthly_subs: number }>;
    assert.deepEqual(rows, [{ day: '2024-03-11', monthly_subs: 1 }]);
    assert.deepEqual(storedSubscriptionSnapshots(), rawSubscriptionSnapshots('America/New_York'));
  });

  it('clears itself, and its coverage, when there is nothing left to snapshot', () => {
    seedAll();
    const db = getDb();
    db.exec('DELETE FROM subscriptions; DELETE FROM install_intervals; DELETE FROM customer_events;');
    const result = syncStockDaily(db);
    assert.equal(result.days, 0);
    assert.equal(stockCoverage(db).ready, false);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM subscription_daily').get() as { n: number }).n,
      0,
    );
  });

  it('is built by the sync, not by a reader', () => {
    seedAll();
    const db = getDb();
    // `rebuildDerivedTables` is the sync's own step, and it leaves the tables
    // ready. Nothing on a read path is allowed to.
    db.exec('DELETE FROM subscription_daily');
    db.prepare(`DELETE FROM sync_state WHERE key LIKE 'rollup:stock_daily%'`).run();
    assert.equal(stockCoverage(db).ready, false);
    rebuildDerivedTables(db);
    assert.equal(stockCoverage(db).ready, true);
  });
});

describe('which instants a snapshot may answer', () => {
  beforeEach(() => resetEnvironment());

  const coverage = { ready: true, first: '2024-01-01', last: '2024-03-01' };

  it('takes a local midnight and refuses anything else', () => {
    const split = splitInstants(
      [
        { idx: 0, asOf: new Date('2024-02-01T00:00:00.000Z') },
        { idx: 1, asOf: new Date('2024-02-01T00:00:00.001Z') },
        { idx: 2, asOf: new Date('2024-02-01T13:45:00.000Z') },
      ],
      'UTC',
      coverage,
    );
    assert.deepEqual(split.snapshots.map((ref) => ref.idx), [0]);
    assert.deepEqual(split.raw.map((ref) => ref.idx), [1, 2]);
  });

  it('refuses a midnight outside the days that were built', () => {
    const split = splitInstants(
      [
        { idx: 0, asOf: new Date('2023-12-31T00:00:00Z') },
        { idx: 1, asOf: new Date('2024-03-02T00:00:00Z') },
        { idx: 2, asOf: new Date('2024-02-02T00:00:00Z') },
      ],
      'UTC',
      coverage,
    );
    assert.deepEqual(split.snapshots.map((ref) => ref.idx), [2]);
    assert.deepEqual(split.raw.map((ref) => ref.idx), [0, 1]);
  });

  it('sends everything to the raw tables when there is no coverage', () => {
    const split = splitInstants(
      [{ idx: 0, asOf: new Date('2024-02-01T00:00:00Z') }],
      'UTC',
      { ready: false, first: '', last: '' },
    );
    assert.equal(split.snapshots.length, 0);
    assert.equal(split.raw.length, 1);
  });

  it('reads midnight in the reporting timezone, not in UTC', () => {
    const split = splitInstants(
      [
        { idx: 0, asOf: new Date('2024-02-01T00:00:00Z') },
        { idx: 1, asOf: new Date('2024-02-01T05:00:00Z') },
      ],
      'America/New_York',
      coverage,
    );
    assert.deepEqual(split.snapshots.map((ref) => [ref.idx, ref.day]), [[1, '2024-02-01']]);
    assert.deepEqual(split.raw.map((ref) => ref.idx), [0]);
  });
});

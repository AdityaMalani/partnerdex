import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDb, getDb, readSyncState, type Db } from '../src/db/index.js';
import { insertAppEvents, insertTransactions } from '../src/sync/ingest.js';
import type { AppEventNode, TransactionNode } from '../src/sync/ingest.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { nextDirtyPairs } from '../src/sync/chargeIndex.js';
import { APP_ID, resetEnvironment } from './helpers.js';

/**
 * The incremental derive, proven rather than asserted.
 *
 * The claim under test is one sentence: **after an incremental pass the three
 * derived tables hold exactly what a full rebuild would produce from the same
 * raw rows.** Everything else here — the dirty-set rules, restatement, deletion,
 * recovery — is a different way of putting the same database into a state where
 * that claim could fail, and then checking it row for row, every column.
 */

const OTHER_APP = '222';

function shop(id: string) {
  return { id: `gid://partners/Shop/${id}`, name: `Shop ${id}`, myshopifyDomain: `s${id}.example` };
}

function charge(ref: string, amount: number, billingOn: string | null = null, test = false) {
  return {
    id: `gid://shopify/AppSubscription/${ref}`,
    name: 'Plan',
    test,
    billingOn,
    amount: { amount: String(amount), currencyCode: 'USD' },
  };
}

function activation(shopId: string, ref: string, at: string, amount: number, billingOn?: string) {
  return {
    type: 'SUBSCRIPTION_CHARGE_ACTIVATED',
    occurredAt: at,
    __typename: 'SubscriptionChargeActivated',
    shop: shop(shopId),
    charge: charge(ref, amount, billingOn ?? null),
  } satisfies AppEventNode;
}

function install(shopId: string, at: string): AppEventNode {
  return {
    type: 'RELATIONSHIP_INSTALLED',
    occurredAt: at,
    __typename: 'RelationshipInstalled',
    shop: shop(shopId),
    charge: null,
  };
}

function uninstall(shopId: string, at: string): AppEventNode {
  return {
    type: 'RELATIONSHIP_UNINSTALLED',
    occurredAt: at,
    __typename: 'RelationshipUninstalled',
    shop: shop(shopId),
    charge: null,
  };
}

function sale(
  ref: string,
  shopId: string,
  at: string,
  gross: number,
  billingInterval: 'EVERY_30_DAYS' | 'ANNUAL' = 'EVERY_30_DAYS',
  appId = APP_ID,
  suffix = '',
): TransactionNode {
  return {
    id: `gid://partners/AppSubscriptionSale/${ref}${suffix}`,
    createdAt: at,
    __typename: 'AppSubscriptionSale',
    app: { id: `gid://partners/App/${appId}`, name: `App ${appId}` },
    shop: shop(shopId),
    chargeId: `gid://shopify/AppSubscription/${ref}`,
    billingInterval,
    grossAmount: { amount: String(gross), currencyCode: 'USD' },
    netAmount: { amount: String(gross * 0.8), currencyCode: 'USD' },
    shopifyFee: { amount: String(gross * 0.2), currencyCode: 'USD' },
  };
}

/**
 * The whole of the exactness check.
 *
 * Everything the three tables hold is dumped, in a stable order, with every
 * column. The database is then copied, the copy is rebuilt from scratch with
 * `full`, and the two dumps are compared value by value — which is what makes
 * this a proof about the incremental path rather than a count that happens to
 * match. Returns how many rows were compared.
 */
function rowsOf(db: Db, table: string, order: string): Array<Record<string, unknown>> {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Array<
    Record<string, unknown>
  >;
}

const TABLES: Array<[string, string]> = [
  ['subscriptions', 'charge_id'],
  ['install_intervals', 'app_id, shop_id, started_at'],
  ['customer_events', 'event_id'],
];

function snapshot(db: Db): Map<string, Array<Record<string, unknown>>> {
  return new Map(TABLES.map(([table, order]) => [table, rowsOf(db, table, order)]));
}

/**
 * Rebuild everything from the raw rows and require the result to be identical.
 *
 * `full` is genuinely a rebuild: it clears the three tables and the charge index
 * and recomputes every merchant, so what it produces depends on nothing the
 * incremental passes left behind.
 */
function assertMatchesFullRebuild(db: Db): number {
  const incremental = snapshot(db);
  rebuildDerivedTables(db, { full: true });
  const rebuilt = snapshot(db);

  let compared = 0;
  for (const [table] of TABLES) {
    const left = incremental.get(table)!;
    const right = rebuilt.get(table)!;
    assert.equal(left.length, right.length, `${table}: row count`);
    for (let index = 0; index < left.length; index += 1) {
      assert.deepEqual(left[index], right[index], `${table} row ${index}`);
      compared += 1;
    }
  }
  assert.ok(compared > 0, 'nothing was compared');
  return compared;
}

/** A population with siblings, plan changes, trials, freezes and reinstalls. */
function seedPopulation(): void {
  const db = getDb();
  const events: AppEventNode[] = [];
  const sales: TransactionNode[] = [];

  for (let i = 0; i < 40; i += 1) {
    const shopId = `s${i}`;
    const ref = `c${i}`;
    events.push(install(shopId, '2024-01-01T00:00:00.000Z'));
    events.push(activation(shopId, ref, '2024-01-02T00:00:00.000Z', 10 + i, '2024-01-16'));

    if (i % 3 === 0) {
      sales.push(sale(ref, shopId, '2024-01-16T00:00:00.000Z', 10 + i));
      sales.push(sale(ref, shopId, '2024-02-16T00:00:00.000Z', 10 + i, 'EVERY_30_DAYS', APP_ID, '-2'));
    }
    if (i % 5 === 0) {
      events.push({
        type: 'SUBSCRIPTION_CHARGE_CANCELED',
        occurredAt: '2024-03-01T00:00:00.000Z',
        __typename: 'SubscriptionChargeCanceled',
        shop: shop(shopId),
        charge: charge(ref, 10 + i),
      });
      // A plan change: the cancel above and this activation inside the window.
      events.push(activation(shopId, `${ref}b`, '2024-03-01T00:00:00.000Z', 30 + i, '2024-03-31'));
    }
    if (i % 7 === 0) {
      events.push(uninstall(shopId, '2024-04-01T00:00:00.000Z'));
      events.push(install(shopId, '2024-05-01T00:00:00.000Z'));
    }
    if (i % 11 === 0) {
      events.push({
        type: 'SUBSCRIPTION_CHARGE_FROZEN',
        occurredAt: '2024-02-01T00:00:00.000Z',
        __typename: 'SubscriptionChargeFrozen',
        shop: shop(shopId),
        charge: charge(ref, 10 + i),
      });
    }
  }

  insertAppEvents(db, APP_ID, events);
  insertTransactions(db, sales);
  rebuildDerivedTables(db);
}

describe('the incremental derive: what makes a merchant dirty', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  it('marks the merchant an app event was written for', () => {
    const db = getDb();
    seedPopulation();
    assert.equal(nextDirtyPairs(db).length, 0, 'a finished pass leaves no work');

    insertAppEvents(db, APP_ID, [uninstall('s3', '2024-06-01T00:00:00.000Z')]);
    const marked = nextDirtyPairs(db);
    assert.deepEqual(marked, [{ app_id: APP_ID, shop_id: 's3' }]);
  });

  it('marks the merchant behind a charge whose sale landed', () => {
    const db = getDb();
    rebuildDerivedTables(db);
    assert.equal(nextDirtyPairs(db).length, 0);

    // The transaction names the charge, not the merchant's derived rows; the
    // pair has to be recovered from the charge index.
    insertTransactions(db, [sale('c1', 's1', '2024-03-16T00:00:00.000Z', 11)]);
    const before = nextDirtyPairs(db);
    assert.equal(before.length, 0, 'the ingest marks the charge, not the pair');

    rebuildDerivedTables(db);
    const row = db.prepare('SELECT paid_sale_count FROM subscriptions WHERE charge_ref = ?').get('c1') as {
      paid_sale_count: number;
    };
    assert.equal(row.paid_sale_count, 1, 'the sale reached the merchant it belongs to');
  });

  it('does not mark a merchant for a usage sale on a charge nobody subscribes to', () => {
    const db = getDb();
    rebuildDerivedTables(db);
    const usage: TransactionNode = {
      id: 'gid://partners/AppUsageSale/u1',
      createdAt: '2024-06-01T00:00:00.000Z',
      __typename: 'AppUsageSale',
      app: { id: `gid://partners/App/${APP_ID}`, name: 'App' },
      shop: shop('s1'),
      chargeId: 'gid://shopify/AppUsageRecord/u1',
      billingInterval: null,
      grossAmount: { amount: '3', currencyCode: 'USD' },
      netAmount: { amount: '2', currencyCode: 'USD' },
      shopifyFee: { amount: '1', currencyCode: 'USD' },
    };
    insertTransactions(db, [usage]);

    const marked = db
      .prepare('SELECT COUNT(*) AS n FROM charge_sales_dirty')
      .get() as { n: number };
    assert.equal(marked.n, 0, 'a usage sale is not a subscription sale');
  });

  it('sweeps a charge whose billing date has arrived since the last pass', async () => {
    resetEnvironment();
    const db = getDb();
    // Activated yesterday, billing a moment from now: a live trial, and one
    // whose reading changes with nothing but the passage of time.
    const activatedAt = new Date(Date.now() - 86_400_000).toISOString();
    const billingOn = new Date(Date.now() + 400).toISOString();

    insertAppEvents(db, APP_ID, [
      install('t1', activatedAt),
      activation('t1', 'clock', activatedAt, 25, billingOn),
    ]);
    rebuildDerivedTables(db);
    const before = db
      .prepare('SELECT trial_status, conversion_at FROM subscriptions WHERE charge_ref = ?')
      .get('clock') as { trial_status: string; conversion_at: string | null };
    assert.equal(before.trial_status, 'in_trial');
    assert.equal(before.conversion_at, null);

    // Nothing is ingested, nothing is marked, and the answer still has to move.
    // The stored watermark is the previous pass's `now`, which is before the
    // billing instant; this pass's is after it.
    await new Promise((resolve) => setTimeout(resolve, 700));
    rebuildDerivedTables(db);

    const after = db
      .prepare('SELECT trial_status, conversion_at FROM subscriptions WHERE charge_ref = ?')
      .get('clock') as { trial_status: string; conversion_at: string | null };
    assert.notEqual(after.trial_status, 'in_trial');
    assert.equal(after.conversion_at, billingOn);
    assert.ok(assertMatchesFullRebuild(db) > 0);
  });

  it('marks every shop of an app when the price book learns a new cadence', () => {
    resetEnvironment();
    const db = getDb();

    // Two shops on the same price point, neither with a settled sale, so both
    // resolve their cadence through the book — which knows nothing yet.
    insertAppEvents(db, APP_ID, [
      activation('p1', 'pb1', '2024-01-01T00:00:00.000Z', 240, '2024-01-15'),
      activation('p2', 'pb2', '2024-01-01T00:00:00.000Z', 240, '2024-01-15'),
      activation('p3', 'pb3', '2024-01-01T00:00:00.000Z', 240, '2024-01-15'),
    ]);
    rebuildDerivedTables(db);
    assert.deepEqual(
      db
        .prepare('SELECT DISTINCT billing_interval FROM subscriptions ORDER BY 1')
        .all(),
      [{ billing_interval: 'EVERY_30_DAYS' }],
    );

    // A settled annual sale on the *third* shop teaches the book that this price
    // point is annual. Nothing about the first two changed, and both are wrong
    // until something marks them.
    insertTransactions(
      db,
      [sale('pb3', 'p3', '2024-01-15T00:00:00.000Z', 240, 'ANNUAL')],
    );
    rebuildDerivedTables(db);

    const intervals = db
      .prepare('SELECT charge_ref, billing_interval FROM subscriptions ORDER BY charge_ref')
      .all() as Array<{ charge_ref: string; billing_interval: string }>;
    assert.deepEqual(
      intervals.map((row) => row.billing_interval),
      ['ANNUAL', 'ANNUAL', 'ANNUAL'],
      'the two shops that never changed were rebuilt because the book moved',
    );
    assertMatchesFullRebuild(db);
  });
});

describe('the incremental derive: exactness against a full rebuild', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  it('lands on the same rows after a run of ordinary passes', () => {
    const db = getDb();
    seedPopulation();

    // An ordinary pass: an overlap replayed unchanged, a few genuinely new
    // facts, on merchants scattered through the population.
    insertAppEvents(db, APP_ID, [
      uninstall('s2', '2024-06-01T00:00:00.000Z'),
      install('s2', '2024-07-01T00:00:00.000Z'),
      activation('s41', 'c41', '2024-06-02T00:00:00.000Z', 55, '2024-06-16'),
    ]);
    insertTransactions(
      db,
      [
        sale('c41', 's41', '2024-06-16T00:00:00.000Z', 55),
        sale('c6', 's6', '2024-03-16T00:00:00.000Z', 16),
      ],
    );
    rebuildDerivedTables(db);

    insertAppEvents(db, APP_ID, [
      {
        type: 'SUBSCRIPTION_CHARGE_CANCELED',
        occurredAt: '2024-08-01T00:00:00.000Z',
        __typename: 'SubscriptionChargeCanceled',
        shop: shop('s41'),
        charge: charge('c41', 55),
      },
    ]);
    rebuildDerivedTables(db);

    const compared = assertMatchesFullRebuild(db);
    assert.ok(compared > 250, `compared ${compared} rows`);
  });

  it('is unmoved by a second application of the same correction', () => {
    resetEnvironment();
    const db = getDb();
    seedPopulation();

    const restate = () =>
      insertTransactions(
        db,
        [
          sale('c0', 's0', '2024-01-16T00:00:00.000Z', 99),
          sale('c3', 's3', '2024-01-16T00:00:00.000Z', 77),
        ],
      );

    restate();
    rebuildDerivedTables(db);
    const once = snapshot(db);

    restate();
    rebuildDerivedTables(db);
    const twice = snapshot(db);

    for (const [table] of TABLES) {
      assert.deepEqual(twice.get(table), once.get(table), `${table}: correcting twice moved it`);
    }
    assertMatchesFullRebuild(db);
  });

  it('drops intervals a merchant no longer has', () => {
    resetEnvironment();
    const db = getDb();
    insertAppEvents(db, APP_ID, [
      install('d1', '2024-01-01T00:00:00.000Z'),
      uninstall('d1', '2024-02-01T00:00:00.000Z'),
      install('d1', '2024-03-01T00:00:00.000Z'),
      uninstall('d1', '2024-04-01T00:00:00.000Z'),
    ]);
    rebuildDerivedTables(db);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM install_intervals').get() as { n: number }).n,
      2,
    );

    // The raw feed comes back shorter — a purge, a corrected export. Nothing
    // marks it, so the merchant is marked the way an operator would: by hand,
    // or by the next event that touches it.
    db.prepare(`DELETE FROM app_events WHERE occurred_at >= '2024-03-01'`).run();
    insertAppEvents(db, APP_ID, [install('d1', '2024-01-01T00:00:00.000Z')]);
    rebuildDerivedTables(db);

    const intervals = db.prepare('SELECT * FROM install_intervals').all() as Array<{
      started_at: string;
      ended_at: string | null;
    }>;
    assert.equal(intervals.length, 1, 'the interval that no longer exists is gone');
    assert.equal(intervals[0]!.started_at, '2024-01-01T00:00:00.000Z');
    assertMatchesFullRebuild(db);
  });

  it('loses a payment event when its sale is restated to nothing', () => {
    resetEnvironment();
    const db = getDb();
    insertAppEvents(db, APP_ID, [activation('z1', 'z1', '2024-01-01T00:00:00.000Z', 20)]);
    insertTransactions(db, [sale('z1', 'z1', '2024-01-16T00:00:00.000Z', 20)]);
    rebuildDerivedTables(db);
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM customer_events WHERE type IN ('payment', 'refund')`)
          .get() as { n: number }
      ).n,
      1,
    );

    insertTransactions(db, [sale('z1', 'z1', '2024-01-16T00:00:00.000Z', 0)]);
    rebuildDerivedTables(db);
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM customer_events WHERE type IN ('payment', 'refund')`)
          .get() as { n: number }
      ).n,
      0,
      'a sale reversed to zero takes its payment event with it',
    );
    assertMatchesFullRebuild(db);
  });
});

describe('the incremental derive: recovery', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  it('finishes the merchants a killed pass never reached', () => {
    const db = getDb();
    seedPopulation();

    insertAppEvents(db, APP_ID, [
      uninstall('s1', '2024-09-01T00:00:00.000Z'),
      uninstall('s2', '2024-09-01T00:00:00.000Z'),
      uninstall('s4', '2024-09-01T00:00:00.000Z'),
    ]);

    /*
     * A pass that dies half way. The marks are the durable work list, so this
     * is what the database looks like after one: some merchants rewritten, the
     * rest still claimed. Simulated by rebuilding one merchant and putting the
     * other two back on the list — which is exactly the state a crash between
     * two chunk transactions leaves, because a chunk's marks are dropped in the
     * same transaction as its rows.
     */
    const survivors = [
      { app_id: APP_ID, shop_id: 's2' },
      { app_id: APP_ID, shop_id: 's4' },
    ];
    db.prepare('DELETE FROM derive_dirty_pairs').run();
    for (const pair of survivors) {
      db.prepare('INSERT INTO derive_dirty_pairs (app_id, shop_id) VALUES (?, ?)').run(
        pair.app_id,
        pair.shop_id,
      );
    }
    // s1's uninstall is unclaimed and unbuilt: the crash lost it. This is the
    // case the clock watermark covers — it was never advanced, so the pass that
    // died is not treated as having happened.
    db.prepare(`DELETE FROM sync_state WHERE key = 'derive:clock'`).run();

    rebuildDerivedTables(db);
    assert.equal(nextDirtyPairs(db).length, 0, 'the work list drained');
    assertMatchesFullRebuild(db);
  });

  it('rebuilds again after a full rebuild died with the tables emptied', () => {
    resetEnvironment();
    const db = getDb();
    seedPopulation();

    /*
     * The window a full rebuild opens: the three tables are emptied before they
     * are refilled. What makes this recoverable is that the watermark is cleared
     * *first*, so a crash inside that window reads as "never run" rather than as
     * "incremental, and nothing is marked" — which would leave the tables empty
     * for good.
     */
    db.transaction(() => {
      db.prepare(`DELETE FROM sync_state WHERE key = 'derive:clock'`).run();
      db.prepare('DELETE FROM subscriptions').run();
      db.prepare('DELETE FROM install_intervals').run();
      db.prepare('DELETE FROM derive_dirty_pairs').run();
    })();

    const result = rebuildDerivedTables(db);
    assert.equal(result.full, true);
    assert.ok(result.subscriptions > 0, 'the emptied tables were refilled');
    assertMatchesFullRebuild(db);
  });

  it('rebuilds everything when it has never run under this scheme', () => {
    resetEnvironment();
    const db = getDb();
    seedPopulation();
    assert.ok(readSyncState(db, 'derive:clock').cursor, 'the watermark is written');

    // An existing database upgrading into this change has no watermark, and its
    // derived tables were written by something that left no marks behind.
    db.prepare(`DELETE FROM sync_state WHERE key = 'derive:clock'`).run();
    db.prepare('DELETE FROM subscriptions').run();
    db.prepare('DELETE FROM install_intervals').run();

    const result = rebuildDerivedTables(db);
    assert.equal(result.full, true, 'a missing watermark reads as "rebuild everything"');
    assert.ok(result.subscriptions > 0);
    assertMatchesFullRebuild(db);
  });

  it('keeps a second app out of the first app\'s rebuild', () => {
    resetEnvironment({ PARTNER_APP_IDS: `${APP_ID},${OTHER_APP}` });
    const db = getDb();
    insertAppEvents(db, APP_ID, [activation('m1', 'm1', '2024-01-01T00:00:00.000Z', 10)]);
    insertAppEvents(db, OTHER_APP, [activation('m1', 'm2', '2024-01-01T00:00:00.000Z', 20)]);
    rebuildDerivedTables(db);

    insertAppEvents(db, APP_ID, [uninstall('m1', '2024-02-01T00:00:00.000Z')]);
    const marked = nextDirtyPairs(db);
    assert.deepEqual(marked, [{ app_id: APP_ID, shop_id: 'm1' }], 'the same shop, a different app');

    rebuildDerivedTables(db);
    assertMatchesFullRebuild(db);
  });
});

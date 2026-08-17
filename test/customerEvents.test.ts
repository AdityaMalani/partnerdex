import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { getDb } from '../src/db/index.js';
import { closeDb } from '../src/db/index.js';
import { getCustomer, listCustomers } from '../src/customers/index.js';
import { runMetric } from '../src/metrics/registry.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { insertTransactions, type TransactionNode } from '../src/sync/ingest.js';
import { APP_GID, APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * The acceptance scenarios from the customer-events spec, plus the invariant
 * the whole design rests on: summing `net_change` reproduces the MRR the as-of
 * reconstruction reports. Those are two independent paths through the same
 * facts, so a drift between them is a real bug rather than a rounding artefact.
 */

interface EventRow {
  type: string;
  occurred_at: string;
  net_change: number | null;
  suppressed: number;
  charge_id: string;
  prev_charge_id: string;
  plan_amount: number | null;
}

function eventsFor(shopId: string, options: { includeSuppressed?: boolean } = {}): EventRow[] {
  return getDb()
    .prepare(
      `SELECT type, occurred_at, net_change, suppressed, charge_id, prev_charge_id, plan_amount
       FROM customer_events
       WHERE shop_id = ? AND type NOT IN ('payment', 'refund')
         ${options.includeSuppressed ? '' : 'AND suppressed = 0'}
       ORDER BY occurred_at, type`,
    )
    .all(shopId) as EventRow[];
}

function typesFor(shopId: string): string[] {
  return eventsFor(shopId).map((row) => row.type);
}

/** The ledger's view of MRR: every delta the install has ever recorded. */
function ledgerTotal(): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(net_change), 0) AS total FROM customer_events WHERE suppressed = 0')
    .get() as { total: number };
  return Math.round(row.total * 100) / 100;
}

describe('customer events: the raw feed compiled into a lifecycle', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  it('records a first subscription once, at the monthly rate', () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: 'c1',
          shopId: '1',
          amount: 50,
          activatedAt: '2024-01-10T00:00:00Z',
          firstSaleAt: '2024-01-10T00:00:00Z',
        },
      ],
      { installs: [{ shopId: '1', at: '2024-01-09T00:00:00Z' }] },
    );

    assert.deepEqual(typesFor('1'), ['installed', 'subscribed']);
    const subscribed = eventsFor('1').find((row) => row.type === 'subscribed')!;
    assert.equal(subscribed.net_change, 50);
  });

  it('normalizes an annual plan to its monthly contribution', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 1200,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        billingInterval: 'ANNUAL',
      },
    ]);

    const subscribed = eventsFor('1').find((row) => row.type === 'subscribed')!;
    // 1200 a year is 100 a month, not 1200.
    assert.equal(subscribed.net_change, 100);
    assert.equal(subscribed.plan_amount, 100);
  });

  it('reads a monthly-to-annual switch on the normalized amount, not the sticker price', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'old',
        shopId: '1',
        amount: 14,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        churnedAt: '2024-03-01T00:00:00Z',
      },
      {
        chargeRef: 'new',
        shopId: '1',
        amount: 140,
        billingInterval: 'ANNUAL',
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
      },
    ]);

    // $140 a year is $11.67 a month, down from $14, so the direction follows the
    // MRR: spec §0 invariant 3 decides upgrade vs downgrade on the normalized
    // amount, and §5.4 keeps the label consistent with the sign of net_change.
    // The Slack layer rewords this one for humans without touching either.
    const types = typesFor('1');
    assert.equal(types.filter((type) => type === 'downgraded').length, 1);
    assert.equal(types.filter((type) => type === 'upgraded').length, 0);

    const move = eventsFor('1').find((row) => row.type === 'downgraded')!;
    assert.equal(move.plan_amount, 140 / 12);
    assert.ok(move.net_change! < 0, 'the sign agrees with the label');
    assert.ok(Math.abs(move.net_change! - (140 / 12 - 14)) < 0.005);
  });

  it('reads a mid-cycle upgrade as one event and zero churn', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'old',
        shopId: '1',
        amount: 20,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        churnedAt: '2024-03-01T00:00:00Z',
      },
      {
        chargeRef: 'new',
        shopId: '1',
        amount: 60,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
      },
    ]);

    const types = typesFor('1');
    assert.equal(types.filter((type) => type === 'unsubscribed').length, 0);
    assert.equal(types.filter((type) => type === 'upgraded').length, 1);

    const upgrade = eventsFor('1').find((row) => row.type === 'upgraded')!;
    assert.equal(upgrade.net_change, 40); // 60 - 20
    assert.ok(upgrade.prev_charge_id.endsWith('old'));

    // The cancel is kept on the record, marked as the plan change it was.
    const suppressed = eventsFor('1', { includeSuppressed: true }).filter((row) => row.suppressed === 1);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0]!.type, 'unsubscribed');
  });

  it('reads a downgrade as a negative move, still without churn', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'old',
        shopId: '1',
        amount: 80,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        churnedAt: '2024-03-01T00:00:00Z',
      },
      {
        chargeRef: 'new',
        shopId: '1',
        amount: 30,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
      },
    ]);

    const downgrade = eventsFor('1').find((row) => row.type === 'downgraded')!;
    assert.equal(downgrade.net_change, -50);
    assert.equal(typesFor('1').includes('unsubscribed'), false);
  });

  it('records a real cancellation as churn', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 45,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        churnedAt: '2024-05-01T00:00:00Z',
      },
    ]);

    const churn = eventsFor('1').find((row) => row.type === 'unsubscribed')!;
    assert.equal(churn.suppressed, 0);
    assert.equal(churn.net_change, -45);
    assert.equal(ledgerTotal(), 0);
  });

  it('calls a return a win-back rather than a first subscription', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'first',
        shopId: '1',
        amount: 25,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        churnedAt: '2024-02-10T00:00:00Z',
      },
      {
        chargeRef: 'again',
        shopId: '1',
        amount: 25,
        activatedAt: '2024-09-01T00:00:00Z',
        firstSaleAt: '2024-09-01T00:00:00Z',
      },
    ]);

    const types = typesFor('1');
    assert.equal(types.filter((type) => type === 'subscribed').length, 1);
    assert.equal(types.filter((type) => type === 'resubscribed').length, 1);
  });

  it('drops MRR on a freeze and restores it on a thaw, without churning', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 40,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
        frozenAt: '2024-03-01T00:00:00Z',
        unfrozenAt: '2024-04-01T00:00:00Z',
      },
    ]);

    const rows = eventsFor('1');
    assert.equal(rows.find((row) => row.type === 'subscription_frozen')!.net_change, -40);
    assert.equal(rows.find((row) => row.type === 'subscription_unfrozen')!.net_change, 40);
    assert.equal(typesFor('1').includes('unsubscribed'), false);
    assert.equal(ledgerTotal(), 40);
  });

  it('holds the money back until a trial converts', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 30,
        activatedAt: '2024-01-01T00:00:00Z',
        // Fourteen days later: a trial, not a same-day purchase.
        firstSaleAt: '2024-01-15T00:00:00Z',
      },
    ]);

    const rows = eventsFor('1');
    // Subscribing during a trial is real, but worth nothing yet.
    assert.equal(rows.find((row) => row.type === 'subscribed')!.net_change, 0);
    assert.ok(rows.some((row) => row.type === 'trial_started'));

    const converted = rows.find((row) => row.type === 'trial_converted')!;
    assert.equal(converted.net_change, 30);
    assert.equal(converted.occurred_at, '2024-01-15T00:00:00.000Z');
    assert.equal(ledgerTotal(), 30);
  });

  it('reports a trial the merchant walked out of at the moment they left', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 30,
        activatedAt: '2024-01-01T00:00:00Z',
        billingOn: '2024-01-15T00:00:00Z',
        churnedAt: '2024-01-10T00:00:00Z',
      },
    ]);

    const types = typesFor('1');
    assert.ok(types.includes('trial_started'));
    assert.ok(types.includes('trial_abandoned'));
    // Spec 6.2: nothing expired here. The window never closed — the merchant
    // left five days short of it, and dating an expiry at the 15th would report
    // them as still trialling for five days after they had gone.
    assert.equal(types.includes('trial_expired'), false);
    const left = eventsFor('1').find((row) => row.type === 'trial_abandoned')!;
    assert.equal(left.occurred_at, '2024-01-10T00:00:00.000Z');
    // A charge that never billed was abandoned, not churned: no MRR to lose.
    assert.equal(types.includes('unsubscribed'), false);
    assert.equal(ledgerTotal(), 0);
  });

  it('expires a trial that reached the end of its window still running', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 30,
        activatedAt: '2024-01-01T00:00:00Z',
        billingOn: '2024-01-15T00:00:00Z',
        churnedAt: '2024-01-20T00:00:00Z',
      },
    ]);

    const types = typesFor('1');
    assert.ok(types.includes('trial_expired'), 'the window closed before they left');
    assert.equal(types.includes('trial_abandoned'), false);
    const expired = eventsFor('1').find((row) => row.type === 'trial_expired')!;
    assert.equal(expired.occurred_at, '2024-01-15T00:00:00.000Z');
    assert.equal(ledgerTotal(), 0);
  });

  it('does not call a charge with no trial window an abandoned trial', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 30,
        // Approved and gone the same instant, and no billing date to define a
        // free period: there was never a trial to walk out of.
        activatedAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-01-01T00:00:00Z',
      },
    ]);

    const types = typesFor('1');
    assert.equal(types.includes('trial_abandoned'), false);
    assert.ok(types.includes('charge_abandoned'));
  });

  it('records the loss once when a merchant uninstalls instead of cancelling', () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: 'c1',
          shopId: '1',
          amount: 35,
          activatedAt: '2024-01-10T00:00:00Z',
          firstSaleAt: '2024-01-10T00:00:00Z',
        },
      ],
      {
        installs: [{ shopId: '1', at: '2024-01-09T00:00:00Z' }],
        uninstalls: [{ shopId: '1', at: '2024-06-01T00:00:00Z' }],
      },
    );

    const churns = eventsFor('1').filter((row) => row.type === 'unsubscribed');
    assert.equal(churns.length, 1, 'exactly one loss, not one per feed that noticed it');
    assert.equal(churns[0]!.net_change, -35);
    assert.ok(typesFor('1').includes('uninstalled'));
    assert.equal(ledgerTotal(), 0);
  });

  it('is idempotent: rebuilding produces the identical event set', () => {
    resetEnvironment();
    const db = seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 20,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
      },
    ]);

    const snapshot = () =>
      db
        .prepare('SELECT event_id, type, net_change FROM customer_events ORDER BY event_id')
        .all();
    const first = snapshot();

    rebuildDerivedTables(db);

    assert.deepEqual(snapshot(), first);
  });
});

describe('the ledger reconciles with the MRR reconstruction', () => {
  after(() => closeDb());

  /**
   * The load-bearing invariant. `net_change` accumulates forward from events
   * while MRR is rebuilt backwards from subscription state — if a classification
   * rule is wrong, these two disagree, which is precisely what makes the check
   * worth running.
   */
  it('sums every delta to the MRR the reports show', () => {
    resetEnvironment();
    seed([
      // Paid from day one.
      {
        chargeRef: 'plain',
        shopId: '1',
        amount: 50,
        activatedAt: '2024-01-10T00:00:00Z',
        firstSaleAt: '2024-01-10T00:00:00Z',
      },
      // Trialled, then converted.
      {
        chargeRef: 'trial',
        shopId: '2',
        amount: 30,
        activatedAt: '2024-02-01T00:00:00Z',
        firstSaleAt: '2024-02-20T00:00:00Z',
      },
      // Upgraded mid-life.
      {
        chargeRef: 'up-old',
        shopId: '3',
        amount: 20,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-01-05T00:00:00Z',
        churnedAt: '2024-04-01T00:00:00Z',
      },
      {
        chargeRef: 'up-new',
        shopId: '3',
        amount: 90,
        activatedAt: '2024-04-01T00:00:00Z',
        firstSaleAt: '2024-04-01T00:00:00Z',
      },
      // Churned for real.
      {
        chargeRef: 'gone',
        shopId: '4',
        amount: 45,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        churnedAt: '2024-05-01T00:00:00Z',
      },
      // Still frozen.
      {
        chargeRef: 'cold',
        shopId: '5',
        amount: 60,
        activatedAt: '2024-01-01T00:00:00Z',
        firstSaleAt: '2024-01-01T00:00:00Z',
        frozenAt: '2024-03-01T00:00:00Z',
      },
    ]);

    const mrr = runMetric('mrr', { period: 'all_time' }, { now: new Date('2024-12-01T00:00:00Z') });

    // 50 (plain) + 30 (converted trial) + 90 (upgraded) = 170.
    // Churned and frozen subscriptions contribute nothing.
    assert.equal(Math.round(mrr.value * 100) / 100, 170);
    assert.equal(ledgerTotal(), Math.round(mrr.value * 100) / 100);
  });
});

describe('the customer read model', () => {
  after(() => closeDb());

  before(() => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: 'c1',
          shopId: '7',
          amount: 75,
          activatedAt: '2024-01-10T00:00:00Z',
          firstSaleAt: '2024-01-10T00:00:00Z',
          extraSales: [
            { at: '2024-02-10T00:00:00Z', gross: 75 },
            { at: '2024-03-10T00:00:00Z', gross: 75 },
          ],
        },
        {
          chargeRef: 'c2',
          shopId: '8',
          amount: 25,
          activatedAt: '2024-02-01T00:00:00Z',
          firstSaleAt: '2024-02-01T00:00:00Z',
          churnedAt: '2024-04-01T00:00:00Z',
        },
      ],
      { installs: [{ shopId: '7', at: '2024-01-09T00:00:00Z' }] },
    );
  });

  it('finds a merchant by their myshopify domain', () => {
    const found = listCustomers({ search: 's7.example' });
    assert.equal(found.total, 1);
    assert.equal(found.customers[0]!.shopId, '7');
  });

  it('finds a merchant by name', () => {
    const found = listCustomers({ search: 'Shop 8' });
    assert.equal(found.total, 1);
    assert.equal(found.customers[0]!.shopId, '8');
  });

  /**
   * The page and its total come from one statement now (`COUNT(*) OVER ()`),
   * which is only safe if the total still counts the whole matching set rather
   * than the page — and if a page past the end still reports it.
   */
  it('reports the full total on every page, including one past the end', () => {
    const all = listCustomers({ limit: 200 });
    assert.ok(all.total >= 2, `expected at least two merchants, got ${all.total}`);

    const firstPage = listCustomers({ limit: 1, offset: 0 });
    assert.equal(firstPage.customers.length, 1);
    assert.equal(firstPage.total, all.total);

    const past = listCustomers({ limit: 1, offset: all.total + 10 });
    assert.equal(past.customers.length, 0);
    assert.equal(past.total, all.total);
  });

  it('separates a paying merchant from one who left', () => {
    const paying = listCustomers({ search: 's7.example' }).customers[0]!;
    assert.equal(paying.status, 'paying');
    assert.equal(paying.mrr, 75);
    assert.equal(paying.lifetimeGross, 225); // three charges of 75

    const churned = listCustomers({ search: 's8.example' }).customers[0]!;
    assert.equal(churned.status, 'churned');
    assert.equal(churned.mrr, 0);
  });

  it('opens a merchant with their plan, their money and their history', () => {
    const detail = getCustomer('7')!;
    assert.equal(detail.domain, 's7.example');
    assert.equal(detail.mrr, 75);
    assert.equal(detail.lifetimeGross, 225);
    assert.equal(detail.paymentCount, 3);

    const active = detail.subscriptions.filter((sub) => sub.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0]!.appId, APP_ID);
    assert.equal(active[0]!.monthlyAmount, 75);

    // The timeline is newest first and carries both lifecycle and money.
    assert.ok(detail.events.some((event) => event.type === 'subscribed'));
    assert.equal(detail.events.filter((event) => event.type === 'payment').length, 3);
    assert.ok(detail.events[0]!.occurredAt >= detail.events[detail.events.length - 1]!.occurredAt);
  });

  it('reports nothing for a shop that was never seen', () => {
    assert.equal(getCustomer('does-not-exist'), null);
  });

  /**
   * The App Store shows the day a review was posted and never the time, so a
   * review is stored at that day's midnight. Ordered on that alone it lands
   * ahead of everything else that day — including the install that had to come
   * first for the merchant to have anything to review.
   */
  it('places a same-day review after the install it must have followed', () => {
    resetEnvironment();
    seed(
      [
        {
          chargeRef: 'c1',
          shopId: '20',
          amount: 25,
          activatedAt: '2024-05-10T09:15:00Z',
          firstSaleAt: '2024-05-10T09:15:00Z',
        },
      ],
      { installs: [{ shopId: '20', at: '2024-05-10T09:14:00Z' }] },
    );

    getDb()
      .prepare(
        `INSERT INTO customer_events (
           event_id, app_id, shop_id, type, occurred_at, charge_id, prev_charge_id,
           plan_name, plan_amount, billing_interval, currency, net_change, amount,
           suppressed, detail
         ) VALUES ('review:r1:posted', ?, '20', 'review_posted', '2024-05-10T00:00:00.000Z',
                   '', '', NULL, NULL, NULL, NULL, NULL, NULL, 0, ?)`,
      )
      .run(APP_ID, JSON.stringify({ rating: 5, storeName: 'Shop 20' }));

    // Newest first, so the review must appear above — not below — the install.
    const order = getCustomer('20')!.events.map((event) => event.type);
    assert.ok(
      order.indexOf('review_posted') < order.indexOf('installed'),
      `review should follow the install, got ${order.join(' → ')}`,
    );
    assert.ok(order.indexOf('review_posted') < order.indexOf('subscribed'));

    // The stamp itself is left alone: the day is all anyone ever knew.
    const review = getCustomer('20')!.events.find((event) => event.type === 'review_posted')!;
    assert.equal(review.occurredAt, '2024-05-10T00:00:00.000Z');
  });
});

/**
 * The payment half of the table is compiled incrementally: one row per
 * transaction is millions of rows, and rewriting all of them on every sync was
 * what put the rebuild beyond a 2 GB machine. These are the properties that
 * makes safe — the output has to be identical to the wholesale rebuild it
 * replaces, and a correction still has to reach a row that was compiled before.
 */
describe('customer events: compiling payments without rewriting them', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  /** The compiled payment event for one transaction id. */
  function paymentEvent(transactionId: string): { type: string; detail: string | null } | undefined {
    return getDb()
      .prepare('SELECT type, detail FROM customer_events WHERE event_id = ?')
      .get(`tx|${transactionId}`) as { type: string; detail: string | null } | undefined;
  }

  /** A settled sale, dated whenever the test needs it. */
  function sale(id: string, at: string, gross: number): TransactionNode {
    return {
      id: `gid://partners/AppSubscriptionSale/${id}`,
      createdAt: at,
      __typename: 'AppSubscriptionSale',
      app: { id: APP_GID, name: 'Test App' },
      shop: { id: 'gid://partners/Shop/40', name: 'Shop 40', myshopifyDomain: 's40.example' },
      chargeId: 'gid://shopify/AppSubscription/c40',
      billingInterval: 'EVERY_30_DAYS',
      grossAmount: { amount: String(gross), currencyCode: 'USD' },
      netAmount: { amount: String(gross * 0.85), currencyCode: 'USD' },
      shopifyFee: { amount: String(gross * 0.15), currencyCode: 'USD' },
    };
  }

  const seedOne = () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c40',
        shopId: '40',
        amount: 20,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
      },
    ]);
  };

  it('leaves an already-compiled payment alone, and recompiles it on a full rebuild', () => {
    seedOne();
    const id = 'gid://partners/AppSubscriptionSale/c40-0';
    assert.equal(paymentEvent(id)?.type, 'payment');

    // A sentinel the compiler would never write. Surviving an incremental
    // rebuild is the proof that the row was not rewritten; being replaced by a
    // full one is the proof that `full` still means full.
    getDb()
      .prepare(`UPDATE customer_events SET detail = 'sentinel' WHERE event_id = ?`)
      .run(`tx|${id}`);

    rebuildDerivedTables(getDb());
    assert.equal(paymentEvent(id)?.detail, 'sentinel');

    rebuildDerivedTables(getDb(), { full: true });
    assert.equal(
      paymentEvent(id)?.detail,
      JSON.stringify({ source: 'AppSubscriptionSale', netAmount: 17 }),
    );
  });

  it('compiles a transaction that arrives after the first rebuild', () => {
    seedOne();
    const later = 'gid://partners/AppSubscriptionSale/c40-late';
    assert.equal(paymentEvent(later), undefined);

    insertTransactions(getDb(), [sale('c40-late', '2024-04-01T00:00:00Z', 20)]);
    rebuildDerivedTables(getDb());

    assert.equal(paymentEvent(later)?.type, 'payment');
  });

  /**
   * The sync re-reads three days behind its watermark and updates the amounts
   * in place, so a transaction inside that window is not final. The recheck
   * window is what carries the correction into the event compiled from it.
   */
  it('recompiles a transaction corrected inside the recheck window', () => {
    seedOne();
    const id = 'gid://partners/AppSubscriptionSale/c40-fresh';
    const today = new Date().toISOString();

    insertTransactions(getDb(), [sale('c40-fresh', today, 20)]);
    rebuildDerivedTables(getDb());
    assert.equal(paymentEvent(id)?.type, 'payment');

    // The Partner API restates it as a reversal, exactly as `insertTransactions`
    // would on the next overlapping pass.
    insertTransactions(getDb(), [sale('c40-fresh', today, -20)]);
    rebuildDerivedTables(getDb());

    assert.equal(paymentEvent(id)?.type, 'refund');
  });

  /** The lifecycle half is still replaced wholesale, every time. */
  it('rebuilds lifecycle events wholesale even on an incremental pass', () => {
    seedOne();
    getDb()
      .prepare(`UPDATE customer_events SET detail = 'sentinel' WHERE type = 'subscribed'`)
      .run();

    rebuildDerivedTables(getDb());

    const row = getDb()
      .prepare(`SELECT detail FROM customer_events WHERE type = 'subscribed'`)
      .get() as { detail: string | null };
    assert.notEqual(row.detail, 'sentinel');
  });
});

describe('a corrected transaction moves the money on its compiled event', () => {
  before(() => resetEnvironment());
  after(() => closeDb());

  /*
   * Regression. The upsert refreshed the event's type and net_change but not
   * its amount or currency, which was invisible for as long as the table was
   * emptied before every insert — nothing conflicted, so the clause never ran.
   * Chunking the rebuild let payment rows survive between passes, making this
   * the only path a restated transaction can take: the row would keep the old
   * figure while looking freshly written.
   */
  it('updates the amount when the Partner API restates a sale', () => {
    resetEnvironment();
    seed([
      {
        chargeRef: 'c77',
        shopId: '77',
        amount: 20,
        activatedAt: '2024-05-01T00:00:00Z',
        firstSaleAt: '2024-05-01T00:00:00Z',
      },
    ]);

    const restate = (gross: number): TransactionNode => ({
      id: 'gid://partners/AppSubscriptionSale/c77-restated',
      // Dated now, so the incremental pass treats it as still moving and
      // recompiles it. An older sale is settled and deliberately left alone,
      // which is the behaviour the neighbouring suite pins.
      createdAt: new Date().toISOString(),
      __typename: 'AppSubscriptionSale',
      app: { id: APP_GID, name: 'Test App' },
      shop: { id: 'gid://partners/Shop/77', name: 'Shop 77', myshopifyDomain: 's77.example' },
      chargeId: 'gid://shopify/AppSubscription/c77',
      billingInterval: 'EVERY_30_DAYS',
      grossAmount: { amount: String(gross), currencyCode: 'USD' },
      netAmount: { amount: String(gross), currencyCode: 'USD' },
      shopifyFee: { amount: '0', currencyCode: 'USD' },
    });

    const amountOf = () =>
      (
        getDb()
          .prepare(
            `SELECT amount, currency FROM customer_events
              WHERE event_id = 'tx|gid://partners/AppSubscriptionSale/c77-restated'`,
          )
          .get() as { amount: number | null; currency: string | null } | undefined
      );

    insertTransactions(getDb(), [restate(50)]);
    rebuildDerivedTables(getDb());
    assert.equal(amountOf()?.amount, 50, 'the first compile carries the original figure');

    // Same transaction id, restated by the Partner API at a lower gross. The
    // event already exists, so this goes through ON CONFLICT rather than INSERT.
    insertTransactions(getDb(), [restate(35)]);
    rebuildDerivedTables(getDb());

    assert.equal(amountOf()?.amount, 35, 'the compiled event must carry the corrected figure');
    assert.equal(amountOf()?.currency, 'USD');
  });
});

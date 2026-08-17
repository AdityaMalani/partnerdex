import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import {
  markCommissionPaid,
  upsertAffiliate,
  upsertAttribution,
  upsertCommission,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { persistAttribution, syncAffiliates } from '../src/affiliates/pipeline.js';
import { recomputeCommissions } from '../src/affiliates/commissionRun.js';
import type { Attribution } from '../src/affiliates/ga4Attribution.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * The wiring between the attribution pipeline, the commission engine and the
 * ledger.
 *
 * Each module is already tested on its own. What is tested here is only what
 * happens when they meet, which is where the irreversible mistakes live: a
 * re-run flipping a referral to a different affiliate, a GA4 inference
 * overwriting an admin's decision, and above all a recompute clearing a payment
 * record — the one column in this store whose value cannot be recovered from
 * anywhere else if it is lost.
 */

const DOMAIN = 's10.example';
const OTHER_DOMAIN = 's11.example';

interface Fixture {
  db: Db;
  programId: string;
  affiliateId: string;
  otherAffiliateId: string;
  handle: string;
}

/**
 * One program on the seeded app, two affiliates, and a merchant who pays $100 a
 * month. Built through the real upserts rather than raw inserts, so the test
 * exercises the same writes the import and the pipeline use.
 */
function fixture(options: { sales?: Array<{ at: string; gross: number }> } = {}): Fixture {
  const sales = options.sales ?? [
    { at: '2024-02-05T00:00:00Z', gross: 100 },
    { at: '2024-03-05T00:00:00Z', gross: 100 },
  ];

  seed([
    {
      chargeRef: 'c1',
      shopId: '10',
      amount: 100,
      activatedAt: '2024-01-05T00:00:00Z',
      firstSaleAt: sales[0]?.at,
      extraSales: sales.slice(1),
    },
  ]);

  const db = getDb();
  const programId = upsertProgram(
    {
      appId: APP_ID,
      name: 'Test Program',
      commissionRate: 0.2,
      revenueComponents: ['subscription'],
      durationMonths: null,
      unassignAfterUninstallDays: 30,
      requireApproval: true,
    },
    db,
  );

  const affiliateId = upsertAffiliate({ name: 'First', email: 'first@example.com' }, db);
  const otherAffiliateId = upsertAffiliate({ name: 'Second', email: 'second@example.com' }, db);

  upsertMembership(
    {
      affiliateId,
      programId,
      handle: 'aaaa1111',
      status: 'enrolled',
      joinedAt: '2024-01-01T00:00:00Z',
    },
    db,
  );
  upsertMembership(
    {
      affiliateId: otherAffiliateId,
      programId,
      handle: 'bbbb2222',
      status: 'enrolled',
      joinedAt: '2024-01-01T00:00:00Z',
    },
    db,
  );

  return { db, programId, affiliateId, otherAffiliateId, handle: 'aaaa1111' };
}

function ga4(overrides: Partial<Attribution> = {}): Attribution {
  return {
    appId: APP_ID,
    handle: 'aaaa1111',
    shopId: '10',
    shopDomain: DOMAIN,
    clickedAt: '2024-01-04T00:00:00.000Z',
    installedAt: '2024-01-05T00:00:00.000Z',
    anonymousId: 'ga-1',
    ...overrides,
  };
}

function liveAttribution(db: Db, programId: string, domain = DOMAIN) {
  return db
    .prepare(
      `SELECT id, affiliate_id AS affiliateId, source, shop_id AS shopId,
              referred_at AS referredAt, deleted_at AS deletedAt
         FROM affiliate_attributions
        WHERE program_id = ? AND myshopify_domain = ? AND deleted_at IS NULL`,
    )
    .get(programId, domain) as
    | {
        id: string;
        affiliateId: string;
        source: string;
        shopId: string;
        referredAt: string;
        deletedAt: string | null;
      }
    | undefined;
}

beforeEach(() => {
  resetEnvironment();
});

describe('persisting GA4 attribution', () => {
  it('records a referral once, however many times the window is re-read', () => {
    const { db, programId, affiliateId, handle } = fixture();
    const membership = { affiliateId, programId, handle };

    assert.equal(persistAttribution(db, ga4(), membership), 'created');
    assert.equal(persistAttribution(db, ga4(), membership), 'unchanged');
    assert.equal(persistAttribution(db, ga4(), membership), 'unchanged');

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_attributions')
      .get() as { n: number };
    assert.equal(rows.n, 1, 'the lookback overlap must not accumulate referrals');

    const live = liveAttribution(db, programId);
    assert.equal(live?.affiliateId, affiliateId);
    assert.equal(live?.source, 'ga4');
    // The click, not the install: it is what "before the referral" is measured
    // against when a commission is computed.
    assert.equal(live?.referredAt, '2024-01-04T00:00:00.000Z');
  });

  it('never moves a live referral to a different affiliate', () => {
    const { db, programId, affiliateId, otherAffiliateId } = fixture();

    persistAttribution(db, ga4(), { affiliateId, programId, handle: 'aaaa1111' });

    // A click that first touch would prefer, from someone else. It loses:
    // commissions have already been computed against the current owner, and
    // moving the referral would move money that was already reported.
    const outcome = persistAttribution(
      db,
      ga4({ handle: 'bbbb2222', clickedAt: '2024-01-01T00:00:00.000Z' }),
      { affiliateId: otherAffiliateId, programId, handle: 'bbbb2222' },
    );

    assert.equal(outcome, 'kept_other_affiliate');
    assert.equal(liveAttribution(db, programId)?.affiliateId, affiliateId);
  });

  it('leaves a manual attribution alone', () => {
    const { db, programId, affiliateId, handle } = fixture();

    upsertAttribution(
      {
        affiliateId,
        programId,
        shopId: '10',
        myshopifyDomain: DOMAIN,
        appId: APP_ID,
        referredAt: '2023-12-01T00:00:00.000Z',
        source: 'manual',
        handle,
      },
      db,
    );

    assert.equal(persistAttribution(db, ga4(), { affiliateId, programId, handle }), 'kept_manual');

    const live = liveAttribution(db, programId);
    assert.equal(live?.source, 'manual');
    assert.equal(live?.referredAt, '2023-12-01T00:00:00.000Z');
  });

  it('does not resurrect a referral somebody unassigned', () => {
    const { db, programId, affiliateId, handle } = fixture();
    const membership = { affiliateId, programId, handle };

    persistAttribution(db, ga4(), membership);
    db.prepare('UPDATE affiliate_attributions SET deleted_at = ?').run('2024-02-01T00:00:00.000Z');

    // The same click, still inside the lookback window. Re-creating it would
    // make an unassignment last exactly one sync interval.
    assert.equal(persistAttribution(db, ga4(), membership), 'kept_unassigned');
    assert.equal(liveAttribution(db, programId), undefined);

    // A click that lands after the removal is a new referral, not the old one.
    assert.equal(
      persistAttribution(db, ga4({ clickedAt: '2024-03-01T00:00:00.000Z' }), membership),
      'created',
    );
  });

  it('fills in the merchant once the sync has met them', () => {
    const { db, programId, affiliateId, handle } = fixture();
    const membership = { affiliateId, programId, handle };

    // GA4 knows a shop this store has never seen: the domain is kept, the shop
    // is left blank, and the referral still exists.
    assert.equal(
      persistAttribution(db, ga4({ shopId: '9999', shopDomain: OTHER_DOMAIN }), membership),
      'created',
    );
    assert.equal(liveAttribution(db, programId, OTHER_DOMAIN)?.shopId, '');

    db.prepare('INSERT INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)').run(
      '9999',
      'Later',
      OTHER_DOMAIN,
    );

    assert.equal(
      persistAttribution(db, ga4({ shopId: '9999', shopDomain: OTHER_DOMAIN }), membership),
      'updated',
    );
    assert.equal(liveAttribution(db, programId, OTHER_DOMAIN)?.shopId, '9999');
  });
});

describe('recomputing commissions', () => {
  it('pays 20% of gross on every subscription sale after the referral', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });

    const result = recomputeCommissions(db);

    assert.equal(result.attributions, 1);
    assert.equal(result.written, 2);
    assert.equal(result.amount, 40);

    const rows = db
      .prepare('SELECT amount, basis_amount AS basis, rate FROM affiliate_commissions')
      .all() as Array<{ amount: number; basis: number; rate: number }>;
    assert.deepEqual(
      rows.map((row) => row.amount),
      [20, 20],
    );
    assert.equal(rows[0]?.basis, 100);
    assert.equal(rows[0]?.rate, 20, 'the rate is stored as the percentage the engine applied');
  });

  it('is idempotent: a second run writes the same rows, not more of them', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });

    recomputeCommissions(db);
    const first = db
      .prepare('SELECT id FROM affiliate_commissions ORDER BY id')
      .all() as Array<{ id: string }>;

    recomputeCommissions(db);
    const second = db
      .prepare('SELECT id FROM affiliate_commissions ORDER BY id')
      .all() as Array<{ id: string }>;

    assert.deepEqual(second, first, 'a recompute must land on the rows it wrote last time');
  });

  /**
   * The test this file exists for.
   *
   * Payment is the one fact in the affiliate ledger that cannot be recomputed
   * from anything — it happened in PayPal, not here. A recompute that clears it
   * destroys the only record of who has been paid, and the way that failure
   * shows up in the real world is paying several hundred people twice.
   */
  it('never touches a payment record, even when the amount changes', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });
    recomputeCommissions(db);

    const commission = db
      .prepare('SELECT id FROM affiliate_commissions ORDER BY earned_at LIMIT 1')
      .get() as { id: string };

    markCommissionPaid(
      commission.id,
      { paidAt: '2024-04-01T00:00:00Z', amount: 20, reference: 'paypal-batch-7', note: 'March' },
      db,
    );

    // The program's terms change after the payment was made. Amounts are a
    // derivation and must follow; the payment is not and must not.
    db.prepare('UPDATE affiliate_programs SET commission_rate = 0.3 WHERE id = ?').run(programId);
    const result = recomputeCommissions(db);

    const after = db
      .prepare(
        `SELECT amount, paid_at AS paidAt, paid_amount AS paidAmount,
                payment_reference AS reference, payment_note AS note
           FROM affiliate_commissions WHERE id = ?`,
      )
      .get(commission.id) as {
      amount: number;
      paidAt: string;
      paidAmount: number;
      reference: string;
      note: string;
    };

    assert.equal(after.amount, 30, 'the amount is recomputed under the new rate');
    assert.equal(after.paidAt, '2024-04-01T00:00:00Z');
    assert.equal(after.paidAmount, 20);
    assert.equal(after.reference, 'paypal-batch-7');
    assert.equal(after.note, 'March');
    assert.equal(result.paidButIneligible, 0);
  });

  it('withdraws an unpaid commission that stops qualifying, and keeps the paid one', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });
    recomputeCommissions(db);

    const [first, second] = db
      .prepare('SELECT id FROM affiliate_commissions ORDER BY earned_at')
      .all() as Array<{ id: string }>;
    markCommissionPaid(first!.id, { paidAt: '2024-02-20T00:00:00Z' }, db);

    // Unassigned between the two charges: the first was earned while the
    // referral was live, the second was not.
    db.prepare('UPDATE affiliate_attributions SET deleted_at = ?').run('2024-02-20T00:00:00Z');
    const result = recomputeCommissions(db);

    const rows = db
      .prepare(
        `SELECT id, cancelled_at AS cancelledAt, paid_at AS paidAt FROM affiliate_commissions`,
      )
      .all() as Array<{ id: string; cancelledAt: string | null; paidAt: string | null }>;

    const before = rows.find((row) => row.id === first!.id);
    const after = rows.find((row) => row.id === second!.id);

    assert.equal(before?.cancelledAt, null, 'a commission already earned is not unwound');
    assert.equal(before?.paidAt, '2024-02-20T00:00:00Z');
    assert.ok(after?.cancelledAt, 'the charge after the unassignment stops being owed');
    assert.equal(result.cancelled, 1);

    // And it comes back if the referral is reinstated, rather than staying
    // withdrawn because a previous run said so.
    db.prepare('UPDATE affiliate_attributions SET deleted_at = NULL').run();
    recomputeCommissions(db);
    const revived = db
      .prepare('SELECT cancelled_at AS cancelledAt FROM affiliate_commissions WHERE id = ?')
      .get(second!.id) as { cancelledAt: string | null };
    assert.equal(revived.cancelledAt, null);
  });

  it('leaves a paid commission that no longer qualifies alone, and reports it', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });
    recomputeCommissions(db);

    const rows = db
      .prepare('SELECT id FROM affiliate_commissions ORDER BY earned_at')
      .all() as Array<{ id: string }>;
    for (const row of rows) markCommissionPaid(row.id, { paidAt: '2024-04-01T00:00:00Z' }, db);

    db.prepare('UPDATE affiliate_attributions SET deleted_at = ?').run('2024-01-10T00:00:00Z');
    const result = recomputeCommissions(db);

    assert.equal(result.paidButIneligible, 2);
    assert.equal(result.cancelled, 0);
    const cancelled = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_commissions WHERE cancelled_at IS NOT NULL')
      .get() as { n: number };
    assert.equal(cancelled.n, 0, 'unwinding a payment is a conversation, not a database write');
  });

  /**
   * Mantle's transaction ids are not ours, so every imported commission carries
   * a blank one. Without recognising them, the recompute writes a second row
   * beside each and the ledger reports roughly double what is owed.
   */
  it('adopts an imported commission instead of writing a second one beside it', () => {
    const { db, programId, affiliateId, handle } = fixture();
    persistAttribution(db, ga4(), { affiliateId, programId, handle });

    const attributionId = liveAttribution(db, programId)!.id;
    const importedId = upsertCommission(
      {
        attributionId,
        affiliateId,
        programId,
        amount: 20,
        basisAmount: 100,
        earnedAt: '2024-02-05T00:00:00.000Z',
        source: 'imported',
        externalId: 'mantle-commission-1',
        externalTransactionId: 'mantle-txn-1',
        paidAt: '2024-03-01T00:00:00Z',
        paidAmount: 20,
        paymentReference: 'mantle-payout-1',
      },
      db,
    );

    const result = recomputeCommissions(db);

    assert.equal(result.adopted, 1);
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_commissions')
      .get() as { n: number };
    assert.equal(total.n, 2, 'two charges, two rows — the imported one was recognised');

    const adopted = db
      .prepare(
        `SELECT transaction_id AS transactionId, paid_at AS paidAt, source
           FROM affiliate_commissions WHERE id = ?`,
      )
      .get(importedId) as { transactionId: string; paidAt: string; source: string };
    assert.ok(adopted.transactionId, 'the imported row now carries our transaction id');
    assert.equal(adopted.paidAt, '2024-03-01T00:00:00Z', 'its payment record survived adoption');
    assert.equal(adopted.source, 'imported', 'and it is still recorded as imported');
  });

  it('ignores referrals whose merchant has not synced yet, rather than cancelling them', () => {
    const { db, programId, affiliateId, handle } = fixture();
    const attributionId = upsertAttribution(
      {
        affiliateId,
        programId,
        myshopifyDomain: 'not-synced-yet.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
        handle,
      },
      db,
    );
    upsertCommission(
      {
        attributionId,
        affiliateId,
        programId,
        amount: 5,
        earnedAt: '2024-02-01T00:00:00Z',
        source: 'computed',
        transactionId: 'gid://partners/AppSubscriptionSale/elsewhere',
      },
      db,
    );

    const result = recomputeCommissions(db);

    assert.equal(result.unresolvedAttributions, 1);
    assert.equal(result.cancelled, 0, 'unexamined is not the same as no longer owed');
  });
});

describe('the affiliate step of a sync', () => {
  it('resolves merchants, recomputes, and survives BigQuery being absent', async () => {
    const { db, programId, affiliateId, handle } = fixture();

    // A referral that arrived before its merchant did — the state a large share
    // of the imported referrals were in on import day.
    upsertAttribution(
      {
        affiliateId,
        programId,
        myshopifyDomain: DOMAIN,
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'imported',
        handle,
      },
      db,
    );

    const result = await syncAffiliates(db, [APP_ID]);

    assert.equal(result.error, null, 'no BigQuery connection is not an error');
    assert.deepEqual(result.attribution.apps, []);
    assert.equal(result.shopsResolved, 1);
    assert.equal(result.commissions?.written, 2);

    const resolved = db
      .prepare('SELECT shop_id AS shopId FROM affiliate_attributions')
      .get() as { shopId: string };
    assert.equal(resolved.shopId, '10');
  });

  it('does nothing at all when no affiliate ledger exists', async () => {
    resetEnvironment();
    seed([
      { chargeRef: 'c1', shopId: '10', amount: 100, activatedAt: '2024-01-05T00:00:00Z', firstSaleAt: '2024-02-05T00:00:00Z' },
    ]);

    const result = await syncAffiliates(getDb(), [APP_ID]);
    assert.equal(result.commissions, null);
    assert.equal(result.shopsResolved, 0);
    assert.equal(result.error, null);
  });
});

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { lookupMerchant, lookupMerchants } from '../src/merchants/index.js';
import { listReferrals } from '../src/affiliates/admin.js';
import {
  upsertAffiliate,
  upsertAttribution,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * The shared merchant read model.
 *
 * The cases below are the five populations the admin actually contains, and the
 * last two are the ones worth the most attention: a merchant we hold a `shops`
 * row for but no billing history, and a merchant we have never heard of. Both
 * are common right now — `subscriptions` and `install_intervals` are empty in
 * production until the transaction backfill finishes — and both must come back
 * as `unknown` rather than as "free" or "uninstalled". A wrong confident answer
 * about whether a merchant pays us is the failure this model exists to prevent.
 */

/** Fixed, so liveness is a property of the fixtures rather than of the clock. */
const NOW = '2024-06-01T00:00:00Z';

let db: Db;
let programId: string;
let affiliateId: string;

before(() => {
  resetEnvironment();

  seed(
    [
      // Paying and installed: converted in February, never cancelled.
      {
        chargeRef: 'm1',
        shopId: '10',
        amount: 100,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
      // Installed, and paid once — then cancelled. We have their billing
      // history, so "not paying" here is an observation, not an absence.
      {
        chargeRef: 'm2',
        shopId: '11',
        amount: 50,
        activatedAt: '2024-01-06T00:00:00Z',
        firstSaleAt: '2024-02-06T00:00:00Z',
        churnedAt: '2024-03-01T00:00:00Z',
      },
    ],
    {
      installs: [
        { shopId: '10', at: '2024-01-01T00:00:00Z' },
        { shopId: '11', at: '2024-01-01T00:00:00Z' },
        { shopId: '12', at: '2024-01-01T00:00:00Z' },
      ],
      uninstalls: [{ shopId: '12', at: '2024-05-01T00:00:00Z' }],
    },
  );

  db = getDb();

  /*
   * A shop the Partner API has introduced us to and nothing else has. This is
   * every merchant in production today: `shops` is populated, the two derived
   * tables are not. Written straight in because that is exactly what the sync
   * does — `shops` is a source table, and the derived pair is rebuilt later.
   */
  db.prepare('INSERT INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)').run(
    '13',
    'Quiet Store',
    'Quiet-Store.myshopify.com',
  );

  programId = upsertProgram(
    {
      appId: APP_ID,
      name: 'Test Program',
      commissionRate: 0.2,
      revenueComponents: ['subscription'],
      unassignAfterUninstallDays: 30,
      requireApproval: false,
    },
    db,
  );
  affiliateId = upsertAffiliate({ name: 'Ada Referrer', email: 'ada@example.com' }, db);
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

  const refer = (shopId: string, domain: string) =>
    upsertAttribution(
      {
        affiliateId,
        programId,
        shopId,
        myshopifyDomain: domain,
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
        handle: 'aaaa1111',
      },
      db,
    );

  refer('10', 's10.example');
  refer('11', 's11.example');
  refer('12', 's12.example');
  // The sizeable-share case: a domain, no shop id, and the shop row exists
  // anyway. The read model has to find it on the domain or this merchant stays
  // anonymous until a backfill pass rewrites the column.
  refer('', 'quiet-store.myshopify.com');
  // And the other half of that case: a domain we have no shop row for at all.
  refer('', 'never-synced.myshopify.com');
});

describe('the merchant read model', () => {
  it('reports a live subscription with its plan and monthly amount', () => {
    const merchant = lookupMerchant({ shopId: '10' }, db, { now: NOW });
    assert.equal(merchant.known, true);
    assert.equal(merchant.shopId, '10');
    assert.equal(merchant.myshopifyDomain, 's10.example');
    assert.equal(merchant.name, 'Shop 10');
    assert.equal(merchant.install, 'installed');
    assert.equal(merchant.plan, 'paying');
    assert.equal(merchant.planName, 'Plan');
    assert.equal(merchant.monthlyAmount, 100);
    assert.equal(merchant.currency, 'USD');
  });

  it('separates installed-and-not-paying from installed-and-unknown', () => {
    // Cancelled in March, still installed. We hold their subscription rows, so
    // "not paying" is something we observed rather than something missing.
    const churned = lookupMerchant({ shopId: '11' }, db, { now: NOW });
    assert.equal(churned.install, 'installed');
    assert.equal(churned.plan, 'free');
    assert.equal(churned.planName, null);
    assert.equal(churned.monthlyAmount, null);

    // Installed and never billed: no subscription row was ever written, so
    // there is nothing to observe and the answer is "we do not know".
    const silent = lookupMerchant({ shopId: '12' }, db, { now: '2024-04-01T00:00:00Z' });
    assert.equal(silent.install, 'installed');
    assert.equal(silent.plan, 'unknown');
  });

  it('reports an uninstalled merchant as uninstalled', () => {
    const merchant = lookupMerchant({ shopId: '12' }, db, { now: NOW });
    assert.equal(merchant.known, true);
    assert.equal(merchant.install, 'uninstalled');
  });

  it('answers unknown, not free, for a shop with no derived rows yet', () => {
    // The production shape today. Everything about this merchant beyond their
    // name and domain is unsynced, and none of it may read as $0 or churned.
    const merchant = lookupMerchant({ myshopifyDomain: 'quiet-store.myshopify.com' }, db, {
      now: NOW,
    });
    assert.equal(merchant.known, true);
    assert.equal(merchant.shopId, '13');
    assert.equal(merchant.name, 'Quiet Store');
    // Matched case-insensitively: 8 of production's 18,188 shop rows carry an
    // upper-case character in their domain while the affiliate tables normalise.
    assert.equal(merchant.myshopifyDomain, 'quiet-store.myshopify.com');
    assert.equal(merchant.install, 'unknown');
    assert.equal(merchant.plan, 'unknown');
    assert.equal(merchant.monthlyAmount, null);
  });

  it('does not invent a merchant that is not in shops at all', () => {
    const merchant = lookupMerchant(
      { myshopifyDomain: 'never-synced.myshopify.com', fallbackName: 'As Claimed Ltd' },
      db,
      { now: NOW },
    );
    assert.equal(merchant.known, false);
    assert.equal(merchant.shopId, null);
    assert.equal(merchant.myshopifyDomain, 'never-synced.myshopify.com');
    // The only name anybody holds is the one the claimant typed. It is passed
    // through rather than dropped, and never presented as `shops.name`.
    assert.equal(merchant.name, 'As Claimed Ltd');
    assert.equal(merchant.install, 'unknown');
    assert.equal(merchant.plan, 'unknown');
  });

  it('resolves a page of merchants positionally, in one pass', () => {
    const merchants = lookupMerchants(
      [
        { shopId: '10' },
        { myshopifyDomain: 'never-synced.myshopify.com' },
        { shopId: '', myshopifyDomain: 'quiet-store.myshopify.com' },
      ],
      db,
      { now: NOW },
    );
    assert.equal(merchants.length, 3);
    assert.deepEqual(
      merchants.map((row) => row.known),
      [true, false, true],
    );
  });
});

describe('searching referrals by merchant', () => {
  it('matches on the myshopify domain', () => {
    const found = listReferrals({ search: 's11.example' }, db);
    assert.equal(found.total, 1);
    assert.equal(found.referrals[0]!.myshopifyDomain, 's11.example');
  });

  it('matches on the store name, which lives only in shops', () => {
    // "Quiet Store" appears in no affiliate table — the referral carries a
    // domain and nothing else — so a match here proves the join outward.
    const found = listReferrals({ search: 'quiet st' }, db);
    assert.equal(found.total, 1);
    assert.equal(found.referrals[0]!.merchant.name, 'Quiet Store');
  });

  it('is case-insensitive and matches a substring of either', () => {
    assert.equal(listReferrals({ search: 'QUIET' }, db).total, 1);
    assert.equal(listReferrals({ search: 'SHOP 1' }, db).total, 3, 'Shop 10, 11 and 12');
    assert.equal(listReferrals({ search: '.example' }, db).total, 3);
  });

  it('runs beside the paging rather than after it', () => {
    // A page of one out of five rows: if search ran after paging this would
    // find nothing, because the matching row is not on page one of five.
    const page = listReferrals({ search: 'never-synced', limit: 1, page: 1 }, db);
    assert.equal(page.total, 1);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.referrals[0]!.merchant.known, false);
  });

  it('carries the merchant onto every referral row', () => {
    const all = listReferrals({}, db);
    assert.equal(all.total, 5);
    const paying = all.referrals.find((row) => row.shopId === '10');
    assert.equal(paying!.merchant.plan, 'paying');
    const unsynced = all.referrals.find(
      (row) => row.myshopifyDomain === 'never-synced.myshopify.com',
    );
    assert.equal(unsynced!.merchant.known, false);
    assert.equal(unsynced!.merchant.plan, 'unknown');
  });
});

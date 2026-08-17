import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { importMantleExport } from '../src/affiliates/import.js';
import type { MantleExport } from '../src/affiliates/mantle.js';
import {
  linkCommissionsToPayouts,
  upsertAffiliate,
  upsertAttribution,
  upsertCommission,
  upsertMembership,
  upsertPayout,
  upsertProgram,
} from '../src/affiliates/store.js';
import { issueResetToken } from '../src/server/portalAuth.js';
import { resetEnvironment } from './helpers.js';

/**
 * Payouts: the record of payments made outside this system.
 *
 * Three things are worth testing and the rest is plumbing.
 *
 * **The link.** A payout is only useful if it can say what it paid for, and that
 * association is carried by `payment_reference` — a string written by an import
 * out of a platform that no longer exists. So the tests assert both directions:
 * what links, and what is left over. A link rate that silently drops from 934 to
 * 600 would still render a page.
 *
 * **The scoping.** The portal endpoints are the first place an affiliate can ask
 * this system about money, and the assertions are written negatively wherever
 * they can be — not "A sees two payouts" but "nothing in A's response belongs to
 * B" — because a filter that stops filtering passes the first form and fails the
 * second.
 *
 * **The arithmetic.** A payout's amount and the commissions it names are two
 * separate imported facts, and where they disagree the disagreement is the
 * finding. The import reports it rather than reconciling it away.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const A_PASSWORD = 'affiliate-one-password';

let server: Server;
let origin: string;
let db: Db;

const ids = {
  stoq: '',
  filemonk: '',
  alice: '',
  bob: '',
  alicePayout: '',
  aliceRequested: '',
  bobPayout: '',
};

const get = (path: string, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} });

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const admin = async (path: string): Promise<any> => {
  const response = await fetch(`${origin}${path}`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(response.status, 200, `${path} should answer 200`);
  return response.json();
};

let adminCookie = '';
let aliceCookie = '';

/**
 * Two affiliates with overlapping shapes: both on Stoq, both paid, both with a
 * commission settled by their own payout. Anything that leaks between them
 * therefore leaks something that looks entirely plausible on the other's page.
 */
function seed(): void {
  db.prepare(`INSERT INTO apps (id, name, discovered_at) VALUES ('111', 'STOQ', '2024-01-01')`).run();
  db.prepare(
    `INSERT INTO apps (id, name, discovered_at) VALUES ('222', 'Filemonk', '2024-01-01')`,
  ).run();
  db.prepare(`INSERT INTO shops (id, name, myshopify_domain)
              VALUES ('s-1', 'Acme Supply', 'acme.myshopify.com')`).run();
  db.prepare(`INSERT INTO shops (id, name, myshopify_domain)
              VALUES ('s-2', 'Beta Goods', 'beta.myshopify.com')`).run();

  ids.stoq = upsertProgram(
    {
      appId: '111',
      name: 'STOQ',
      commissionRate: 0.2,
      listingUrl: 'https://apps.shopify.com/back-in-stock-restock-alerts',
    },
    db,
  );
  ids.filemonk = upsertProgram(
    {
      appId: '222',
      name: 'Filemonk',
      commissionRate: 0.2,
      durationMonths: 24,
      revenueComponents: ['subscription'],
      listingUrl: 'https://apps.shopify.com/filemonk',
    },
    db,
  );

  ids.alice = upsertAffiliate({ name: 'Alice', email: 'alice@example.com' }, db);
  ids.bob = upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, db);

  upsertMembership(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      handle: 'aliceaaa',
      status: 'enrolled',
      joinedAt: '2025-01-01T00:00:00.000Z',
      approvedAt: '2025-01-02T00:00:00.000Z',
    },
    db,
  );
  // Pending, so `/programs` has a membership that must not hand over a link.
  upsertMembership(
    {
      affiliateId: ids.alice,
      programId: ids.filemonk,
      handle: 'alicebbb',
      status: 'pending',
      joinedAt: '2025-02-01T00:00:00.000Z',
    },
    db,
  );
  upsertMembership(
    {
      affiliateId: ids.bob,
      programId: ids.stoq,
      handle: 'bobbbbbb',
      status: 'enrolled',
      joinedAt: '2025-01-01T00:00:00.000Z',
    },
    db,
  );

  const aliceReferral = upsertAttribution(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      shopId: 's-1',
      myshopifyDomain: 'acme.myshopify.com',
      appId: '111',
      referredAt: '2025-03-01T00:00:00.000Z',
      source: 'ga4',
      handle: 'aliceaaa',
    },
    db,
  );
  const bobReferral = upsertAttribution(
    {
      affiliateId: ids.bob,
      programId: ids.stoq,
      shopId: 's-2',
      myshopifyDomain: 'beta.myshopify.com',
      appId: '111',
      referredAt: '2025-03-05T00:00:00.000Z',
      source: 'ga4',
      handle: 'bobbbbbb',
    },
    db,
  );

  ids.alicePayout = upsertPayout(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      number: '1001',
      status: 'paid',
      amount: 30,
      amountPaid: 30,
      periodStart: '2025-03-01T00:00:00.000Z',
      periodEnd: '2025-04-30T00:00:00.000Z',
      paidAt: '2025-05-01T00:00:00.000Z',
      paymentMethod: 'paypal',
      externalId: 'mantle-payout-alice',
    },
    db,
  );
  ids.aliceRequested = upsertPayout(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      number: '1003',
      status: 'requested',
      amount: 12,
      periodStart: '2025-05-01T00:00:00.000Z',
      periodEnd: '2025-06-30T00:00:00.000Z',
      externalId: 'mantle-payout-alice-2',
    },
    db,
  );
  ids.bobPayout = upsertPayout(
    {
      affiliateId: ids.bob,
      programId: ids.stoq,
      number: '1002',
      status: 'paid',
      amount: 999,
      amountPaid: 999,
      paidAt: '2025-05-02T00:00:00.000Z',
      paymentMethod: 'stripe',
      externalId: 'mantle-payout-bob',
    },
    db,
  );

  // Alice: two commissions in the paid payout, one in the requested one, one in
  // neither. Bob: one, which is the row that must never appear on Alice's page.
  const commission = (
    attributionId: string,
    affiliateId: string,
    id: string,
    amount: number,
    reference: string | null,
    paidAt: string | null,
  ): void => {
    upsertCommission(
      {
        attributionId,
        affiliateId,
        programId: ids.stoq,
        transactionId: id,
        amount,
        // Deliberately unmistakable, so the leak test below can assert on the
        // value and not only on the column name.
        basisAmount: amount * 1000 + 0.5,
        rate: 0.2,
        earnedAt: '2025-03-15T00:00:00.000Z',
        paymentReference: reference,
        paidAt,
        paidAmount: paidAt ? amount : null,
      },
      db,
    );
  };

  commission(aliceReferral, ids.alice, 'txn-a1', 20, 'mantle-payout-alice', '2025-05-01T00:00:00.000Z');
  commission(aliceReferral, ids.alice, 'txn-a2', 10, 'mantle-payout-alice', '2025-05-01T00:00:00.000Z');
  commission(aliceReferral, ids.alice, 'txn-a3', 12, 'mantle-payout-alice-2', null);
  commission(aliceReferral, ids.alice, 'txn-a4', 7, null, null);
  commission(bobReferral, ids.bob, 'txn-b1', 999, 'mantle-payout-bob', '2025-05-02T00:00:00.000Z');
  // Paid by something that is not a payout we hold — a later PayPal batch. It
  // must stay unlinked and it must be counted, not swallowed.
  commission(bobReferral, ids.bob, 'txn-b2', 5, 'paypal-batch-77', '2025-06-01T00:00:00.000Z');

  linkCommissionsToPayouts(db);
}

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: ADMIN_PASSWORD });
  db = getDb();
  seed();

  const { token } = issueResetToken(db, ids.alice);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  assert.equal(
    (await post('/portal/api/auth/set-password', { token, password: A_PASSWORD })).status,
    200,
  );
  const login = await post('/portal/api/auth/login', {
    email: 'alice@example.com',
    password: A_PASSWORD,
  });
  aliceCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

  const adminLogin = await post('/api/auth/login', { password: ADMIN_PASSWORD });
  adminCookie = (adminLogin.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(() => server.close());

describe('linking commissions to the payouts that settled them', () => {
  it('links every commission whose reference names a payout', () => {
    const report = linkCommissionsToPayouts(db);
    // Three of Alice's and one of Bob's. Nothing new to do on a second call,
    // which is what makes the import safe to re-run.
    assert.equal(report.linked, 4);
    assert.equal(report.newlyLinked, 0);
  });

  it('counts a payment it cannot itemise instead of hiding it', () => {
    const report = linkCommissionsToPayouts(db);
    // Bob's PayPal batch: paid, references something, and that something is not
    // a payout here. Both counters have to see it.
    assert.equal(report.paidWithoutPayout, 1);
    assert.equal(report.danglingReferences, 1);
  });

  it('leaves the payer\'s own reference alone when it names no payout', () => {
    const row = db
      .prepare(
        `SELECT payment_reference AS reference, payout_id AS payoutId
           FROM affiliate_commissions WHERE transaction_id = 'txn-b2'`,
      )
      .get() as { reference: string; payoutId: string };
    // The evidence that the payment happened survives the failure to join it.
    assert.equal(row.reference, 'paypal-batch-77');
    assert.equal(row.payoutId, '');
  });
});

describe('the admin payout list', () => {
  it('returns the agreed shape', async () => {
    const body = await admin('/api/affiliates/payouts');
    assert.equal(body.total, 3);
    assert.equal(body.hasNextPage, false);
    assert.equal(body.hasPreviousPage, false);

    const payout = body.payouts.find((row: any) => row.number === '1001');
    assert.deepEqual(Object.keys(payout).sort(), [
      'affiliateEmail',
      'affiliateId',
      'affiliateName',
      'amount',
      'amountPaid',
      'commissionCount',
      'id',
      'number',
      'paidAt',
      'paymentMethod',
      'periodEnd',
      'periodStart',
      'programId',
      'programName',
      'status',
    ]);
    assert.equal(payout.affiliateName, 'Alice');
    assert.equal(payout.programName, 'STOQ');
    assert.equal(payout.amount, 30);
    assert.equal(payout.amountPaid, 30);
    assert.equal(payout.commissionCount, 2);
    assert.equal(payout.paymentMethod, 'paypal');
  });

  it('says nothing was sent for a payout that was only requested', async () => {
    const body = await admin('/api/affiliates/payouts?status=requested');
    assert.equal(body.total, 1);
    assert.equal(body.payouts[0].amountPaid, null);
    assert.equal(body.payouts[0].paidAt, null);
  });

  it('filters by affiliate and by program', async () => {
    const byAffiliate = await admin(`/api/affiliates/payouts?affiliateId=${ids.bob}`);
    assert.equal(byAffiliate.total, 1);
    assert.equal(byAffiliate.payouts[0].affiliateName, 'Bob');

    const byProgram = await admin(`/api/affiliates/payouts?programId=${ids.filemonk}`);
    assert.equal(byProgram.total, 0);
  });

  it('pages, and says which way there is more', async () => {
    const first = await admin('/api/affiliates/payouts?page=1&limit=2&sort=amount&sortDirection=asc');
    assert.equal(first.payouts.length, 2);
    assert.equal(first.hasNextPage, true);
    assert.equal(first.hasPreviousPage, false);
    assert.deepEqual(
      first.payouts.map((row: any) => row.amount),
      [12, 30],
    );

    const second = await admin('/api/affiliates/payouts?page=2&limit=2&sort=amount&sortDirection=asc');
    assert.equal(second.payouts.length, 1);
    assert.equal(second.hasNextPage, false);
    assert.equal(second.hasPreviousPage, true);
  });

  it('ignores a sort column it does not recognise rather than running it', async () => {
    // The value reaches an ORDER BY clause, so the allowlist is the defence.
    const body = await admin('/api/affiliates/payouts?sort=amount%3B%20DROP%20TABLE%20apps');
    assert.equal(body.total, 3);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM apps`).get() as { n: number }).n,
      2,
    );
  });

  it('itemises one payout with the commissions it settled', async () => {
    const body = await admin(`/api/affiliates/payouts/${ids.alicePayout}`);
    assert.equal(body.payout.number, '1001');
    assert.equal(body.commissions.length, 2);
    assert.equal(
      body.commissions.reduce((sum: number, row: any) => sum + row.amount, 0),
      body.payout.amount,
    );
    // The commissions this payout paid for, not the ones inside its period.
    assert.ok(body.commissions.every((row: any) => row.paidAt === '2025-05-01T00:00:00.000Z'));
  });

  it('404s an unknown payout instead of an empty one', async () => {
    const response = await fetch(`${origin}/api/affiliates/payouts/nope`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(response.status, 404);
  });

  it('sits behind the dashboard password', async () => {
    assert.equal((await get('/api/affiliates/payouts')).status, 401);
    assert.equal((await get(`/api/affiliates/payouts/${ids.alicePayout}`)).status, 401);
  });
});

describe('the portal payout list', () => {
  it('requires a session', async () => {
    assert.equal((await get('/portal/api/payouts')).status, 401);
    assert.equal((await get('/portal/api/programs')).status, 401);
  });

  it('returns the agreed shape for the affiliate in the session', async () => {
    const body = await (await get('/portal/api/payouts', aliceCookie)).json();
    assert.equal(body.total, 2);
    assert.equal(body.hasNextPage, false);
    assert.equal(body.hasPreviousPage, false);
    assert.deepEqual(Object.keys(body.payouts[0]).sort(), [
      'amount',
      'amountPaid',
      'id',
      'number',
      'paidAt',
      'paymentMethod',
      'periodEnd',
      'periodStart',
      'programName',
      'status',
    ]);
  });

  /**
   * The negative form, deliberately. Bob's payout is a plausible row: same
   * program, same shape, larger number. A scoping predicate that stopped
   * applying would render it without anything looking wrong.
   */
  it('contains nothing belonging to another affiliate', async () => {
    const body = await (await get('/portal/api/payouts?limit=200', aliceCookie)).json();
    const serialized = JSON.stringify(body);

    for (const forbidden of [ids.bob, ids.bobPayout, 'Bob', 'bob@example.com', 'stripe']) {
      assert.ok(
        !serialized.includes(forbidden),
        `Alice's payouts should not mention ${forbidden}`,
      );
    }
    // Bob's amount is checked on the parsed rows rather than the serialized
    // body. As a bare substring `999` also matches a slice of a random UUID,
    // which payout ids are, so the string form failed a few percent of runs on
    // a response that was entirely correct.
    assert.ok(body.payouts.every((row: any) => Number(row.amount) !== 999));
    assert.ok(body.payouts.every((row: any) => row.number !== '1002'));
  });

  it('never names the affiliate, the merchant, or the merchant\'s revenue', async () => {
    const serialized = JSON.stringify(
      await (await get('/portal/api/payouts', aliceCookie)).json(),
    );
    // `basis_amount` is the merchant's gross. It is not on this endpoint's rows
    // at all, and this asserts the values as well as the names.
    for (const forbidden of ['basis', 'affiliateId', 'myshopify', 'Acme', '20000.5', '10000.5']) {
      assert.ok(!serialized.includes(forbidden), `should not expose ${forbidden}`);
    }
  });

  it('cannot be pointed at another affiliate by a parameter', async () => {
    // Nothing in the route reads an affiliate from input; this pins that. If a
    // filter were ever added, this test fails rather than the leak going quiet.
    for (const query of [
      `?affiliateId=${ids.bob}`,
      `?affiliate_id=${ids.bob}`,
      `?id=${ids.bobPayout}`,
    ]) {
      const body = await (await get(`/portal/api/payouts${query}`, aliceCookie)).json();
      assert.equal(body.total, 2, `${query} should not change what Alice sees`);
      assert.ok(!JSON.stringify(body).includes(ids.bobPayout));
    }
  });
});

describe('the portal program list', () => {
  it('returns the terms and a shareable link for an enrolled membership', async () => {
    const body = await (await get('/portal/api/programs', aliceCookie)).json();
    assert.equal(body.programs.length, 2);

    const stoq = body.programs.find((row: any) => row.programName === 'STOQ');
    assert.deepEqual(Object.keys(stoq).sort(), [
      'appName',
      'approvedAt',
      'commissionRate',
      'durationMonths',
      'handle',
      'joinedAt',
      'programId',
      'programName',
      'referralUrl',
      'revenueComponents',
      'status',
      // The release window, added when `terms.ts` stopped hardcoding 30 days.
      // This list is an exact set on purpose — it is the assertion that nothing
      // about a merchant or anybody else's money ever joins this payload — so a
      // new field belongs here deliberately rather than by loosening the check.
      'unassignAfterUninstallDays',
    ]);
    assert.equal(stoq.handle, 'aliceaaa');
    assert.equal(stoq.commissionRate, 0.2);
    assert.equal(stoq.durationMonths, null, 'Stoq is lifetime');
    assert.deepEqual(stoq.revenueComponents, ['subscription']);
    assert.equal(
      stoq.referralUrl,
      'https://apps.shopify.com/back-in-stock-restock-alerts?mref=aliceaaa',
    );
  });

  it('withholds the link from a membership still awaiting approval', async () => {
    const body = await (await get('/portal/api/programs', aliceCookie)).json();
    const filemonk = body.programs.find((row: any) => row.programName === 'Filemonk');
    assert.equal(filemonk.status, 'pending');
    assert.equal(filemonk.referralUrl, null);
    assert.equal(filemonk.durationMonths, 24);
  });

  it('lists only the programs this affiliate belongs to', async () => {
    const body = await (await get('/portal/api/programs', aliceCookie)).json();
    const serialized = JSON.stringify(body);
    for (const forbidden of ['bobbbbbb', ids.bob, 'Bob']) {
      assert.ok(!serialized.includes(forbidden), `should not mention ${forbidden}`);
    }
  });
});

/**
 * The import, on a miniature of the real export.
 *
 * The shapes here are the ones that actually caused trouble against Mantle's 26
 * rows: a payout that names no program, a payout that was requested and never
 * paid, and a second run over the same file.
 */
describe('importing payouts', () => {
  const exportFixture = (): MantleExport => ({
    affiliates: [
      {
        id: 'm-aff-1',
        name: 'Imported Affiliate',
        email: 'imported@example.com',
        createdAt: '2024-01-01T00:00:00.000Z',
        memberships: [
          {
            id: 'm-mem-1',
            affiliateId: 'm-aff-1',
            affiliateProgramId: 'm-prog-1',
            handle: 'impaaaaa',
            status: 'enrolled',
            createdAt: '2024-01-01T00:00:00.000Z',
            affiliateProgram: {
              id: 'm-prog-1',
              rules: { percentCommission: 20, revenueComponents: ['subscription'] },
              app: { name: 'Stoq', displayName: 'STOQ' },
            },
          },
        ],
      },
    ],
    attributions: [
      {
        id: 'm-attr-1',
        affiliateId: 'm-aff-1',
        affiliateProgramId: 'm-prog-1',
        date: '2024-02-01T00:00:00.000Z',
        createdAt: '2024-02-01T00:00:00.000Z',
        appInstallation: { myshopifyDomain: 'imported.myshopify.com', platformId: '9' },
      },
    ],
    commissions: [
      {
        id: 'm-comm-1',
        affiliateId: 'm-aff-1',
        affiliateProgramId: 'm-prog-1',
        affiliateAttributionId: 'm-attr-1',
        transactionId: 'm-txn-1',
        amount: 40,
        date: '2024-03-01T00:00:00.000Z',
        payoutId: 'm-pay-1',
        transaction: { date: '2024-03-01T00:00:00.000Z', grossAmount: 200 },
      },
      {
        id: 'm-comm-2',
        affiliateId: 'm-aff-1',
        affiliateProgramId: 'm-prog-1',
        affiliateAttributionId: 'm-attr-1',
        transactionId: 'm-txn-2',
        amount: 15,
        date: '2024-04-01T00:00:00.000Z',
        payoutId: 'm-pay-2',
        transaction: { date: '2024-04-01T00:00:00.000Z', grossAmount: 75 },
      },
    ],
    payouts: [
      {
        id: 'm-pay-1',
        number: 1000,
        affiliateId: 'm-aff-1',
        // No program, like Mantle's seven earliest payouts.
        affiliateProgramId: null as unknown as string,
        status: 'paid',
        amount: 40,
        amountPaid: 40,
        periodStart: '2024-02-01T00:00:00.000Z',
        periodEnd: '2024-03-31T00:00:00.000Z',
        paidAt: '2024-04-05T00:00:00.000Z',
        paymentMethod: 'paypal',
        createdAt: '2024-04-01T00:00:00.000Z',
      },
      {
        id: 'm-pay-2',
        number: 1001,
        affiliateId: 'm-aff-1',
        affiliateProgramId: 'm-prog-1',
        status: 'requested',
        amount: 15,
        amountPaid: null,
        createdAt: '2024-05-01T00:00:00.000Z',
      },
    ],
  });

  it('imports payouts, links their commissions, and reconciles', () => {
    const report = importMantleExport(exportFixture(), { db });

    assert.equal(report.payouts.total, 2);
    assert.equal(report.payouts.imported, 2);
    assert.deepEqual(report.payouts.byStatus, { paid: 1, requested: 1 });
    assert.equal(report.payouts.paidAmount, 40);
    assert.equal(report.payouts.outstandingAmount, 15);
    assert.deepEqual(report.payouts.orphaned, []);
    assert.deepEqual(report.payouts.amountMismatches, []);
    assert.equal(report.payouts.link.newlyLinked, 2);
  });

  it('fills a missing program from the commissions the payout paid for', () => {
    const row = db
      .prepare(
        `SELECT p.program_id AS programId, prog.name AS programName
           FROM affiliate_payouts p
           LEFT JOIN affiliate_programs prog ON prog.id = p.program_id
          WHERE p.external_id = 'm-pay-1'`,
      )
      .get() as { programId: string | null; programName: string | null };
    assert.ok(row.programId, 'the unanimous program of its commissions');
    assert.equal(row.programName, 'STOQ');
  });

  it('does not record a payment for a payout that was only requested', () => {
    const payout = db
      .prepare(
        `SELECT status, paid_at AS paidAt, amount_paid AS amountPaid
           FROM affiliate_payouts WHERE external_id = 'm-pay-2'`,
      )
      .get() as { status: string; paidAt: string | null; amountPaid: number | null };
    assert.equal(payout.status, 'requested');
    assert.equal(payout.paidAt, null);
    assert.equal(payout.amountPaid, null);

    // Its commission is linked to it — that is what it will settle — and is
    // still unpaid, because nothing has been sent.
    const commission = db
      .prepare(
        `SELECT paid_at AS paidAt, payout_id AS payoutId
           FROM affiliate_commissions WHERE external_id = 'm-comm-2'`,
      )
      .get() as { paidAt: string | null; payoutId: string };
    assert.equal(commission.paidAt, null);
    assert.notEqual(commission.payoutId, '');
  });

  it('is idempotent: a second run writes no second payout', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM affiliate_payouts').get() as { n: number };
    const report = importMantleExport(exportFixture(), { db });
    const after = db.prepare('SELECT COUNT(*) AS n FROM affiliate_payouts').get() as { n: number };

    assert.equal(after.n, before.n);
    assert.equal(report.payouts.link.newlyLinked, 0, 'nothing left to link');
  });

  it('reports a payout whose amount disagrees with what it settled', () => {
    const data = exportFixture();
    // The payer sent more than the commissions add up to. Both figures are
    // imported facts; the disagreement is the finding, not an error to fix.
    data.payouts[0]!.amount = 55;
    data.payouts[0]!.amountPaid = 55;

    const report = importMantleExport(data, { db });
    const mismatch = report.payouts.amountMismatches.find((row) => row.number === '1000');
    assert.ok(mismatch, 'the disagreement should be reported');
    assert.equal(mismatch.amount, 55);
    assert.equal(mismatch.commissionAmount, 40);
    assert.equal(mismatch.commissionCount, 1);
  });
});

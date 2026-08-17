import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import {
  markCommissionPaid,
  upsertAffiliate,
  upsertAttribution,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { recomputeCommissions } from '../src/affiliates/commissionRun.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * The admin API over a real socket.
 *
 * Exercised end to end rather than as function calls, because two of the things
 * worth asserting are properties of the mounting rather than of the queries:
 * that the whole router sits behind the dashboard password, and that a fixed
 * path like `/reconciliation` is not swallowed by `/:affiliateId`.
 *
 * The rest is the money surface — balances, the approval queue, and manual
 * attribution, which accounts for a large minority of the referrals carried over
 * from Mantle and is the only way to credit a referral GA4 could never see.
 */

let server: Server;
let origin: string;
let db: Db;
let programId: string;
let affiliateId: string;
let otherAffiliateId: string;
let membershipId: string;

const json = async (path: string, init?: RequestInit): Promise<[number, any]> => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return [response.status, await response.json()];
};

before(async () => {
  resetEnvironment();

  seed([
    {
      chargeRef: 'c1',
      shopId: '10',
      amount: 100,
      activatedAt: '2024-01-05T00:00:00Z',
      firstSaleAt: '2024-02-05T00:00:00Z',
      extraSales: [{ at: '2024-03-05T00:00:00Z', gross: 100 }],
    },
    {
      chargeRef: 'c2',
      shopId: '11',
      amount: 50,
      activatedAt: '2024-01-06T00:00:00Z',
      firstSaleAt: '2024-02-06T00:00:00Z',
    },
  ]);

  db = getDb();
  programId = upsertProgram(
    {
      appId: APP_ID,
      name: 'Test Program',
      commissionRate: 0.2,
      revenueComponents: ['subscription'],
      unassignAfterUninstallDays: 30,
      requireApproval: true,
    },
    db,
  );

  affiliateId = upsertAffiliate({ name: 'Ada Referrer', email: 'ada@example.com' }, db);
  otherAffiliateId = upsertAffiliate({ name: 'Grace Waiting', email: 'grace@example.com' }, db);

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
  membershipId = upsertMembership(
    {
      affiliateId: otherAffiliateId,
      programId,
      handle: 'bbbb2222',
      status: 'pending',
      joinedAt: '2024-01-02T00:00:00Z',
    },
    db,
  );

  upsertAttribution(
    {
      affiliateId,
      programId,
      shopId: '10',
      myshopifyDomain: 's10.example',
      appId: APP_ID,
      referredAt: '2024-01-01T00:00:00Z',
      source: 'ga4',
      handle: 'aaaa1111',
    },
    db,
  );

  recomputeCommissions(db);
  const paid = db
    .prepare('SELECT id FROM affiliate_commissions ORDER BY earned_at LIMIT 1')
    .get() as { id: string };
  markCommissionPaid(paid.id, { paidAt: '2024-04-01T00:00:00Z', reference: 'batch-1' }, db);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the affiliate admin API', () => {
  it('lists affiliates with balances, and finds one by handle', async () => {
    const [status, body] = await json('/api/affiliates');
    assert.equal(status, 200);
    assert.equal(body.total, 2);

    const ada = body.affiliates.find((row: any) => row.id === affiliateId);
    assert.equal(ada.earned, 40, 'two $100 charges at 20%');
    assert.equal(ada.paid, 20);
    assert.equal(ada.outstanding, 20);
    assert.deepEqual(ada.handles, ['aaaa1111']);
    assert.equal(ada.referrals, 1);

    // Sorted by outstanding by default, so the person we owe is first.
    assert.equal(body.affiliates[0].id, affiliateId);

    const [, byHandle] = await json('/api/affiliates?q=bbbb2222');
    assert.equal(byHandle.total, 1);
    assert.equal(byHandle.affiliates[0].id, otherAffiliateId);
  });

  it('returns one affiliate with their memberships, referrals and commissions', async () => {
    const [status, body] = await json(`/api/affiliates/${affiliateId}`);
    assert.equal(status, 200);
    assert.equal(body.memberships.length, 1);
    assert.equal(body.memberships[0].status, 'enrolled');
    assert.equal(body.referrals.length, 1);
    assert.equal(body.referrals[0].myshopifyDomain, 's10.example');
    assert.equal(body.referrals[0].earned, 40);
    assert.equal(body.commissions.length, 2);
    assert.equal(
      body.commissions.filter((row: any) => row.paidAt).length,
      1,
      'the payment record is visible on the detail view',
    );

    const [missing] = await json('/api/affiliates/not-a-real-id');
    assert.equal(missing, 404);
  });

  it('reconciles earned, paid and outstanding', async () => {
    const [status, body] = await json('/api/affiliates/reconciliation');
    assert.equal(status, 200, '/reconciliation must not be read as an affiliate id');
    assert.equal(body.totals.earned, 40);
    assert.equal(body.totals.paid, 20);
    assert.equal(body.totals.outstanding, 20);
    assert.equal(body.totals.owed, 1);
    assert.deepEqual(body.totals.currencies, ['USD']);
    // Affiliates with no commissions at all are not a reconciliation line.
    assert.equal(body.affiliates.length, 1);
  });

  it('works the approval queue in both directions', async () => {
    const [, queue] = await json('/api/affiliates/memberships/pending');
    assert.equal(queue.memberships.length, 1);
    assert.equal(queue.memberships[0].id, membershipId);
    assert.equal(queue.memberships[0].affiliateEmail, 'grace@example.com');

    const [status, approved] = await json(
      `/api/affiliates/memberships/${membershipId}/approve`,
      { method: 'POST' },
    );
    assert.equal(status, 200);
    assert.equal(approved.status, 'enrolled');
    assert.ok(approved.approvedAt);

    // Approving rewinds the app's attribution watermark, so the next sync looks
    // for the clicks this affiliate sent while they were waiting.
    const watermark = db
      .prepare('SELECT 1 FROM sync_state WHERE key = ?')
      .get(`affiliates:ga4:${APP_ID}`);
    assert.equal(watermark, undefined);

    const [, rejected] = await json(`/api/affiliates/memberships/${membershipId}/reject`, {
      method: 'POST',
    });
    assert.equal(rejected.status, 'rejected');
    assert.ok(rejected.rejectedAt);
    assert.ok(rejected.approvedAt, 'the earlier approval stays on the record');

    const [bad] = await json(`/api/affiliates/memberships/${membershipId}/maybe`, {
      method: 'POST',
    });
    assert.equal(bad, 400);

    const [missing] = await json('/api/affiliates/memberships/nope/approve', { method: 'POST' });
    assert.equal(missing, 404);
  });

  it('assigns a merchant by hand and pays on it immediately', async () => {
    const [status, body] = await json(`/api/affiliates/${affiliateId}/attributions`, {
      method: 'POST',
      body: JSON.stringify({
        programId,
        myshopifyDomain: 's11.example',
        referredAt: '2024-01-01T00:00:00Z',
      }),
    });

    assert.equal(status, 200);
    assert.equal(body.attribution.shopId, '11', 'the domain resolved to a synced merchant');
    assert.equal(body.attribution.replaced, null);

    const row = db
      .prepare('SELECT source, handle FROM affiliate_attributions WHERE id = ?')
      .get(body.attribution.id) as { source: string; handle: string };
    assert.equal(row.source, 'manual', 'so the GA4 pipeline leaves the decision alone');
    assert.equal(row.handle, 'aaaa1111');

    const [, detail] = await json(`/api/affiliates/${affiliateId}`);
    assert.equal(detail.affiliate.earned, 50, '$50 charge adds a $10 commission');
  });

  it('refuses to assign into a program the affiliate is not in', async () => {
    const outsider = upsertAffiliate({ name: 'Outside', email: 'out@example.com' }, db);
    const [status, body] = await json(`/api/affiliates/${outsider}/attributions`, {
      method: 'POST',
      body: JSON.stringify({ programId, myshopifyDomain: 's10.example' }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /no membership/i);
  });

  it('unassigns without destroying what was already earned', async () => {
    const referral = db
      .prepare(
        `SELECT id FROM affiliate_attributions
          WHERE myshopify_domain = 's10.example' AND deleted_at IS NULL`,
      )
      .get() as { id: string };

    const [status, body] = await json(`/api/affiliates/attributions/${referral.id}`, {
      method: 'DELETE',
    });
    assert.equal(status, 200);
    assert.ok(body.attribution.unassignedAt);

    const commissions = db
      .prepare(
        `SELECT paid_at AS paidAt, cancelled_at AS cancelledAt
           FROM affiliate_commissions WHERE attribution_id = ?`,
      )
      .all(referral.id) as Array<{ paidAt: string | null; cancelledAt: string | null }>;

    assert.equal(commissions.length, 2, 'the rows survive the unassignment');
    assert.equal(
      commissions.filter((row) => row.paidAt).length,
      1,
      'and so does the record that one of them was paid',
    );
  });
});

describe('the affiliate admin API gate', () => {
  it('is closed to a request with no session when a password is set', async () => {
    // A second app on its own port, because the gate is decided at startup.
    resetEnvironment({ DASHBOARD_PASSWORD: 'correct-horse-battery' });
    const gated = createApp().listen(0);
    await new Promise((resolve) => gated.once('listening', resolve));
    const gatedOrigin = `http://127.0.0.1:${(gated.address() as AddressInfo).port}`;

    for (const path of [
      '/api/affiliates',
      '/api/affiliates/reconciliation',
      '/api/affiliates/memberships/pending',
    ]) {
      const response = await fetch(`${gatedOrigin}${path}`);
      assert.equal(response.status, 401, `${path} must require the admin session`);
    }

    // And the mutations, which can move money between two people.
    const assign = await fetch(`${gatedOrigin}/api/affiliates/anyone/attributions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ programId: 'any', myshopifyDomain: 'x.example' }),
    });
    assert.equal(assign.status, 401);

    gated.close();
  });
});

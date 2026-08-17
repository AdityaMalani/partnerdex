import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { importMantleExport } from '../src/affiliates/import.js';
import type { MantleAttributionRequest, MantleExport, MantleProgram } from '../src/affiliates/mantle.js';
import {
  claimStatus,
  upsertAffiliate,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { decideClaim, listClaims } from '../src/affiliates/claims.js';
import { issueResetToken } from '../src/server/portalAuth.js';
import { APP_ID, resetEnvironment } from './helpers.js';

/**
 * Attribution claims — an affiliate asking for a merchant, an operator deciding.
 *
 * The property these tests exist to hold is narrower than it looks and matters
 * more than the rest of the file: **a pending claim is inert**. A pending queue
 * carried out of Mantle is undecided on purpose, and the operator wants them
 * carried across so the decision can be made later. So the assertions are
 * written negatively wherever they can be — not "the claim imported" but "no
 * attribution exists, no commission exists, nothing was decided" — because an
 * import that quietly approved one would pass the positive form and move money.
 *
 * The rest is the shapes that are silent when wrong: a status derived from two
 * nullable timestamps with a precedence rule, a second import duplicating a
 * claim, a link to a referral that was reconstructed rather than copied, and a
 * portal route that scopes on the session.
 */

const STOQ_PROGRAM = 'prog-stoq';
const FILEMONK_PROGRAM = 'prog-filemonk';

function program(id: string, appName: string): MantleProgram {
  return {
    id,
    appId: `mantle-app-${id}`,
    rules: { percentCommission: 20, revenueComponents: ['subscription'] },
    requireApprovalToJoin: appName === 'STOQ',
    removeOnUninstallDays: 30,
    app: { id: `mantle-app-${id}`, name: appName, displayName: appName },
  };
}

const STOQ = program(STOQ_PROGRAM, 'STOQ');
const FILEMONK = program(FILEMONK_PROGRAM, 'Filemonk');

/**
 * One claim, in the shape the export actually has.
 *
 * Note what is *not* here: a status field. Mantle stored two nullable
 * timestamps and let every reader work it out, which is the rule under test.
 */
function claim(
  id: string,
  overrides: Partial<MantleAttributionRequest> & { domain: string },
): MantleAttributionRequest {
  const { domain, ...rest } = overrides;
  return {
    id,
    affiliateId: 'aff-1',
    affiliateProgramId: STOQ_PROGRAM,
    appInstallationId: `install-${id}`,
    customerName: domain.split('.')[0]!,
    date: '2026-05-01T00:00:00.000Z',
    notes: 'I referred this merchant.',
    approvedAt: null,
    rejectedAt: null,
    decisionById: null,
    decisionNotes: null,
    createdAt: '2026-05-02T00:00:00.000Z',
    appInstallation: { myshopifyDomain: domain, platformId: '900001' },
    ...rest,
  };
}

function fixture(): MantleExport {
  return {
    affiliates: [
      {
        id: 'aff-1',
        name: 'Claimant Ltd',
        email: 'claimant@example.com',
        payoutHold: false,
        createdAt: '2025-01-01T00:00:00.000Z',
        memberships: [
          {
            id: 'mem-1',
            affiliateId: 'aff-1',
            affiliateProgramId: STOQ_PROGRAM,
            handle: 'claimant',
            status: 'enrolled',
            createdAt: '2025-01-01T00:00:00.000Z',
            approvedAt: '2025-01-02T00:00:00.000Z',
            affiliateProgram: STOQ,
          },
          {
            id: 'mem-2',
            affiliateId: 'aff-1',
            affiliateProgramId: FILEMONK_PROGRAM,
            handle: 'claimant',
            status: 'enrolled',
            createdAt: '2025-01-01T00:00:00.000Z',
            affiliateProgram: FILEMONK,
          },
        ],
      },
      {
        id: 'aff-2',
        name: 'Other Claimant',
        email: 'other@example.com',
        createdAt: '2025-02-01T00:00:00.000Z',
        memberships: [
          {
            id: 'mem-3',
            affiliateId: 'aff-2',
            affiliateProgramId: STOQ_PROGRAM,
            handle: 'other001',
            status: 'enrolled',
            createdAt: '2025-02-01T00:00:00.000Z',
            affiliateProgram: STOQ,
          },
        ],
      },
    ],
    // One referral in the ledger, matching the approved claim below. This is the
    // more-approvals-than-attributions shape in miniature.
    attributions: [
      {
        id: 'attr-approved',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        date: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-10T00:00:00.000Z',
        affiliateProgram: STOQ,
        appInstallation: { myshopifyDomain: 'linked.myshopify.com', platformId: '900001' },
      },
    ],
    commissions: [],
    payouts: [],
    attributionRequests: [
      // Undecided. The one that must stay that way.
      claim('claim-pending', { domain: 'pending.myshopify.com' }),
      // Undecided, and its merchant has not synced locally either.
      claim('claim-pending-unsynced', { domain: 'unsynced.myshopify.com' }),
      // Approved, and the ledger holds the referral it produced.
      claim('claim-approved', {
        domain: 'linked.myshopify.com',
        approvedAt: '2026-02-01T00:00:00.000Z',
        decisionById: 'user-1',
        decisionNotes: 'Checked the install date.',
        decisionBy: { id: 'user-1', name: 'Carol Admin', email: 'carol@example.com' },
      }),
      // Approved, and nothing in the ledger corresponds to it. A finding, not a
      // gap to fill: 8 of the real ones are in this state.
      claim('claim-approved-orphan', {
        domain: 'novia.myshopify.com',
        approvedAt: '2026-02-02T00:00:00.000Z',
        decisionBy: { id: 'user-1', name: 'Carol Admin', email: 'carol@example.com' },
      }),
      // Rejected. Both timestamps set, and rejection wins — a claim approved and
      // then reversed is rejected, and the other reading resurrects it.
      claim('claim-rejected', {
        domain: 'refused.myshopify.com',
        approvedAt: '2026-03-01T00:00:00.000Z',
        rejectedAt: '2026-03-02T00:00:00.000Z',
        decisionNotes: 'Merchant says otherwise.',
        decisionBy: { id: 'user-1', name: 'Carol Admin', email: 'carol@example.com' },
      }),
      // A second affiliate wanting the merchant the first one is waiting on.
      claim('claim-competing', {
        affiliateId: 'aff-2',
        domain: 'pending.myshopify.com',
      }),
    ],
  };
}

function seedApps(db: Db): void {
  const statement = db.prepare(
    'INSERT OR REPLACE INTO apps (id, name, discovered_at) VALUES (?, ?, ?)',
  );
  statement.run(APP_ID, 'STOQ', '2024-01-01T00:00:00.000Z');
  statement.run('222', 'Filemonk', '2024-01-01T00:00:00.000Z');
}

function seedShops(db: Db, domains: Array<[string, string]>): void {
  const statement = db.prepare(
    'INSERT OR REPLACE INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)',
  );
  for (const [id, domain] of domains) statement.run(id, domain, domain);
}

const count = (db: Db, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

describe('claim status is derived, not stored, in the source', () => {
  it('reads the two timestamps with rejection winning', () => {
    assert.equal(claimStatus({}), 'pending');
    assert.equal(claimStatus({ approvedAt: null, rejectedAt: null }), 'pending');
    assert.equal(claimStatus({ approvedAt: '2026-01-01T00:00:00.000Z' }), 'approved');
    assert.equal(claimStatus({ rejectedAt: '2026-01-01T00:00:00.000Z' }), 'rejected');
    // The case that decides the rule: both set. A claim that was approved and
    // then reversed is rejected.
    assert.equal(
      claimStatus({
        approvedAt: '2026-01-01T00:00:00.000Z',
        rejectedAt: '2026-02-01T00:00:00.000Z',
      }),
      'rejected',
    );
  });
});

describe('importing attribution claims', () => {
  let db: Db;

  beforeEach(() => {
    resetEnvironment();
    db = getDb();
    seedApps(db);
    seedShops(db, [
      ['900001', 'linked.myshopify.com'],
      ['900002', 'pending.myshopify.com'],
      ['900003', 'refused.myshopify.com'],
      ['900004', 'novia.myshopify.com'],
    ]);
  });

  afterEach(() => closeDb());

  it('carries every claim across with its status', () => {
    const report = importMantleExport(fixture(), { db });

    assert.equal(report.claims.total, 6);
    assert.equal(report.claims.imported, 6);
    assert.deepEqual(report.claims.orphaned, []);
    assert.deepEqual(report.claims.byStatus, { pending: 3, approved: 2, rejected: 1 });
    // `unsynced.myshopify.com` is deliberately absent from `shops`.
    assert.equal(report.claims.unresolvedMerchants, 1);
  });

  it('keeps the decision, the decision maker and the notes', () => {
    importMantleExport(fixture(), { db });

    const approved = db
      .prepare(
        `SELECT status, decided_at AS decidedAt, decided_by AS decidedBy,
                decided_by_external_id AS decidedByExternalId, decision_notes AS decisionNotes,
                approved_at AS approvedAt, rejected_at AS rejectedAt
           FROM affiliate_attribution_claims WHERE external_id = 'claim-approved'`,
      )
      .get() as Record<string, string | null>;

    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvedAt, '2026-02-01T00:00:00.000Z');
    assert.equal(approved.decidedAt, '2026-02-01T00:00:00.000Z');
    assert.equal(approved.decidedBy, 'Carol Admin');
    assert.equal(approved.decidedByExternalId, 'user-1');
    assert.equal(approved.decisionNotes, 'Checked the install date.');

    // The rejected one carries both timestamps, and `decided_at` is the
    // rejection — the decision that stands.
    const rejected = db
      .prepare(
        `SELECT status, decided_at AS decidedAt, approved_at AS approvedAt,
                rejected_at AS rejectedAt
           FROM affiliate_attribution_claims WHERE external_id = 'claim-rejected'`,
      )
      .get() as Record<string, string | null>;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.approvedAt, '2026-03-01T00:00:00.000Z');
    assert.equal(rejected.decidedAt, '2026-03-02T00:00:00.000Z');
  });

  it('leaves pending claims completely inert', () => {
    importMantleExport(fixture(), { db });

    const pending = db
      .prepare(
        `SELECT id, myshopify_domain AS domain, attribution_id AS attributionId,
                decided_at AS decidedAt, decided_by AS decidedBy
           FROM affiliate_attribution_claims WHERE status = 'pending'`,
      )
      .all() as Array<{
      id: string;
      domain: string;
      attributionId: string | null;
      decidedAt: string | null;
      decidedBy: string;
    }>;
    assert.equal(pending.length, 3);

    for (const row of pending) {
      // Nothing was decided.
      assert.equal(row.decidedAt, null, `${row.domain} must carry no decision`);
      assert.equal(row.decidedBy, '');
      // Nothing was linked — a pending claim whose merchant is already
      // attributed elsewhere is a fact, not a decision.
      assert.equal(row.attributionId, null, `${row.domain} must link to no referral`);
      // Nothing was created.
      assert.equal(
        count(
          db,
          'SELECT COUNT(*) AS n FROM affiliate_attributions WHERE myshopify_domain = ?',
          row.domain,
        ),
        0,
        `${row.domain} must have no attribution`,
      );
    }

    // And no commission anywhere: the only referral in this fixture earned
    // nothing, so a pending claim that leaked into the engine would show here.
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM affiliate_commissions'), 0);
    // The ledger holds exactly the one referral the export carried.
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM affiliate_attributions'), 1);
  });

  it('links an approved claim to the referral it corresponds to, and counts the rest', () => {
    const report = importMantleExport(fixture(), { db });

    assert.equal(report.claims.link.linked, 1);
    assert.equal(report.claims.link.newlyLinked, 1);
    // The approval with nothing to point at. Reported, never repaired.
    assert.equal(report.claims.link.approvedWithoutAttribution, 1);

    const linked = db
      .prepare(
        `SELECT c.attribution_id AS attributionId, a.external_id AS attributionExternalId
           FROM affiliate_attribution_claims c
           JOIN affiliate_attributions a ON a.id = c.attribution_id
          WHERE c.external_id = 'claim-approved'`,
      )
      .get() as { attributionId: string; attributionExternalId: string } | undefined;
    assert.ok(linked, 'the approved claim should point at the imported referral');
    assert.equal(linked.attributionExternalId, 'attr-approved');

    // Linking is not creating: the orphaned approval still has no referral.
    assert.equal(
      count(
        db,
        'SELECT COUNT(*) AS n FROM affiliate_attributions WHERE myshopify_domain = ?',
        'novia.myshopify.com',
      ),
      0,
    );
  });

  it('is idempotent — a second import changes nothing', () => {
    const first = importMantleExport(fixture(), { db });
    const before = db
      .prepare(
        `SELECT id, status, attribution_id AS attributionId, external_id AS externalId
           FROM affiliate_attribution_claims ORDER BY external_id`,
      )
      .all();

    const second = importMantleExport(fixture(), { db });
    const after = db
      .prepare(
        `SELECT id, status, attribution_id AS attributionId, external_id AS externalId
           FROM affiliate_attribution_claims ORDER BY external_id`,
      )
      .all();

    assert.equal(second.claims.imported, first.claims.imported);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 6);
    // Same rows, same ids, same links — including the link, which the second
    // run has no new information about.
    assert.deepEqual(after, before);
    assert.equal(second.claims.link.newlyLinked, 0);
    assert.equal(second.claims.link.linked, 1);
  });

  it('resolves a merchant that syncs after the import', () => {
    importMantleExport(fixture(), { db });
    const claimId = (
      db
        .prepare(`SELECT id FROM affiliate_attribution_claims WHERE external_id = ?`)
        .get('claim-pending-unsynced') as { id: string }
    ).id;

    const shopOf = (): string =>
      (db.prepare('SELECT shop_id AS shopId FROM affiliate_attribution_claims WHERE id = ?').get(
        claimId,
      ) as { shopId: string }).shopId;

    assert.equal(shopOf(), '');
    seedShops(db, [['900005', 'unsynced.myshopify.com']]);
    importMantleExport(fixture(), { db });
    assert.equal(shopOf(), '900005');
  });
});

describe('deciding a claim', () => {
  let db: Db;

  beforeEach(() => {
    resetEnvironment();
    db = getDb();
    seedApps(db);
    seedShops(db, [
      ['900001', 'linked.myshopify.com'],
      ['900002', 'pending.myshopify.com'],
      ['900003', 'refused.myshopify.com'],
      ['900004', 'novia.myshopify.com'],
    ]);
    importMantleExport(fixture(), { db });
  });

  afterEach(() => closeDb());

  const claimIdFor = (externalId: string): string =>
    (
      db
        .prepare('SELECT id FROM affiliate_attribution_claims WHERE external_id = ?')
        .get(externalId) as { id: string }
    ).id;

  it('approving writes a manual attribution dated when the affiliate claimed', () => {
    const id = claimIdFor('claim-pending');
    const result = decideClaim(id, 'approve', { decidedBy: 'operator' }, db, '2026-06-01T00:00:00.000Z');

    assert.equal(result.status, 'approved');
    assert.ok(result.attributionId);

    const attribution = db
      .prepare(
        `SELECT affiliate_id AS affiliateId, myshopify_domain AS domain, shop_id AS shopId,
                source, handle, referred_at AS referredAt
           FROM affiliate_attributions WHERE id = ?`,
      )
      .get(result.attributionId!) as Record<string, string>;

    // The same shape the manual-assignment endpoint produces, because it is the
    // same function: manual source, the membership's handle, the shop resolved.
    assert.equal(attribution.source, 'manual');
    assert.equal(attribution.handle, 'claimant');
    assert.equal(attribution.shopId, '900002');
    // Dated the claim, not the decision. A claim filed about March is about
    // March; dating it today would discard the commissions in between.
    assert.equal(attribution.referredAt, '2026-05-01T00:00:00.000Z');

    const stored = db
      .prepare(
        `SELECT status, decided_by AS decidedBy, attribution_id AS attributionId
           FROM affiliate_attribution_claims WHERE id = ?`,
      )
      .get(id) as Record<string, string>;
    assert.equal(stored.status, 'approved');
    assert.equal(stored.decidedBy, 'operator');
    assert.equal(stored.attributionId, result.attributionId);
  });

  it('rejecting records the decision and creates nothing', () => {
    const id = claimIdFor('claim-competing');
    const attributionsBefore = count(db, 'SELECT COUNT(*) AS n FROM affiliate_attributions');

    const result = decideClaim(id, 'reject', { notes: 'Merchant found us directly.' }, db);

    assert.equal(result.status, 'rejected');
    assert.equal(result.attributionId, null);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM affiliate_attributions'), attributionsBefore);

    const stored = db
      .prepare(
        `SELECT status, rejected_at AS rejectedAt, decision_notes AS decisionNotes,
                attribution_id AS attributionId
           FROM affiliate_attribution_claims WHERE id = ?`,
      )
      .get(id) as Record<string, string | null>;
    assert.equal(stored.status, 'rejected');
    assert.ok(stored.rejectedAt);
    assert.equal(stored.decisionNotes, 'Merchant found us directly.');
    assert.equal(stored.attributionId, null);
  });

  it('refuses to decide a claim twice', () => {
    const id = claimIdFor('claim-approved');
    assert.throws(() => decideClaim(id, 'reject', {}, db), /already approved/);
  });

  it('lists by status, affiliate and program', () => {
    assert.equal(listClaims({ status: 'pending' }, db).total, 3);
    assert.equal(listClaims({ status: 'approved' }, db).total, 2);
    assert.equal(listClaims({ status: 'rejected' }, db).total, 1);
    assert.equal(listClaims({}, db).total, 6);

    const affiliateId = (
      db.prepare(`SELECT id FROM affiliates WHERE external_id = 'aff-2'`).get() as { id: string }
    ).id;
    const mine = listClaims({ affiliateId }, db);
    assert.equal(mine.total, 1);
    assert.equal(mine.claims[0]!.affiliateId, affiliateId);

    const programId = (
      db.prepare(`SELECT id FROM affiliate_programs WHERE external_id = ?`).get(FILEMONK_PROGRAM) as
        | { id: string }
        | undefined
    )?.id;
    assert.ok(programId);
    assert.equal(listClaims({ programId }, db).total, 0);
  });
});

/* ------------------------------------------------------------------ portal */

const A_PASSWORD = 'alice-portal-password';

let server: Server;
let origin: string;
let portalDb: Db;
const ids = { alice: '', bob: '', stoq: '' };

const get = (path: string, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  return header.split(';')[0]!;
}

describe('the portal claims view', () => {
  before(async () => {
    resetEnvironment();
    portalDb = getDb();
    seedApps(portalDb);
    seedShops(portalDb, [['900002', 'pending.myshopify.com']]);

    ids.stoq = upsertProgram({ appId: APP_ID, name: 'STOQ', commissionRate: 0.2 }, portalDb);
    ids.alice = upsertAffiliate({ name: 'Alice', email: 'alice@example.com' }, portalDb);
    ids.bob = upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, portalDb);
    for (const [affiliateId, handle] of [
      [ids.alice, 'aliceaaa'],
      [ids.bob, 'bobbbbbb'],
    ] as const) {
      upsertMembership(
        {
          affiliateId,
          programId: ids.stoq,
          handle,
          status: 'enrolled',
          joinedAt: '2025-01-01T00:00:00.000Z',
        },
        portalDb,
      );
    }

    // Two claims that look alike, one each. Anything that leaks between them
    // therefore leaks something that reads as plausible on the other's page.
    const insert = portalDb.prepare(
      `INSERT INTO affiliate_attribution_claims
         (id, affiliate_id, program_id, shop_id, myshopify_domain, customer_name, claimed_at,
          notes, status, decision_notes, created_at, updated_at)
       VALUES (@id, @affiliateId, @programId, '', @domain, @customerName, @claimedAt,
               @notes, @status, @decisionNotes, @claimedAt, @claimedAt)`,
    );
    insert.run({
      id: 'claim-alice',
      affiliateId: ids.alice,
      programId: ids.stoq,
      domain: 'alice-store.myshopify.com',
      customerName: 'Alice Store',
      claimedAt: '2026-05-01T00:00:00.000Z',
      notes: 'Mine, I set it up for them.',
      status: 'pending',
      decisionNotes: null,
    });
    insert.run({
      id: 'claim-bob',
      affiliateId: ids.bob,
      programId: ids.stoq,
      domain: 'bob-store.myshopify.com',
      customerName: 'Bob Store',
      claimedAt: '2026-05-02T00:00:00.000Z',
      notes: 'Bob referred this one.',
      status: 'rejected',
      decisionNotes: 'Internal: Bob has been warned about this.',
    });

    const { token } = issueResetToken(portalDb, ids.alice);
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal(
      (await post('/portal/api/auth/set-password', { token, password: A_PASSWORD })).status,
      200,
    );
  });

  after(() => {
    server.close();
    closeDb();
  });

  const login = async (): Promise<string> =>
    cookieFrom(await post('/portal/api/auth/login', { email: 'alice@example.com', password: A_PASSWORD }));

  it('requires a session', async () => {
    assert.equal((await get('/portal/api/claims')).status, 401);
  });

  it('shows the affiliate their own claim, pending status included', async () => {
    const response = await get('/portal/api/claims', await login());
    assert.equal(response.status, 200);
    const body = (await response.json()) as { claims: Array<Record<string, unknown>>; total: number };

    assert.equal(body.total, 1);
    assert.equal(body.claims[0]!.id, 'claim-alice');
    assert.equal(body.claims[0]!.status, 'pending');
    assert.equal(body.claims[0]!.attributed, false);
  });

  it('leaks nothing of the other affiliate into the response', async () => {
    const raw = await (await get('/portal/api/claims', await login())).text();

    // Negative form on purpose: a filter that silently stops filtering passes
    // "Alice sees one claim" on a fixture and fails this.
    for (const forbidden of [
      ids.bob,
      'claim-bob',
      'Bob Store',
      'bob-store',
      'Bob referred this one.',
      'Bob has been warned',
    ]) {
      assert.ok(!raw.includes(forbidden), `portal response must not contain "${forbidden}"`);
    }
    // And nothing about the merchant beyond the name the affiliate typed: no
    // domain, no shop id.
    assert.ok(!raw.includes('myshopify.com'));
  });

  it('cannot be pointed at another affiliate from the request', async () => {
    const cookie = await login();
    for (const query of [
      `?affiliateId=${ids.bob}`,
      `?affiliate_id=${ids.bob}`,
      `?id=claim-bob`,
      `?status=rejected`,
    ]) {
      const raw = await (await get(`/portal/api/claims${query}`, cookie)).text();
      assert.ok(!raw.includes('claim-bob'), `${query} must not widen the scope`);
      assert.ok(raw.includes('claim-alice'), `${query} must still return the caller's own claims`);
    }
  });

  /*
   * This used to assert that the portal accepted no POST at all, because at the
   * time it accepted neither filing nor deciding. Filing now exists — see
   * `affiliateClaimSubmit.test.ts` for its own properties — and the half of the
   * assertion that was always the load-bearing half is unchanged and stated
   * more sharply: **deciding is not reachable from the portal.** An affiliate
   * may ask; only the dashboard may answer, and no path or verb under
   * `/portal/api` moves a claim's status.
   */
  it('offers no way to decide a claim from the portal', async () => {
    const cookie = await login();
    for (const path of [
      '/portal/api/claims/claim-alice/approve',
      '/portal/api/claims/claim-alice/reject',
      '/portal/api/claims/claim-alice',
      // The other affiliate's claim, by both verbs, in case a decision route is
      // ever added without a scoping predicate.
      '/portal/api/claims/claim-bob/approve',
    ]) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie },
          ...(method === 'DELETE' ? {} : { body: '{}' }),
        });
        assert.ok(
          response.status === 404 || response.status === 405,
          `${method} ${path} must not be a route`,
        );
      }
    }
    // Both claims still hold the status they had, which is the property that
    // matters. Bob's stays rejected; Alice's stays pending.
    assert.equal(
      (
        portalDb
          .prepare(`SELECT status FROM affiliate_attribution_claims WHERE id = 'claim-bob'`)
          .get() as { status: string }
      ).status,
      'rejected',
    );
    assert.equal(
      (
        portalDb
          .prepare(`SELECT status FROM affiliate_attribution_claims WHERE id = 'claim-alice'`)
          .get() as { status: string }
      ).status,
      'pending',
    );
  });
});

/* ------------------------------------------------------------------- admin */

describe('the admin claim routes', () => {
  const ADMIN_PASSWORD = 'correct-horse-battery';
  let adminServer: Server;
  let adminOrigin: string;
  let adminDb: Db;
  let cookie: string;

  before(async () => {
    resetEnvironment({ DASHBOARD_PASSWORD: ADMIN_PASSWORD });
    adminDb = getDb();
    seedApps(adminDb);
    seedShops(adminDb, [
      ['900001', 'linked.myshopify.com'],
      ['900002', 'pending.myshopify.com'],
      ['900003', 'refused.myshopify.com'],
      ['900004', 'novia.myshopify.com'],
    ]);
    importMantleExport(fixture(), { db: adminDb });

    adminServer = createApp().listen(0);
    await new Promise((resolve) => adminServer.once('listening', resolve));
    adminOrigin = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;

    const response = await fetch(`${adminOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    cookie = cookieFrom(response);
  });

  after(() => {
    adminServer.close();
    closeDb();
  });

  const call = async (path: string, init: RequestInit = {}): Promise<[number, any]> => {
    const response = await fetch(`${adminOrigin}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) },
    });
    return [response.status, await response.json()];
  };

  it('sits behind the dashboard password', async () => {
    const response = await fetch(`${adminOrigin}/api/affiliates/claims`);
    assert.equal(response.status, 401);
  });

  it('is not swallowed by /:affiliateId', async () => {
    // `/claims` is a fixed path registered ahead of the affiliate route. Without
    // that ordering this is a 404 that reads as "no such affiliate".
    const [status, body] = await call('/api/affiliates/claims?status=pending');
    assert.equal(status, 200);
    assert.equal(body.total, 3);
    assert.equal(body.claims.length, 3);
  });

  it('returns one claim with its competing claims', async () => {
    const [, list] = await call('/api/affiliates/claims?status=pending&sort=claimedAt');
    const target = list.claims.find(
      (row: { myshopifyDomain: string }) => row.myshopifyDomain === 'pending.myshopify.com',
    );
    const [status, body] = await call(`/api/affiliates/claims/${target.id}`);
    assert.equal(status, 200);
    // Two affiliates want this merchant. Stated as a fact, with no ranking.
    assert.equal(body.competing.length, 1);
    assert.equal(body.attribution, null);
  });

  it('rejects an unknown decision verb by name', async () => {
    const [, list] = await call('/api/affiliates/claims?status=pending');
    const [status, body] = await call(
      `/api/affiliates/claims/${list.claims[0].id}/maybe`,
      { method: 'POST', body: '{}' },
    );
    assert.equal(status, 400);
    assert.match(body.error, /approve/);
  });
});

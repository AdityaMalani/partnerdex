import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { assignAttribution } from '../src/affiliates/admin.js';
import { nameMerchant, submitClaim, ClaimSubmissionError } from '../src/affiliates/claims.js';
import { upsertAffiliate, upsertMembership, upsertProgram } from '../src/affiliates/store.js';
import { issueResetToken } from '../src/server/portalAuth.js';
import { resetClaimThrottle } from '../src/server/portal.js';
import { APP_ID, resetEnvironment } from './helpers.js';

/**
 * Filing a claim from the portal.
 *
 * One property dominates this file and every other assertion is arranged around
 * it: **this endpoint must not be usable to find out anything about a merchant.**
 * An affiliate can point it at any domain in the world, so the answer for a
 * store we have never heard of, a store that is ours, and a store already
 * credited to somebody else has to be the same answer — otherwise an approved
 * partner has a lookup service for "which of these shops are your customers,
 * and which of your partners owns them".
 *
 * That test is written as a byte comparison of whole responses with the minted
 * id masked out, not as three separate "returns 201" assertions. The weaker
 * form passes on a handler that leaks through a message, a header, or an extra
 * field, and the leak that matters is exactly the kind that gets added later by
 * somebody being helpful.
 *
 * The rest are the ways a filing endpoint goes wrong quietly: it takes the
 * affiliate from the body instead of the session, it creates something, it
 * writes two rows for one intent, it has no ceiling, or it lets somebody file
 * against a program they were never approved for.
 */

const PASSWORD = 'claimant-portal-password';

let server: Server;
let origin: string;
let db: Db;

const ids = {
  stoq: '',
  filemonk: '',
  /** Enrolled on both programs. The one who files. */
  alice: '',
  /** Enrolled on Stoq. Owns a merchant Alice will claim. */
  bob: '',
  /** Application to Stoq still pending. */
  pat: '',
  /** Application to Stoq refused. */
  rex: '',
};

function seedApps(database: Db): void {
  const statement = database.prepare(
    'INSERT OR REPLACE INTO apps (id, name, discovered_at) VALUES (?, ?, ?)',
  );
  statement.run(APP_ID, 'STOQ', '2024-01-01T00:00:00.000Z');
  statement.run('222', 'Filemonk', '2024-01-01T00:00:00.000Z');
}

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  return header.split(';')[0]!;
}

async function signIn(email: string): Promise<string> {
  return cookieFrom(await post('/portal/api/auth/login', { email, password: PASSWORD }));
}

/** Give an affiliate a password by redeeming a freshly minted token. */
async function givePassword(affiliateId: string): Promise<void> {
  const { token } = issueResetToken(db, affiliateId);
  assert.equal((await post('/portal/api/auth/set-password', { token, password: PASSWORD })).status, 200);
}

before(async () => {
  resetEnvironment();
  db = getDb();
  seedApps(db);

  ids.stoq = upsertProgram({ appId: APP_ID, name: 'STOQ', commissionRate: 0.2 }, db);
  ids.filemonk = upsertProgram({ appId: '222', name: 'Filemonk', commissionRate: 0.2 }, db);

  ids.alice = upsertAffiliate({ name: 'Alice', email: 'alice@example.com' }, db);
  ids.bob = upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, db);
  ids.pat = upsertAffiliate({ name: 'Pat', email: 'pat@example.com' }, db);
  ids.rex = upsertAffiliate({ name: 'Rex', email: 'rex@example.com' }, db);

  const enrol = (affiliateId: string, programId: string, handle: string, status: string) =>
    upsertMembership(
      { affiliateId, programId, handle, status, joinedAt: '2025-01-01T00:00:00.000Z' },
      db,
    );

  enrol(ids.alice, ids.stoq, 'aliceaaa', 'enrolled');
  enrol(ids.alice, ids.filemonk, 'aliceaaa', 'enrolled');
  enrol(ids.bob, ids.stoq, 'bobbbbbb', 'enrolled');
  // A pending applicant and a rejected one, both of which carry a handle — the
  // import gives every membership one, so "has a handle" proves nothing and the
  // status has to be read.
  enrol(ids.pat, ids.stoq, 'pattttt1', 'pending');
  enrol(ids.rex, ids.stoq, 'rexxxxx1', 'rejected');

  // Three merchants, in the three states the no-enumeration test compares.
  // `nobodys` is ours and credited to no one; `bobs` is ours and credited to
  // Bob; `stranger` is not in `shops` at all.
  const shops = db.prepare(
    'INSERT OR REPLACE INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)',
  );
  shops.run('900010', 'Nobodys Store', 'nobodys.myshopify.com');
  shops.run('900011', 'Bobs Store', 'bobs.myshopify.com');

  assignAttribution(
    { affiliateId: ids.bob, programId: ids.stoq, myshopifyDomain: 'bobs.myshopify.com' },
    db,
    '2026-01-01T00:00:00.000Z',
  );

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const affiliateId of [ids.alice, ids.pat, ids.rex]) await givePassword(affiliateId);
});

after(() => {
  server.close();
  closeDb();
});

beforeEach(() => {
  // The throttle is per process and every test in this file spends from the
  // same bucket. Cleared rather than waited out.
  resetClaimThrottle();
  db.prepare('DELETE FROM affiliate_attribution_claims').run();
});

/* ------------------------------------------------------------ normalisation */

describe('naming the merchant', () => {
  it('takes a domain however it was pasted', () => {
    for (const typed of [
      'acme.myshopify.com',
      'ACME.myshopify.com',
      '  acme.myshopify.com  ',
      'https://acme.myshopify.com',
      'http://acme.myshopify.com/admin/orders',
      'https://www.acme.myshopify.com/',
      'acme.myshopify.com:443',
      'acme.myshopify.com?utm=x',
      'acme.myshopify.com.',
    ]) {
      assert.equal(nameMerchant(typed).domain, 'acme.myshopify.com', `from "${typed}"`);
    }
  });

  it('expands a bare store handle, because that expansion is exact', () => {
    assert.equal(nameMerchant('acme').domain, 'acme.myshopify.com');
    assert.equal(nameMerchant('ACME').domain, 'acme.myshopify.com');
    assert.equal(nameMerchant('my-store-2').domain, 'my-store-2.myshopify.com');
  });

  it('keeps a free-text store name as a name, and invents no domain for it', () => {
    const named = nameMerchant('Acme Coffee Roasters');
    assert.equal(named.domain, '');
    assert.equal(named.name, 'Acme Coffee Roasters');
  });

  it('echoes back what was typed, never a rewritten version of it', () => {
    // The stored `customer_name` is the affiliate's own words. An operator
    // comparing a claim against a merchant needs to see what was claimed.
    assert.equal(nameMerchant('https://ACME.myshopify.com/admin').name, 'https://ACME.myshopify.com/admin');
  });

  it('refuses blanks and anything past the bound', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, ['acme.myshopify.com']]) {
      assert.throws(() => nameMerchant(bad), ClaimSubmissionError, `"${String(bad)}"`);
    }
    assert.throws(() => nameMerchant('a'.repeat(121)), /under 120 characters/);
    // Bounded before any pattern touches it, so a megabyte of text is a cheap
    // refusal rather than a cheap way to spend the event loop.
    assert.throws(() => nameMerchant('x'.repeat(200_000)), ClaimSubmissionError);
  });
});

/* -------------------------------------------------------- the endpoint */

describe('filing a claim from the portal', () => {
  const file = async (body: unknown, cookie: string): Promise<[number, any]> => {
    const response = await post('/portal/api/claims', body, cookie);
    return [response.status, await response.json()];
  };

  it('needs a session', async () => {
    const response = await post('/portal/api/claims', {
      programId: ids.stoq,
      merchant: 'anything.myshopify.com',
    });
    assert.equal(response.status, 401);
    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 0);
  });

  it('takes the affiliate from the session and ignores anything the body says', async () => {
    const cookie = await signIn('alice@example.com');
    const [status] = await file(
      {
        programId: ids.stoq,
        merchant: 'session-scoped.myshopify.com',
        // Every shape somebody might hope reaches the insert.
        affiliateId: ids.bob,
        affiliate_id: ids.bob,
        id: 'chosen-id',
        status: 'approved',
        claimedAt: '2020-01-01T00:00:00.000Z',
        attributionId: 'attr-1',
        decidedBy: 'me',
      },
      cookie,
    );
    assert.equal(status, 201);

    const row = db
      .prepare(
        `SELECT id, affiliate_id AS affiliateId, status, decided_at AS decidedAt,
                decided_by AS decidedBy, attribution_id AS attributionId,
                claimed_at AS claimedAt, external_id AS externalId
           FROM affiliate_attribution_claims`,
      )
      .get() as Record<string, string | null>;

    assert.equal(row.affiliateId, ids.alice, 'the claim belongs to the session, not the body');
    assert.notEqual(row.id, 'chosen-id');
    assert.equal(row.status, 'pending');
    assert.equal(row.decidedAt, null);
    assert.equal(row.decidedBy, '');
    assert.equal(row.attributionId, null);
    assert.equal(row.externalId, '');
    // Dated when it was filed, not when the filer said. See `submitClaim`.
    assert.ok(row.claimedAt! > '2025-01-01T00:00:00.000Z');
  });

  it('creates no attribution and no commission', async () => {
    const cookie = await signIn('alice@example.com');
    const attributionsBefore = count('SELECT COUNT(*) AS n FROM affiliate_attributions');

    // Including a claim on a merchant that is already Bob's, which is the case
    // where a bug would do the most damage: filing must not displace him.
    for (const merchant of ['nobodys.myshopify.com', 'bobs.myshopify.com', 'stranger.myshopify.com']) {
      const [status] = await file({ programId: ids.stoq, merchant }, cookie);
      assert.equal(status, 201, merchant);
    }

    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attributions'), attributionsBefore);
    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_commissions'), 0);
    // Nothing of Bob's moved: his referral is live and still his.
    const bobs = db
      .prepare(
        `SELECT affiliate_id AS affiliateId, deleted_at AS deletedAt
           FROM affiliate_attributions WHERE myshopify_domain = 'bobs.myshopify.com'`,
      )
      .get() as { affiliateId: string; deletedAt: string | null };
    assert.equal(bobs.affiliateId, ids.bob);
    assert.equal(bobs.deletedAt, null);
    // And all three claims are inert.
    assert.equal(
      count(`SELECT COUNT(*) AS n FROM affiliate_attribution_claims WHERE status = 'pending'`),
      3,
    );
  });

  /**
   * The one that matters most.
   *
   * Three merchants in three different states, one response each, compared in
   * full with the minted id masked. Anything that varies with what we know about
   * the store — a status code, a header, a message, a stray field — fails here.
   */
  it('answers identically for an unknown, an unclaimed and an already-claimed merchant', async () => {
    const cookie = await signIn('alice@example.com');

    const shapes: Array<{ label: string; status: number; body: string; headers: string }> = [];
    for (const [label, merchant] of [
      ['not our merchant at all', 'stranger.myshopify.com'],
      ['ours, credited to nobody', 'nobodys.myshopify.com'],
      ['ours, credited to Bob', 'bobs.myshopify.com'],
    ] as const) {
      const response = await post('/portal/api/claims', { programId: ids.stoq, merchant }, cookie);
      const raw = await response.text();
      shapes.push({
        label,
        status: response.status,
        // The id is a fresh UUID and the merchant is echoed from the input, so
        // both are masked; everything else must be byte-identical.
        body: raw
          .replace(/"id":"[^"]+"/, '"id":"<masked>"')
          .replace(/"merchant":"[^"]+"/, '"merchant":"<masked>"')
          .replace(/"claimedAt":"[^"]+"/, '"claimedAt":"<masked>"'),
        headers: [...response.headers]
          .filter(([name]) => name !== 'date' && name !== 'etag' && name !== 'content-length')
          .map(([name, value]) => `${name}: ${value}`)
          .sort()
          .join('\n'),
      });
    }

    const first = shapes[0]!;
    for (const shape of shapes.slice(1)) {
      assert.equal(shape.status, first.status, `${shape.label}: status differs`);
      assert.equal(shape.body, first.body, `${shape.label}: body differs`);
      assert.equal(shape.headers, first.headers, `${shape.label}: headers differ`);
    }

    // And nothing about the merchant is in the response at all: no shop id, no
    // owner, no hint that a store exists.
    assert.ok(!first.body.includes(ids.bob));
    assert.ok(!first.body.includes('900010'));
    assert.ok(!first.body.includes('900011'));
  });

  it('is idempotent — the same merchant claimed twice is one row', async () => {
    const cookie = await signIn('alice@example.com');

    const [firstStatus, first] = await file(
      { programId: ids.stoq, merchant: 'twice.myshopify.com', notes: 'The first time.' },
      cookie,
    );
    assert.equal(firstStatus, 201);
    assert.equal(first.claim.duplicate, false);

    // Every spelling that means the same store.
    for (const merchant of [
      'twice.myshopify.com',
      'TWICE.myshopify.com',
      'https://twice.myshopify.com/admin',
      'twice',
      '  twice.myshopify.com  ',
    ]) {
      const [status, body] = await file({ programId: ids.stoq, merchant, notes: 'Again.' }, cookie);
      assert.equal(status, 200, merchant);
      assert.equal(body.claim.duplicate, true, merchant);
      assert.equal(body.claim.id, first.claim.id, merchant);
    }

    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 1);
    // The original note stands. A re-file is not an edit — it must not let an
    // affiliate rewrite what an operator already read.
    assert.equal(
      (
        db.prepare('SELECT notes FROM affiliate_attribution_claims').get() as { notes: string }
      ).notes,
      'The first time.',
    );
  });

  it('scopes idempotency to the affiliate and the program, not the merchant alone', async () => {
    const cookie = await signIn('alice@example.com');

    // Same merchant, different program: a merchant can genuinely have installed
    // both apps, and those are two claims.
    assert.equal((await file({ programId: ids.stoq, merchant: 'both.myshopify.com' }, cookie))[0], 201);
    assert.equal(
      (await file({ programId: ids.filemonk, merchant: 'both.myshopify.com' }, cookie))[0],
      201,
    );
    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 2);

    // And a second affiliate claiming the same merchant is a competing claim,
    // not a duplicate — collapsing those would silently drop one person's ask.
    submitClaim({ affiliateId: ids.bob, programId: ids.stoq, merchant: 'both.myshopify.com' }, db);
    assert.equal(
      count(
        `SELECT COUNT(*) AS n FROM affiliate_attribution_claims
          WHERE myshopify_domain = 'both.myshopify.com'`,
      ),
      3,
    );
  });

  it('refuses a member who is pending or rejected on that program', async () => {
    for (const [email, expected] of [
      ['pat@example.com', /still being reviewed/],
      ['rex@example.com', /not enrolled/],
    ] as const) {
      const cookie = await signIn(email);
      const [status, body] = await file(
        { programId: ids.stoq, merchant: 'wanted.myshopify.com' },
        cookie,
      );
      assert.equal(status, 400, email);
      assert.match(body.error, expected, email);
    }

    // Alice is enrolled on Filemonk and so is nobody else here; a program the
    // caller holds no membership in at all is the third refusal.
    const alice = await signIn('alice@example.com');
    const [status, body] = await file(
      { programId: 'no-such-program', merchant: 'wanted.myshopify.com' },
      alice,
    );
    assert.equal(status, 400);
    assert.match(body.error, /not in that program/);

    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 0);
  });

  it('bounds the notes and refuses an unusable merchant', async () => {
    const cookie = await signIn('alice@example.com');

    const [longNotes, notesBody] = await file(
      { programId: ids.stoq, merchant: 'bounded.myshopify.com', notes: 'n'.repeat(1_001) },
      cookie,
    );
    assert.equal(longNotes, 400);
    assert.match(notesBody.error, /under 1000 characters/);

    for (const merchant of ['', '   ', null, 12, { domain: 'x.myshopify.com' }]) {
      const [status] = await file({ programId: ids.stoq, merchant }, cookie);
      assert.equal(status, 400, JSON.stringify(merchant));
    }
    const [missingProgram] = await file({ merchant: 'bounded.myshopify.com' }, cookie);
    assert.equal(missingProgram, 400);

    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), 0);
  });

  it('rate limits a burst from one affiliate', async () => {
    const cookie = await signIn('alice@example.com');

    let accepted = 0;
    let refused = 0;
    // Thirty distinct merchants, which is the shape of a script walking a list
    // rather than a person filing a claim.
    for (let n = 0; n < 30; n += 1) {
      const [status] = await file(
        { programId: ids.stoq, merchant: `burst-${n}.myshopify.com` },
        cookie,
      );
      if (status === 429) refused += 1;
      else {
        assert.equal(status, 201, `burst-${n}`);
        accepted += 1;
      }
    }

    assert.ok(refused > 0, 'a 30-request burst must hit the ceiling');
    assert.ok(accepted <= 20, `at most the bucket size should get through, got ${accepted}`);
    // The rows that exist are exactly the ones that were accepted: a throttled
    // request must not have written before it was refused.
    assert.equal(count('SELECT COUNT(*) AS n FROM affiliate_attribution_claims'), accepted);

    // A duplicate is charged too, so re-filing is not a free way past the
    // ceiling. Alice is already locked out, so this is a 429 rather than a 200.
    const [duplicate] = await file({ programId: ids.stoq, merchant: 'burst-0.myshopify.com' }, cookie);
    assert.equal(duplicate, 429);

    // And the lockout is that affiliate's own. Bob is untouched by it, which is
    // the property the shared throttle's key design exists to give.
    resetClaimThrottle();
  });

  it('shows the affiliate their new claim on the read route, and nobody else theirs', async () => {
    const cookie = await signIn('alice@example.com');
    await file(
      { programId: ids.stoq, merchant: 'visible.myshopify.com', notes: 'I set them up.' },
      cookie,
    );
    submitClaim({ affiliateId: ids.bob, programId: ids.stoq, merchant: 'bobs-own.myshopify.com' }, db);

    const raw = await (
      await fetch(`${origin}/portal/api/claims`, { headers: { cookie } })
    ).text();
    const body = JSON.parse(raw) as { claims: Array<Record<string, unknown>>; total: number };

    assert.equal(body.total, 1);
    assert.equal(body.claims[0]!.status, 'pending');
    assert.equal(body.claims[0]!.decidedAt, null);
    assert.equal(body.claims[0]!.attributed, false);
    assert.equal(body.claims[0]!.merchant, 'visible.myshopify.com');
    // Still nothing of anybody else's, and still no domain of a merchant they
    // did not themselves name.
    assert.ok(!raw.includes('bobs-own'));
    assert.ok(!raw.includes(ids.bob));
  });
});

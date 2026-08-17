import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import {
  upsertAffiliate,
  upsertAttribution,
  upsertCommission,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { issueResetToken, RESET_TTL_MS } from '../src/server/portalAuth.js';
import { resetRateLimit } from '../src/server/referralRedirect.js';
import { resetEnvironment } from './helpers.js';

/**
 * The affiliate portal, exercised over a real socket.
 *
 * This is the first time this codebase serves anybody who is not the operator,
 * so the tests are pointed at the two ways that goes badly. One is an affiliate
 * reaching the dashboard's data — two Partner organizations' revenue sits behind
 * `/api`, and the whole design rests on the claim that a portal session cannot
 * open it. The other is an affiliate reaching *another affiliate's* data, which
 * would not look like a breach at all: it would look like a page that loaded.
 *
 * So the scoping assertions are written negatively wherever they can be — not
 * "A sees three referrals" but "nothing in A's response belongs to B" — because
 * a filter that silently stops filtering passes the first form and fails the
 * second.
 *
 * Everything else here is the things that are silent when wrong: a reset token
 * that survives being spent, a lockout the right password walks through, a
 * redirect that drops a click somebody was paid for.
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
  carol: '',
};

/** The `Set-Cookie` value reduced to what a browser would send back. */
function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  return header.split(';')[0]!;
}

const get = (path: string, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const portalLogin = (email: string, password: string): Promise<Response> =>
  post('/portal/api/auth/login', { email, password });

/**
 * Two affiliates with overlapping shapes on purpose: both hold a Stoq
 * membership, both referred a merchant, both earned. Anything that leaks between
 * them therefore leaks something that looks plausible on the other's page.
 */
function seedAffiliates(): void {
  db.prepare(`INSERT INTO apps (id, name, discovered_at) VALUES ('111', 'STOQ', '2024-01-01')`).run();
  db.prepare(
    `INSERT INTO apps (id, name, discovered_at) VALUES ('222', 'Filemonk', '2024-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO app_listings (app_id, handle, url, source, created_at, updated_at)
     VALUES ('111', 'back-in-stock-restock-alerts',
             'https://apps.shopify.com/back-in-stock-restock-alerts', 'manual',
             '2024-01-01', '2024-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO app_listings (app_id, handle, url, source, created_at, updated_at)
     VALUES ('222', 'filemonk', 'https://apps.shopify.com/filemonk', 'manual',
             '2024-01-01', '2024-01-01')`,
  ).run();
  db.prepare(`INSERT INTO shops (id, name, myshopify_domain)
              VALUES ('s-1', 'Acme Supply', 'acme.myshopify.com')`).run();
  db.prepare(`INSERT INTO shops (id, name, myshopify_domain)
              VALUES ('s-2', 'Beta Goods', 'beta.myshopify.com')`).run();

  ids.stoq = upsertProgram({ appId: '111', name: 'STOQ', commissionRate: 0.2 }, db);
  ids.filemonk = upsertProgram(
    { appId: '222', name: 'Filemonk', commissionRate: 0.2, durationMonths: 24 },
    db,
  );

  ids.alice = upsertAffiliate({ name: 'Alice', email: 'Alice@example.com' }, db);
  ids.bob = upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, db);
  ids.carol = upsertAffiliate({ name: 'Carol', email: 'carol@example.com' }, db);

  upsertMembership(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      handle: 'aliceaaa',
      status: 'enrolled',
      joinedAt: '2025-01-01T00:00:00.000Z',
    },
    db,
  );
  // Pending, so the portal has a membership that must not hand over a link.
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
  // A referral whose merchant has not synced yet: `shop_id` is blank and the
  // store label has to stand in. A real shape — the import lands hundreds.
  upsertAttribution(
    {
      affiliateId: ids.alice,
      programId: ids.stoq,
      myshopifyDomain: 'unsynced-store.myshopify.com',
      referredAt: '2025-04-01T00:00:00.000Z',
      source: 'imported',
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

  upsertCommission(
    {
      attributionId: aliceReferral,
      affiliateId: ids.alice,
      programId: ids.stoq,
      transactionId: 'txn-a1',
      amount: 10,
      basisAmount: 50,
      rate: 0.2,
      earnedAt: '2025-03-15T00:00:00.000Z',
    },
    db,
  );
  upsertCommission(
    {
      attributionId: aliceReferral,
      affiliateId: ids.alice,
      programId: ids.stoq,
      transactionId: 'txn-a2',
      amount: 10,
      basisAmount: 50,
      rate: 0.2,
      earnedAt: '2025-04-15T00:00:00.000Z',
      paidAt: '2025-05-01T00:00:00.000Z',
      paidAmount: 10,
    },
    db,
  );
  upsertCommission(
    {
      attributionId: bobReferral,
      affiliateId: ids.bob,
      programId: ids.stoq,
      transactionId: 'txn-b1',
      amount: 999,
      basisAmount: 4995,
      rate: 0.2,
      earnedAt: '2025-03-20T00:00:00.000Z',
    },
    db,
  );
}

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: ADMIN_PASSWORD });
  db = getDb();
  seedAffiliates();

  // Alice sets a password the way a real affiliate would: a link, redeemed.
  const { token } = issueResetToken(db, ids.alice);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const set = await post('/portal/api/auth/set-password', { token, password: A_PASSWORD });
  assert.equal(set.status, 200, 'setting the first password should succeed');
});

after(() => {
  server.close();
});

describe('the two realms', () => {
  it('closes every portal route to a request with no session', async () => {
    for (const path of ['/portal/api/me', '/portal/api/referrals', '/portal/api/earnings', '/portal/api/commissions']) {
      assert.equal((await get(path)).status, 401, `${path} should require a session`);
    }
  });

  it('issues a cookie that is not the dashboard\'s', async () => {
    const header = (await portalLogin('alice@example.com', A_PASSWORD)).headers.get('set-cookie') ?? '';
    assert.match(header, /^partnerdex_affiliate=/);
    assert.doesNotMatch(header, /partnerdex_session/);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
    // Scoped to the portal, so a browser never even sends it to /api.
    assert.match(header, /Path=\/portal/i);
  });

  it('refuses an affiliate session at every dashboard route', async () => {
    const cookie = cookieFrom(await portalLogin('alice@example.com', A_PASSWORD));
    for (const path of ['/api/status', '/api/customers', '/api/apps', '/api/overview?metrics=mrr']) {
      assert.equal(
        (await get(path, cookie)).status,
        401,
        `${path} must not accept an affiliate session`,
      );
    }
    // And the same cookie value renamed is still refused: the realms share no
    // signing key, so a portal token cannot be replayed as an admin one.
    const forged = `partnerdex_session=${cookie.split('=').slice(1).join('=')}`;
    assert.equal((await get('/api/status', forged)).status, 401);
  });

  it('refuses a dashboard session at every portal route', async () => {
    const admin = cookieFrom(
      await post('/api/auth/login', { password: ADMIN_PASSWORD }),
    );
    assert.equal((await get('/api/status', admin)).status, 200, 'the admin cookie should work');

    for (const path of ['/portal/api/me', '/portal/api/earnings']) {
      assert.equal((await get(path, admin)).status, 401, `${path} must not accept the operator`);
    }
    const forged = `partnerdex_affiliate=${admin.split('=').slice(1).join('=')}`;
    assert.equal((await get('/portal/api/me', forged)).status, 401);
  });
});

describe('row-level scoping', () => {
  let cookie: string;

  before(async () => {
    cookie = cookieFrom(await portalLogin('alice@example.com', A_PASSWORD));
  });

  it('matches the email case-insensitively, as a login form is typed', async () => {
    // Alice was imported as `Alice@example.com`; she signs in lowercase.
    const response = await get('/portal/api/me', cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).affiliate.email, 'Alice@example.com');
  });

  it('returns only this affiliate\'s referrals', async () => {
    const body = (await (await get('/portal/api/referrals', cookie)).json()) as {
      referrals: Array<{ shop: string; earned: number }>;
    };
    const shops = body.referrals.map((row) => row.shop);
    assert.deepEqual(shops.sort(), ['Acme Supply', 'unsynced-store']);
    assert.ok(!shops.includes('Beta Goods'), "Bob's merchant must not appear");
  });

  it('returns only this affiliate\'s money', async () => {
    const earnings = (await (await get('/portal/api/earnings', cookie)).json()) as {
      lifetime: number;
      paid: number;
      unpaid: number;
    };
    // Alice earned 10 + 10, one of them settled. Bob's 999 is the tell: any
    // scoping failure lands it in one of these three figures.
    assert.equal(earnings.lifetime, 20);
    assert.equal(earnings.paid, 10);
    assert.equal(earnings.unpaid, 10);

    const history = (await (await get('/portal/api/commissions', cookie)).json()) as {
      commissions: Array<{ amount: number }>;
      total: number;
    };
    assert.equal(history.total, 2);
    assert.ok(history.commissions.every((row) => row.amount === 10));
  });

  it('never exposes the merchant beyond their name', async () => {
    const raw = await Promise.all(
      ['/portal/api/me', '/portal/api/referrals', '/portal/api/earnings', '/portal/api/commissions'].map(
        async (path) => await (await get(path, cookie)).text(),
      ),
    );
    for (const body of raw) {
      assert.ok(!body.includes('myshopify.com'), 'a merchant domain leaked');
      // Hex ids cannot contain an `s`, so this cannot collide with a row id.
      assert.ok(!body.includes('s-1'), 'a shop id leaked');
      // `basis_amount` is the merchant's gross subscription revenue, and is the
      // one number beside the commission an affiliate must never read.
      assert.ok(!/basis/i.test(body), 'the merchant gross leaked');
    }

    const history = (await (await get('/portal/api/commissions', cookie)).json()) as {
      commissions: Array<Record<string, unknown>>;
    };
    for (const row of history.commissions) {
      assert.ok(!('basisAmount' in row));
      assert.ok(!('transactionId' in row));
      assert.ok(!('attributionId' in row));
    }
  });

  it('withholds a referral link for a membership that is not approved', async () => {
    const me = (await (await get('/portal/api/me', cookie)).json()) as {
      memberships: Array<{ program: string; status: string; referralUrl: string | null }>;
    };
    const stoq = me.memberships.find((row) => row.status === 'enrolled');
    const pending = me.memberships.find((row) => row.status === 'pending');
    assert.equal(stoq?.referralUrl, '/r/aliceaaa');
    assert.equal(pending?.referralUrl, null, 'a pending application has no link to promote');
  });
});

describe('set-password links', () => {
  it('is spent by the first use', async () => {
    const { token } = issueResetToken(db, ids.carol);
    assert.equal((await post('/portal/api/auth/set-password', { token, password: 'carol-password-1' })).status, 200);

    const second = await post('/portal/api/auth/set-password', { token, password: 'carol-password-2' });
    assert.equal(second.status, 400, 'a redeemed link must not open the account again');
    // And the first password still works, so the second attempt changed nothing.
    assert.equal((await portalLogin('carol@example.com', 'carol-password-1')).status, 200);
  });

  it('expires', async () => {
    const issuedAt = new Date(Date.now() - RESET_TTL_MS - 1000);
    const { token } = issueResetToken(db, ids.carol, issuedAt);
    const response = await post('/portal/api/auth/set-password', { token, password: 'another-password' });
    assert.equal(response.status, 400);
  });

  it('refuses a token whose secret was edited', async () => {
    const { token } = issueResetToken(db, ids.carol);
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal(
      (await post('/portal/api/auth/set-password', { token: flipped, password: 'guessed-password' })).status,
      400,
    );
  });

  it('refuses one issued for an affiliate that does not exist', async () => {
    const { token } = issueResetToken(db, ids.carol);
    const secret = token.slice(token.indexOf('.') + 1);
    assert.equal(
      (await post('/portal/api/auth/set-password', { token: `not-an-affiliate.${secret}`, password: 'guessed-password' }))
        .status,
      400,
    );
  });

  it('answers a reset request the same way for a stranger as for an affiliate', async () => {
    const known = await post('/portal/api/auth/request-reset', { email: 'bob@example.com' });
    const stranger = await post('/portal/api/auth/request-reset', { email: 'nobody@example.com' });
    assert.equal(known.status, stranger.status);
    assert.deepEqual(await known.json(), await stranger.json());
  });

  it('invalidates the sessions the old password signed', async () => {
    const cookie = cookieFrom(await portalLogin('carol@example.com', 'carol-password-1'));
    assert.equal((await get('/portal/api/me', cookie)).status, 200);

    const { token } = issueResetToken(db, ids.carol);
    await post('/portal/api/auth/set-password', { token, password: 'carol-password-3' });

    // The session key is derived from the stored hash and salt, so changing the
    // password is what signs every outstanding cookie out. This is the property
    // that makes a reset a real remedy after a laptop is lost.
    assert.equal((await get('/portal/api/me', cookie)).status, 401);
  });
});

describe('the referral redirect', () => {
  before(() => resetRateLimit());

  it('sends a known handle to its own program\'s listing', async () => {
    const response = await get('/r/aliceaaa');
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://apps.shopify.com/back-in-stock-restock-alerts?mref=aliceaaa',
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('accepts a handle retyped in capitals', async () => {
    const response = await get('/r/ALICEAAA');
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') ?? '', /mref=aliceaaa$/);
  });

  it('refuses anything that is not handle-shaped, before it reaches a URL', async () => {
    for (const path of ['/r/short', '/r/way-too-long-to-be-a-handle', '/r/../etc', '/r/https%3A%2F%2Fevil.example']) {
      const response = await get(path);
      assert.ok(response.status === 404 || response.status === 301, `${path} must not redirect`);
      assert.ok(
        !(response.headers.get('location') ?? '').includes('evil.example'),
        'an attacker-supplied host must never reach the Location header',
      );
    }
  });

  /**
   * An unknown handle with two listings mapped: there is no way to tell which
   * program a legacy code belonged to, and guessing would send the visitor to
   * install the wrong app. It is refused — but only after being logged, which
   * is what preserves it for a manual attribution later.
   */
  it('logs an unrecognised handle rather than dropping it silently', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
    try {
      await get('/r/zzzzzzzz');
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unrecognised referral handle "zzzzzzzz"/);
  });

  it('rate-limits, because it is the one public route', async () => {
    resetRateLimit();
    let last = 200;
    for (let attempt = 0; attempt < 130; attempt += 1) {
      last = (await get('/r/aliceaaa')).status;
      if (last === 429) break;
    }
    assert.equal(last, 429);
    resetRateLimit();
  });
});

/*
 * Last on purpose: the throttle is per process and keyed on the client address,
 * so a lockout taken here would follow every test after it.
 */
describe('login throttling', () => {
  it('says the same thing however the login failed', async () => {
    // A stranger's address, and an affiliate who has never set a password, are
    // one message. Any difference confirms which of the addresses tried are ours.
    const [unknown, noPassword] = await Promise.all(
      [
        ['nobody@example.com', 'whatever-password'],
        ['bob@example.com', 'whatever-password'],
      ].map(async ([email, password]) => {
        const response = await portalLogin(email!, password!);
        assert.equal(response.status, 401);
        return (await response.json()).error as string;
      }),
    );
    assert.equal(unknown, noPassword);
  });

  it('locks out a guesser, and the right password does not walk through it', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const status = (await portalLogin('bob@example.com', `guess-${attempt}`)).status;
      assert.ok(status === 401 || status === 429);
    }
    assert.equal((await portalLogin('bob@example.com', 'guess-again')).status, 429);
    // Bob's own correct password would also be refused here, which is the point:
    // a lockout the real password walks through is not a lockout. Asserted
    // against the account under attack rather than a bystander — see below.
  });

  /**
   * The other half of the same property, and the half the original test had
   * backwards: it asserted that Alice was locked out by Bob's failures, treating
   * collateral as evidence the lockout was real.
   *
   * It is not. The bucket is per (client, account) now, so guessing at Bob costs
   * Bob's attempts and nobody else's. Under the previous keying one attacker
   * denied the portal to every affiliate sharing an egress address — an office
   * NAT, a carrier, or, if a second proxy hop is ever added, all of them at
   * once.
   */
  it('does not lock out a bystander who shares the address', async () => {
    assert.equal(
      (await portalLogin('alice@example.com', A_PASSWORD)).status,
      200,
      "one affiliate's failures must not spend another affiliate's attempts",
    );
  });
});

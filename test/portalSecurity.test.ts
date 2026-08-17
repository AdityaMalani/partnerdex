import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { upsertAffiliate } from '../src/affiliates/store.js';
import { issueResetToken, resetPortalThrottles } from '../src/server/portalAuth.js';
import { createThrottle } from '../src/server/throttle.js';
import { resetEnvironment } from './helpers.js';

/**
 * The findings from the pre-launch security review, pinned.
 *
 * Each test here corresponds to something an adversarial reviewer reproduced
 * against a running server, and each is written to fail against the code as it
 * stood before the fix rather than to describe the fix. Where the review gives a
 * measurement, the assertion is on the *property* — links do not appear in the
 * log, the two login paths cost comparable time, the map is bounded — because
 * the numbers were taken on one machine and the property is what has to hold on
 * every other one.
 *
 * `test/portal.test.ts` keeps the isolation and scoping tests. Those were
 * attacked and held; nothing here should ever need to relax one.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';
const ALICE_PASSWORD = 'alice-portal-password';

let server: Server;
let origin: string;
let db: Db;
const ids = { alice: '', bob: '' };

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** Everything written to stdout/stderr while `run` executes. */
async function captureLogs(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  console.warn = (...args: unknown[]) => void lines.push(args.join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: ADMIN_PASSWORD });
  db = getDb();
  ids.alice = upsertAffiliate({ name: 'Alice', email: 'alice@example.com' }, db);
  ids.bob = upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, db);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { token } = issueResetToken(db, ids.alice);
  assert.equal(
    (await post('/portal/api/auth/set-password', { token, password: ALICE_PASSWORD })).status,
    200,
  );
});

after(() => server.close());

describe('set-password links are not published to the log', () => {
  before(() => resetPortalThrottles());

  /**
   * The review captured a complete working takeover link from stdout. Every one
   * of the imported accounts has to use this flow, so that was not an edge
   * case: it was the whole onboarding path, published to everyone who can read
   * a container log.
   */
  it('writes no token, and no link, when an affiliate asks for one', async () => {
    const logs = await captureLogs(async () => {
      const response = await post('/portal/api/auth/request-reset', {
        email: 'alice@example.com',
      });
      assert.equal(response.status, 200);
    });

    assert.ok(!logs.includes('#/set-password/'), 'a set-password link reached the log');
    // The token is `<affiliateId>.<secret>`, so the id followed by a dot is the
    // shape to look for regardless of what the secret happens to be.
    assert.ok(!logs.includes(`${ids.alice}.`), 'a reset token reached the log');

    // And the flow still did its job: a token exists to be delivered, which is
    // what a sender wired into `deliverSetPasswordLink` would pick up.
    const row = db
      .prepare('SELECT reset_token_hash AS hash FROM affiliate_credentials WHERE affiliate_id = ?')
      .get(ids.alice) as { hash: string };
    assert.ok(row.hash.length > 0, 'the request should still mint a token');
  });

  it('mints a working link for an authenticated operator, and for nobody else', async () => {
    assert.equal(
      (await post(`/api/affiliates/${ids.bob}/set-password-link`, {})).status,
      401,
      'minting a takeover link must sit behind the dashboard gate',
    );

    const admin = (await post('/api/auth/login', { password: ADMIN_PASSWORD })).headers
      .get('set-cookie')!
      .split(';')[0]!;

    const response = await post(`/api/affiliates/${ids.bob}/set-password-link`, {}, admin);
    assert.equal(response.status, 200);
    const { link } = (await response.json()) as { link: { url: string; email: string } };
    assert.equal(link.email, 'bob@example.com');
    assert.match(link.url, /\/portal#\/set-password\//);

    // The link is only worth anything if it opens the account, so redeem it.
    const token = link.url.split('/set-password/')[1]!;
    assert.equal(
      (await post('/portal/api/auth/set-password', { token, password: 'bob-portal-password' }))
        .status,
      200,
    );
    assert.equal(
      (await post('/portal/api/auth/login', { email: 'bob@example.com', password: 'bob-portal-password' }))
        .status,
      200,
    );
  });

  it('mints the whole population in one call, so nobody greps a log for all of them', async () => {
    const admin = (await post('/api/auth/login', { password: ADMIN_PASSWORD })).headers
      .get('set-cookie')!
      .split(';')[0]!;

    const response = await post('/api/affiliates/set-password-links', {}, admin);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      links: Array<{ affiliateId: string; url: string }>;
      minted: number;
    };
    assert.equal(body.minted, 2, 'both active affiliates should get a link');
    assert.deepEqual(
      body.links.map((link) => link.affiliateId).sort(),
      [ids.alice, ids.bob].sort(),
    );
    for (const link of body.links) assert.match(link.url, /\/portal#\/set-password\//);
  });
});

describe('the login timing oracle', () => {
  before(() => resetPortalThrottles());

  /**
   * The review measured 21ms for an address that is one of ours against 0.7ms
   * for one that is not — a 25× separation readable in a single probe, which
   * turns any list of addresses into a list of our affiliates.
   *
   * The assertion is deliberately loose: this runs on shared CI hardware where a
   * garbage collection or a noisy neighbour can double any single measurement,
   * and the property under test is "the same order of magnitude", not a number.
   * Medians rather than means, because one descheduled request should not decide
   * the result. A 4× ceiling still fails the pre-fix code by six times over
   * while leaving enormous room for a loaded machine.
   *
   * Probing an account that exists is done with the *correct* password, which
   * keeps both arms at exactly one scrypt and, incidentally, keeps the throttle
   * out of the measurement — a success clears its own bucket.
   */
  it('takes comparable time for a real address and an unknown one', async () => {
    const time = async (email: string, password: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await post('/portal/api/auth/login', { email, password });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const median = (values: number[]): number =>
      values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

    // Warm up: the first scrypt in a process pays for lazily building the decoy
    // row, and the first fetch pays for the socket.
    for (let i = 0; i < 3; i += 1) {
      await time('alice@example.com', ALICE_PASSWORD);
      await time(`warmup-${i}@example.com`, 'whatever-password');
    }

    const real: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      real.push(await time('alice@example.com', ALICE_PASSWORD));
      // A fresh address each time, so no probe is answered by a lockout rather
      // than by the code path under measurement.
      unknown.push(await time(`nobody-${i}@example.com`, 'whatever-password'));
    }

    const ratio = median(real) / median(unknown);
    assert.ok(
      ratio > 0.25 && ratio < 4,
      `login timing should not disclose whether an address exists ` +
        `(real ${median(real).toFixed(1)}ms vs unknown ${median(unknown).toFixed(1)}ms)`,
    );
  });
});

describe('throttling that cannot be turned around on the population', () => {
  before(() => resetPortalThrottles());

  /**
   * The review's exact reproduction: four failures for one address locked out
   * everyone behind it, including an affiliate presenting the right password.
   */
  it('keeps one affiliate\'s failures off another\'s account', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await post('/portal/api/auth/login', {
        email: 'bob@example.com',
        password: `guess-${attempt}`,
      });
    }
    assert.equal(
      (await post('/portal/api/auth/login', { email: 'bob@example.com', password: 'guess-again' }))
        .status,
      429,
      'the account under attack should be locked',
    );
    assert.equal(
      (await post('/portal/api/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD }))
        .status,
      200,
      'a bystander on the same address must still be able to sign in',
    );
  });

  /**
   * `request-reset` counted every request, successes included, against the login
   * budget — so five honest "send me a link" clicks bricked the only recovery
   * path there is, on the flow all affiliates must complete.
   */
  it('does not spend the login budget on legitimate reset requests', async () => {
    resetPortalThrottles();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await post('/portal/api/auth/request-reset', { email: 'alice@example.com' });
      assert.equal(response.status, 200, `reset request ${attempt + 1} should be served`);
    }
    assert.equal(
      (await post('/portal/api/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD }))
        .status,
      200,
      'asking for a link must not consume login attempts',
    );
  });
});

/**
 * The throttle itself, unit-tested with a compressed clock.
 *
 * Over a socket these properties would take a quarter of an hour to observe, so
 * they are exercised through the options seam instead. The ratios between the
 * numbers are the same ones the defaults use.
 */
describe('the throttle', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('lets failures age out, so a lockout cannot be walked up forever', async () => {
    const throttle = createThrottle({
      maxAttempts: 3,
      lockoutMs: 30,
      decayMs: 30,
      maxLockoutMs: 300,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure('client');
    assert.ok(throttle.lockoutSeconds('client') > 0, 'three failures should lock');

    // Long enough for the lockout to expire and for two failures to decay.
    await sleep(120);
    assert.equal(throttle.lockoutSeconds('client'), 0);

    // The attack the review describes: one wrong password per expired lockout.
    // Before decay this drove the penalty up 60s a step with no ceiling; now the
    // failure that arrives after the wait replaces one that aged out.
    throttle.recordFailure('client');
    assert.equal(
      throttle.lockoutSeconds('client'),
      0,
      'a single failure after a quiet period must not re-lock the bucket',
    );
  });

  it('caps how long any one lockout can last', () => {
    const throttle = createThrottle({
      maxAttempts: 3,
      lockoutMs: 1_000,
      decayMs: 60_000,
      maxLockoutMs: 4_000,
    });
    for (let attempt = 0; attempt < 200; attempt += 1) throttle.recordFailure('client');
    assert.ok(
      throttle.lockoutSeconds('client') <= 4,
      'an unbounded penalty is a denial of service against whoever shares the key',
    );
  });

  it('forgets a key once it has fully decayed', async () => {
    const throttle = createThrottle({ maxAttempts: 3, lockoutMs: 10, decayMs: 20 });
    throttle.recordFailure('client');
    assert.equal(throttle.size(), 1);
    await sleep(60);
    throttle.lockoutSeconds('client');
    assert.equal(throttle.size(), 0, 'a spent key should not be retained');
  });

  /**
   * Keys are created by unauthenticated requests — `request-reset` needs no
   * account at all — and the review measured 187 MB of heap per million entries.
   * With no eviction that is a remote OOM against a single-threaded process.
   */
  it('stays bounded no matter how many keys arrive', () => {
    const throttle = createThrottle({ maxEntries: 100 });
    for (let i = 0; i < 5_000; i += 1) throttle.recordFailure(`client-${i}`);
    assert.ok(
      throttle.size() <= 100,
      `the map must be bounded, held ${throttle.size()} entries`,
    );
    // And it still throttles the clients it does know about: eviction drops the
    // oldest keys, it does not stop counting.
    for (let attempt = 0; attempt < 6; attempt += 1) throttle.recordFailure('recent');
    assert.ok(throttle.lockoutSeconds('recent') > 0);
  });
});

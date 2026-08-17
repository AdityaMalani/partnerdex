import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { ConfigError, resetConfig } from '../src/config.js';
import { getDb, type Db } from '../src/db/index.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { writeCache } from '../src/metrics/cache.js';
import { sendMail, type SmtpSettings } from '../src/notifications/email.js';
import { upsertAffiliate } from '../src/affiliates/store.js';
import { createApp } from '../src/server/index.js';
import {
  configureResetCeiling,
  issueResetToken,
  resetPortalThrottles,
} from '../src/server/portalAuth.js';
import { configureScryptPool, resetScryptPool } from '../src/server/scryptPool.js';
import {
  awaitBigquerySync,
  bigquerySyncJob,
  resetBigquerySyncJob,
  setBigquerySyncRunner,
} from '../src/sync/bigquerySyncJob.js';
import { resetEnvironment } from './helpers.js';

/**
 * The availability findings from the full-application security review, pinned.
 *
 * The theme of that review was that this is a single-threaded Node process over
 * synchronous SQLite, and that an unauthenticated attacker could stall it. Each
 * test here corresponds to something the reviewer measured against a running
 * server, and each is written to fail against the code as it stood before the
 * fix rather than to describe the fix.
 *
 * **On the timing assertions.** Several of these are wall-clock measurements,
 * which is the only way to observe an event-loop stall at all — and wall-clock
 * measurements flake on a loaded machine. Every bound here is therefore chosen
 * an order of magnitude away from both the pre-fix number and the post-fix one,
 * so the test is asking "did the stall go away", not "how fast is this box".
 * Where a ratio will do, a ratio is used, and medians are preferred to means so
 * that one descheduled request cannot decide the outcome. If one of these
 * starts flaking, widen the bound — do not narrow the property.
 *
 * `test/portalSecurity.test.ts` keeps the previous review's findings, including
 * the login timing-oracle test that the F1 fix had to preserve. Nothing here
 * should ever need to relax one of those.
 */

const ALICE_PASSWORD = 'alice-portal-password';

let server: Server;
let origin: string;
let db: Db;
let aliceId = '';

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const median = (values: number[]): number =>
  values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/**
 * A POST over a caller-supplied agent, so a test can decide how many sockets it
 * really opens. `fetch` cannot: its agent pools a small number of connections
 * per origin, which silently serializes a burst.
 */
function rawPost(agent: http.Agent, path: string, body: unknown): Promise<number> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${origin}${path}`,
      {
        agent,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

/** Wall-clock milliseconds for one request. */
async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = process.hrtime.bigint();
  await run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

before(async () => {
  resetEnvironment();
  db = getDb();
  aliceId = upsertAffiliate({ name: 'Alice', email: 'alice@example.com' }, db);
  upsertAffiliate({ name: 'Bob', email: 'bob@example.com' }, db);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { token } = issueResetToken(db, aliceId);
  assert.equal(
    (await post('/portal/api/auth/set-password', { token, password: ALICE_PASSWORD })).status,
    200,
  );
});

after(() => {
  server.close();
  resetScryptPool();
  resetBigquerySyncJob();
  configureResetCeiling(null);
});

/* ------------------------------------------------------------------- F1 */

describe('F1: the portal login cannot stall the process', () => {
  before(() => {
    resetPortalThrottles();
    resetScryptPool();
  });
  after(() => {
    resetPortalThrottles();
    resetScryptPool();
  });

  /**
   * The review's headline measurement: 150 concurrent logins from one IP with a
   * rotating email took `/api/health` from 1.6 ms to 2.8 s, because every one of
   * them ran a synchronous `scryptSync` on the event loop.
   *
   * **This test asserts no wall-clock number.** It used to — "the worst health
   * probe is under 500 ms" — and that bound is a statement about how loaded the
   * machine is as much as about the code. It held on an idle box and failed on a
   * contended one, which is exactly what a CI runner is.
   *
   * The property underneath it does not need a clock reading, only an ordering.
   * If the login hashes synchronously on the event loop, a health probe sent
   * after the burst has landed cannot be served until the queued hashing is
   * finished — so *every* login settles before the probes come back. If the
   * hashing happens off the loop, the probes come back while most of the burst
   * is still outstanding. So:
   *
   *   1. the probe sweep must finish while the burst is still in flight, and
   *   2. a health probe must cost a small fraction of the whole burst.
   *
   * Both are ratios between two things measured on the same machine in the same
   * second, so contention moves them together and neither has a magic constant
   * in it. The real margins are enormous — a health probe is a few milliseconds
   * against a burst that is hundreds of scrypts deep — so the factors below are
   * loose on purpose. If one of these ever fails it is because the hashing moved
   * back onto the event loop, which is the only thing this test is for.
   */
  it('keeps an unrelated endpoint answering during a burst of logins', async () => {
    /*
     * Sent over a raw agent with a socket per request rather than through
     * `fetch`. That detail is load-bearing: the global fetch agent keeps only a
     * couple of connections to one origin, so a "concurrent" burst through it
     * arrives at the server a request or two at a time and never builds the
     * queue depth that produces the stall. Measured while writing this test —
     * with 80 requests through `fetch` and a *deliberately* re-broken
     * synchronous hash, the health probe never went past 64 ms, which would
     * have made this test pass against the very bug it exists to catch.
     *
     * The pool is left at its shipped size, so this is the real cap doing the
     * work, not a test-only configuration.
     */
    const agent = new http.Agent({ maxSockets: 200, keepAlive: false });
    const burstStarted = process.hrtime.bigint();
    let settled = 0;
    const burst = Array.from({ length: 150 }, (_value, index) =>
      rawPost(agent, '/portal/api/auth/login', {
        email: `flood-${index}@example.com`,
        password: 'whatever-password',
      })
        .catch(() => undefined)
        .then(() => {
          settled += 1;
        }),
    );

    // Let every socket connect and every request land before probing, so the
    // probe really is competing with a full queue rather than racing it there.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const health: number[] = [];
    for (let probe = 0; probe < 12; probe += 1) {
      health.push(await timed(() => fetch(`${origin}/api/health`)));
    }
    const settledWhenProbesReturned = settled;
    await Promise.all(burst);
    const burstMs = Number(process.hrtime.bigint() - burstStarted) / 1e6;
    agent.destroy();

    /*
     * Ordering, not latency. A stalled event loop cannot answer the probes until
     * it has finished hashing, so on the broken code this count is the whole
     * burst. Off the loop, most of the burst is still waiting on the pool.
     */
    assert.ok(
      settledWhenProbesReturned < burst.length,
      'a login burst must not stall /api/health: every one of the ' +
        `${burst.length} logins had already finished by the time ${health.length} health ` +
        'probes came back, which is what queueing behind a blocked event loop looks like',
    );

    /*
     * And a ratio between two measurements taken on the same box in the same
     * second: serving health must be cheap next to the burst it is competing
     * with. Blocked, the probe pays for the burst and the two converge.
     */
    assert.ok(
      median(health) * 4 < burstMs,
      `a health probe must cost a fraction of the burst it runs against (median probe ` +
        `${median(health).toFixed(1)}ms, worst ${Math.max(...health).toFixed(1)}ms, ` +
        `whole burst ${burstMs.toFixed(0)}ms)`,
    );
  });

  /**
   * The other half of the same finding: the per-(address, account) throttle is
   * keyed on the email, so rotating the email is a fresh bucket every time. The
   * reviewer sent eight rotated addresses from one IP and got eight 401s and
   * zero 429s — every one of which bought a full scrypt.
   *
   * The address-only counter is charged before any hashing happens, so a client
   * that keeps rotating runs out of budget instead of running out of our CPU.
   */
  it('charges a rotating email address to the client that sent it', async () => {
    resetPortalThrottles();

    let refused = 0;
    // One more than the address budget of 60, sent serially so the count is
    // deterministic rather than a race between concurrent charges.
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const response = await post('/portal/api/auth/login', {
        email: `rotating-${attempt}@example.com`,
        password: 'whatever-password',
      });
      if (response.status === 429) refused += 1;
    }

    assert.ok(
      refused > 0,
      'rotating the email must not buy unlimited free password hashing',
    );
  });

  /**
   * Past the cap, work is refused rather than queued forever.
   *
   * An unbounded queue turns a flood into unbounded memory and unbounded
   * latency: every request eventually runs, long after the client gave up. The
   * pool is shrunk through its test seam so the edge is reachable in
   * milliseconds; the shape being asserted is the shipped one.
   */
  it('refuses past its cap instead of queueing without limit', async () => {
    resetPortalThrottles();
    configureScryptPool({ maxInFlight: 1, maxWaiting: 2, maxWaitMs: 25 });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        post('/portal/api/auth/login', {
          email: 'alice@example.com',
          password: 'wrong-password-entirely',
        }),
      ),
    );
    const statuses = responses.map((response) => response.status);

    assert.ok(statuses.includes(429), 'an overloaded pool should shed load with 429');
    assert.ok(
      statuses.every((status) => status === 429 || status === 401),
      `only 401 and 429 are acceptable here, saw ${[...new Set(statuses)].join(', ')}`,
    );

    resetScryptPool();
  });

  /**
   * The property the F1 fix was not allowed to buy its way out of.
   *
   * The previous review's F4 was a timing oracle: an address that is one of ours
   * cost 21 ms and one that is not cost 0.7 ms, which turns any address list
   * into a roster of our affiliates. The fix was to hash against a decoy on the
   * missing-account path, which is what made login expensive in the first place.
   * Moving that hash off the event loop must not have reintroduced a
   * short-circuit — both arms still run exactly one scrypt through one queue.
   *
   * Loose on purpose, and for the same reason the original is: 4× on medians
   * still fails the pre-fix code six times over while tolerating a noisy box.
   */
  it('still takes comparable time for a real address and an unknown one', async () => {
    resetPortalThrottles();
    resetScryptPool();

    const time = (email: string, password: string): Promise<number> =>
      timed(() => post('/portal/api/auth/login', { email, password }));

    // The first login in a process pays to build the decoy row, and the first
    // fetch pays for the socket. Neither is the thing under measurement.
    for (let i = 0; i < 3; i += 1) {
      await time('alice@example.com', ALICE_PASSWORD);
      await time(`avail-warmup-${i}@example.com`, 'whatever-password');
    }

    const real: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      // The correct password on the real arm keeps both arms at exactly one
      // scrypt, and keeps the account throttle out of the measurement.
      real.push(await time('alice@example.com', ALICE_PASSWORD));
      unknown.push(await time(`avail-nobody-${i}@example.com`, 'whatever-password'));
    }

    const ratio = median(real) / median(unknown);
    assert.ok(
      ratio > 0.25 && ratio < 4,
      `login timing must not disclose whether an address exists ` +
        `(real ${median(real).toFixed(1)}ms vs unknown ${median(unknown).toFixed(1)}ms)`,
    );
  });
});

/* ------------------------------------------------------------------- F2 */

describe('F2: the admin BigQuery sync does not run on the request thread', () => {
  before(() => resetBigquerySyncJob());
  after(() => resetBigquerySyncJob());

  /**
   * The review's F2, and an incident that already happened: `POST
   * /api/bigquery/sync` awaited the whole ingest inline — up to 500 pages of
   * 10,000 synchronous inserts — so one authenticated click froze the event
   * loop for minutes, the health check failed and Fly pulled the machine.
   *
   * The runner is replaced with a slow stub rather than a real fork, because
   * what is under test is that the *route* returns before the work does. 200 ms
   * against a job that takes 600 ms is a wide margin either way: pre-fix the
   * route could not answer before 600 ms by construction.
   */
  it('accepts the job and answers immediately', async () => {
    let finish = (): void => {};
    setBigquerySyncRunner(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ apps: ['111'], rows: 7, skipped: [] });
          setTimeout(finish, 600);
        }),
    );

    let response!: Response;
    const elapsed = await timed(async () => {
      response = await post('/api/bigquery/sync', {});
    });

    assert.equal(response.status, 202, 'a started job is accepted, not awaited');
    assert.ok(elapsed < 200, `the route should return promptly, took ${elapsed.toFixed(0)}ms`);
    assert.equal(bigquerySyncJob().running, true);

    // A second call while one is running must be refused, not stacked: two
    // ingests advance the same watermarks against a single-writer database.
    const second = await post('/api/bigquery/sync', {});
    assert.equal(second.status, 409, 'a concurrent second run must be refused');

    finish();
    await awaitBigquerySync();

    // And the result is readable from the surface that already polls, so a 202
    // is not the last anyone hears about the run they started.
    const status = (await (await fetch(`${origin}/api/bigquery`)).json()) as {
      job: { running: boolean; result: { rows: number } | null; error: string | null };
    };
    assert.equal(status.job.running, false);
    assert.equal(status.job.error, null);
    assert.equal(status.job.result?.rows, 7);
  });

  it('records a failed run rather than losing it', async () => {
    resetBigquerySyncJob();
    setBigquerySyncRunner(() => Promise.reject(new Error('dataset not found')));

    assert.equal((await post('/api/bigquery/sync', {})).status, 202);
    await awaitBigquerySync();

    const job = bigquerySyncJob();
    assert.equal(job.running, false);
    assert.equal(job.error, 'dataset not found');
    // The guard must have been released, or one failure blocks every later run.
    assert.equal((await post('/api/bigquery/sync', {})).status, 202);
    await awaitBigquerySync();
  });
});

/* ------------------------------------------------------------------- F3 */

describe('F3: cache writes do not block the event loop on the write lock', () => {
  /**
   * The review's F3. `busy_timeout = 5000` is honoured by better-sqlite3 by
   * blocking **synchronously in native code**, and the server writes on hot GET
   * paths (`writeCache`, on every uncached metric). A metric request landing
   * while the sync worker holds the write lock therefore froze the whole
   * process for up to five seconds. That is a large part of why the background
   * sync is switched off in production.
   *
   * This needs a real file database and a second connection, since two handles
   * are what produce contention at all. The bound is one second against a
   * pre-fix five: enormous headroom over the ~20 ms the fix waits, and still
   * five times clear of the old behaviour.
   */
  it('gives up quickly when the write lock is held, and loses nothing but a cache entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdx-cache-'));
    const file = path.join(dir, 'contended.db');
    let blocker: Database.Database | null = null;
    let contended: Database.Database | null = null;
    const previousTtl = process.env.CACHE_TTL_SECONDS;

    try {
      // Two throwaway connections of its own rather than the shared fixture
      // handle: contention needs two handles on a real *file*, and swapping the
      // process-wide database out from under a suite that shares it is how a
      // later test finds its fixtures missing.
      process.env.CACHE_TTL_SECONDS = '600';
      resetConfig();

      contended = new Database(file);
      contended.exec(SCHEMA_SQL);
      // The value the server runs with, which is the one under test.
      contended.pragma('busy_timeout = 5000');

      blocker = new Database(file);
      // Zero, so the *blocker* never waits — only the code under test does.
      blocker.pragma('busy_timeout = 0');
      blocker.exec('BEGIN IMMEDIATE');

      const target = contended;
      const elapsed = await timed(async () => {
        writeCache(target, 'availability-probe', { value: 1 });
      });

      assert.ok(
        elapsed < 1_000,
        `a contended cache write must not block the event loop, took ${elapsed.toFixed(0)}ms`,
      );

      blocker.exec('ROLLBACK');

      // And once the lock is free the cache works normally again: this is a
      // best-effort write, not a disabled one.
      writeCache(contended, 'availability-probe', { value: 2 });
      const row = contended
        .prepare('SELECT payload FROM metric_cache WHERE key = ?')
        .get('availability-probe') as { payload: string } | undefined;
      assert.equal(row?.payload, JSON.stringify({ value: 2 }));

      // The connection's own timeout must be back where it was, or every other
      // writer in the server quietly stops waiting under contention.
      assert.equal(contended.pragma('busy_timeout', { simple: true }), 5000);
    } finally {
      blocker?.close();
      contended?.close();
      fs.rmSync(dir, { recursive: true, force: true });
      if (previousTtl === undefined) delete process.env.CACHE_TTL_SECONDS;
      else process.env.CACHE_TTL_SECONDS = previousTtl;
      resetConfig();
    }
  });
});

/* ------------------------------------------------------------------- F6 */

describe('F6: an unset dashboard password is loud, not silent', () => {
  const withEnv = (values: Record<string, string | undefined>, run: () => void): void => {
    const previous = { ...process.env };
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfig();
      run();
    } finally {
      process.env = previous;
      resetConfig();
    }
  };

  /**
   * The review's F6: with no password, `isAuthenticated` returns true for
   * everybody, and behind that gate sits `POST /api/affiliates/set-password-links`
   * — one request, hundreds of live 24-hour account-takeover links. A forgotten
   * `fly secrets set` is all it takes, and the only thing that used to happen was a
   * line in the startup log.
   */
  it('refuses to build a server with no password and no explicit consent', () => {
    withEnv({ DASHBOARD_PASSWORD: '', ALLOW_NO_AUTH: undefined }, () => {
      assert.throws(() => createApp(), ConfigError);
    });
  });

  /** The documented localhost workflow, unchanged except for saying so. */
  it('still runs without a password when the operator says they mean it', () => {
    withEnv({ DASHBOARD_PASSWORD: '', ALLOW_NO_AUTH: 'true' }, () => {
      assert.doesNotThrow(() => createApp());
    });
  });

  it('needs no opt-in at all once a password is set', () => {
    withEnv({ DASHBOARD_PASSWORD: 'correct-horse-battery', ALLOW_NO_AUTH: undefined }, () => {
      assert.doesNotThrow(() => createApp());
    });
  });
});

/* ------------------------------------------------------------------- F4 */

describe('F4: /request-reset cannot be flooded', () => {
  before(() => {
    resetPortalThrottles();
    configureResetCeiling(null);
  });
  after(() => {
    resetPortalThrottles();
    configureResetCeiling(null);
  });

  /**
   * The review's F4: the throttle is keyed per (address, email), so one IP
   * walking the known affiliate addresses spends one attempt per bucket and
   * is never throttled. Every hit replaces that affiliate's outstanding
   * set-password link — denying onboarding — and sends a real email.
   */
  it('charges a walk through many addresses to the client walking them', async () => {
    resetPortalThrottles();

    let refused = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await post('/portal/api/auth/request-reset', {
        email: `victim-${attempt}@example.com`,
      });
      if (response.status === 429) refused += 1;
    }

    assert.ok(refused > 0, 'iterating addresses from one client must eventually be refused');
  });

  /**
   * The distributed version of the same attack, which no per-client counter can
   * see: a few hundred addresses each asking politely once.
   *
   * Past the ceiling nothing is minted — which is the part that matters, since
   * minting is what invalidates a link somebody is about to use — and the reply
   * is byte-identical, because a distinguishable "we are rate limited" answer
   * would be an oracle for which addresses are ours.
   */
  it('stops replacing live tokens once the global ceiling is reached', async () => {
    resetPortalThrottles();
    configureResetCeiling(2);

    const tokenHash = (): string =>
      (
        db
          .prepare('SELECT reset_token_hash AS hash FROM affiliate_credentials WHERE affiliate_id = ?')
          .get(aliceId) as { hash: string }
      ).hash;

    const seen: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post('/portal/api/auth/request-reset', {
        email: 'alice@example.com',
      });
      assert.equal(response.status, 200, 'the answer must not reveal the ceiling');
      seen.push(tokenHash());
    }

    assert.notEqual(seen[0], seen[1], 'the first two requests are under the ceiling and mint');
    assert.equal(seen[2], seen[1], 'past the ceiling no new token replaces the live one');
    assert.equal(seen[3], seen[1], 'and it stays that way');

    configureResetCeiling(null);
  });
});

/* ------------------------------------------------------------------- F7 */

describe('F7: SMTP reply text never carries our own credential', () => {
  /**
   * The review's F7. The client redacts *our* command from the error message but
   * copied the server's `reply.lines` in verbatim — and relays routinely echo the
   * offending command, e.g. `501 Syntax error in "AUTH PLAIN AGFkbWluAHNlY3JldA=="`.
   * That string became `SendResult.error` and landed in
   * `affiliate_email_deliveries.error`, in `console.warn`, and on the operator's
   * terminal. A misconfigured or hostile relay wrote our SMTP password into the
   * application database.
   *
   * The fake relay below is that relay, minimally.
   */
  it('drops the reply text from a failed AUTH exchange', async () => {
    const password = 'relay-password-not-in-any-log';
    const user = 'relay-user';
    const credential = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');

    const relay = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 hostile.test ESMTP ready\r\n');
      socket.on('error', () => undefined);
      socket.on('data', (chunk: string) => {
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          if (line.startsWith('EHLO') || line.startsWith('HELO')) {
            socket.write('250-hostile.test\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (line.startsWith('AUTH')) {
            // The whole finding, in one line: the server quotes our command back.
            socket.write(`501 Syntax error in "${line}"\r\n`);
          } else {
            socket.write('221 Bye\r\n');
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const port = (relay.address() as AddressInfo).port;

    try {
      const settings: SmtpSettings = {
        host: '127.0.0.1',
        port,
        user,
        password,
        from: 'Partners <partners@example.test>',
        fromAddress: 'partners@example.test',
        implicitTls: false,
        // The fake relay speaks no TLS; the client refuses a cleartext AUTH
        // otherwise, and that refusal has its own test elsewhere.
        allowInsecure: true,
      };

      const result = await sendMail(settings, {
        to: 'alice@example.com',
        subject: 'Set your password',
        text: 'hello',
        html: '<p>hello</p>',
      });

      assert.equal(result.ok, false);
      const error = result.error ?? '';
      assert.ok(
        !error.includes(credential),
        'the base64 AUTH credential must never reach an error message',
      );
      assert.ok(!error.includes(password), 'nor the password in any other form');
      assert.ok(!error.includes(user), 'nor the account it belongs to');
      // Still diagnostic: an operator needs to know which step failed and why.
      assert.match(error, /501/);
      assert.match(error, /AUTH PLAIN/);
    } finally {
      relay.close();
    }
  });
});

/* ------------------------------------------------------------------- F9 */

describe('F9: a sort parameter is a 400, never a 500', () => {
  let portalCookie = '';

  before(async () => {
    resetPortalThrottles();
    resetScryptPool();
    const login = await post('/portal/api/auth/login', {
      email: 'alice@example.com',
      password: ALICE_PASSWORD,
    });
    assert.equal(login.status, 200);
    portalCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  const getPortal = (path: string): Promise<Response> =>
    fetch(`${origin}${path}`, { headers: { cookie: portalCookie } });

  /**
   * Measured by the review: `sort=affiliateName` maps to `a.name`, a column the
   * portal's payout query has no join for, and `sort=constructor` resolves
   * through `Object.prototype` past a `??` that looked like an allowlist guard.
   * Both threw, both were 500s, and both are reachable by any affiliate editing
   * a query string. Availability only — the interpolated text is always one of
   * our own literals — but a 500 anyone can trigger at will is still a 500.
   */
  it('answers 400 for a sort the affiliate payout list does not have', async () => {
    assert.equal((await getPortal('/portal/api/payouts?sort=amount')).status, 200);
    assert.equal((await getPortal('/portal/api/payouts?sort=affiliateName')).status, 400);
    assert.equal((await getPortal('/portal/api/payouts?sort=constructor')).status, 400);
    assert.equal((await getPortal('/portal/api/payouts?sort=__proto__')).status, 400);
  });

  /**
   * The same inherited-key hole in the three admin lists that share the shape.
   * These fall back to their default ordering rather than 400ing, because
   * unlike the payout list they have always silently defaulted and changing
   * that is a behaviour change nothing asked for — the finding is the 500.
   */
  it('does not throw on an inherited key in any admin list', async () => {
    for (const path of [
      '/api/affiliates?sort=constructor',
      '/api/customers?sort=constructor',
      '/api/reviews?sort=constructor',
      '/api/affiliates?sort=__proto__',
    ]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 200, `${path} should not throw`);
    }
  });
});

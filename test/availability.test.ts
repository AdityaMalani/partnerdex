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
import { createApp } from '../src/server/index.js';
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

let server: Server;
let origin: string;
let db: Db;

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
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One throwaway request first. The timing assertions below are about the
  // event loop, not about Node's first-request warm-up, which costs a couple of
  // hundred milliseconds on a cold process and would otherwise be measured.
  await fetch(`${origin}/health`).catch(() => undefined);
});

after(() => {
  server.close();
  resetBigquerySyncJob();
});

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

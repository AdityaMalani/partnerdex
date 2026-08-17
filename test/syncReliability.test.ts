import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetEnvironment } from './helpers.js';
import { paginate, PartnerApiError } from '../src/partner/client.js';
import type { PartnerOrg } from '../src/config.js';
import { runInWorker } from '../src/sync/fork.js';
import {
  resetSyncScheduler,
  runSyncNow,
  setSyncRunner,
  stallReason,
  syncStatus,
  type RunClock,
} from '../src/sync/scheduler.js';
import type { SyncResult } from '../src/sync/index.js';

const EMPTY = {} as SyncResult;

/**
 * A Partner API that misbehaves on demand.
 *
 * The real one cannot be asked to hang, so the three failures that actually
 * stalled production are staged here: a socket that is accepted and never
 * answered, a 429 that asks for a quarter of an hour, and a connection that
 * paginates in place.
 */
function fakePartnerApi(handler: (respond: Respond) => void): Promise<{
  org: PartnerOrg;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_request, response) => handler(response as Respond));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        org: {
          label: 'acme',
          organizationId: '1',
          endpoint: `http://127.0.0.1:${port}/`,
          token: 'token',
        } as PartnerOrg,
        close: () =>
          new Promise((done) => {
            // The parked-socket case leaves connections open by design, and
            // `close` alone waits for them forever.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

type Respond = {
  writeHead(status: number, headers?: Record<string, string>): Respond;
  end(body?: string): void;
};

function connectionPage(cursor: string, hasNextPage: boolean): string {
  return JSON.stringify({
    data: {
      transactions: {
        pageInfo: { hasNextPage },
        edges: [{ cursor, node: { id: 'txn', createdAt: '2024-11-26T00:00:00Z' } }],
      },
    },
  });
}

async function drain(org: PartnerOrg, limit = 50): Promise<number> {
  let pages = 0;
  for await (const _page of paginate(
    org,
    'query { transactions }',
    {},
    (data: any) => data?.transactions,
  )) {
    pages += 1;
    if (pages > limit) throw new Error('paginate looped past the limit without stopping');
  }
  return pages;
}

describe('a pass that cannot finish must still end', () => {
  beforeEach(() => {
    resetEnvironment();
    resetSyncScheduler();
  });
  afterEach(() => resetSyncScheduler());

  it('ends the pass when an external call is accepted and never answered', async () => {
    // Held so the sockets are not garbage before the client gives up on them.
    const parked: Respond[] = [];
    const api = await fakePartnerApi((respond) => {
      parked.push(respond);
    });
    process.env.PARTNER_REQUEST_TIMEOUT_MS = '80';
    process.env.PARTNER_RETRY_BACKOFF_MS = '5';

    const began = Date.now();
    await assert.rejects(() => drain(api.org), /Network error calling the Partner API/);
    // Bounded, and bounded by the timeout rather than by the test's patience.
    assert.ok(Date.now() - began < 20_000, 'six bounded attempts, not one unbounded wait');

    await api.close();
  });

  it('does not let a Retry-After header park the pass indefinitely', async () => {
    let requests = 0;
    const api = await fakePartnerApi((respond) => {
      requests += 1;
      // Fifteen minutes, which is what an unbounded client would sleep for. Five
      // of them is an hour and a quarter of a sync that has not failed and has
      // not progressed.
      respond.writeHead(429, { 'retry-after': '900' }).end('{}');
    });
    process.env.PARTNER_MAX_RETRY_AFTER_MS = '30';
    process.env.PARTNER_RETRY_BACKOFF_MS = '5';

    const began = Date.now();
    await assert.rejects(() => drain(api.org), /returned 429 after/);
    assert.ok(Date.now() - began < 10_000, 'the cap, not the header, decides how long we wait');
    assert.ok(requests > 1, 'it still retried');

    await api.close();
  });

  it('refuses to paginate in place when the cursor stops moving', async () => {
    let requests = 0;
    const api = await fakePartnerApi((respond) => {
      requests += 1;
      // Always another page, always the same cursor: an infinite loop that
      // reports no error, banks no rows and never advances a watermark.
      respond.writeHead(200, { 'content-type': 'application/json' }).end(
        connectionPage('cursor-1', true),
      );
    });

    await assert.rejects(() => drain(api.org), (error: unknown) => {
      assert.ok(error instanceof PartnerApiError);
      assert.match(error.message, /paginated in place/);
      return true;
    });
    assert.ok(requests <= 3, `stopped after ${requests} request(s) rather than looping`);

    await api.close();
  });

  it('walks a well-behaved connection to the end regardless', async () => {
    let page = 0;
    const api = await fakePartnerApi((respond) => {
      page += 1;
      respond
        .writeHead(200, { 'content-type': 'application/json' })
        .end(connectionPage(`cursor-${page}`, page < 3));
    });

    assert.equal(await drain(api.org), 3);
    await api.close();
  });
});

describe('the watchdog', () => {
  beforeEach(() => {
    resetEnvironment();
    resetSyncScheduler();
  });
  afterEach(() => resetSyncScheduler());

  it('fires on a worker that has gone quiet', () => {
    const now = Date.now();
    const clock: RunClock = {
      startedAt: now - 40 * 60_000,
      lastUpdateAt: now - 35 * 60_000,
      lastProgressAt: now - 35 * 60_000,
      phase: 'transactions',
      org: 'acme',
    };
    assert.match(stallReason(clock, now) ?? '', /transactions\/acme.*no sign of life/s);
  });

  it('fires on a worker that is alive but making no progress', () => {
    const now = Date.now();
    // Heartbeating every thirty seconds, and stuck for forty minutes. A liveness
    // probe would call this healthy; it is the case the watchdog exists for.
    const clock: RunClock = {
      startedAt: now - 45 * 60_000,
      lastUpdateAt: now - 30_000,
      lastProgressAt: now - 40 * 60_000,
      phase: 'listing',
      org: null,
    };
    assert.match(stallReason(clock, now) ?? '', /alive but no progress/);
  });

  it('does not fire on work that is merely slow', () => {
    const now = Date.now();
    // Four hours into a first backfill, banking a page a few seconds ago. The
    // idle clock is what is checked, so a long run is never the reason.
    const clock: RunClock = {
      startedAt: now - 4 * 3_600_000,
      lastUpdateAt: now - 2_000,
      lastProgressAt: now - 5_000,
      phase: 'transactions',
      org: 'acme',
    };
    assert.equal(stallReason(clock, now), null);
  });

  it('still catches a run that is busy going nowhere', () => {
    const now = Date.now();
    const clock: RunClock = {
      startedAt: now - 7 * 3_600_000,
      lastUpdateAt: now - 1_000,
      lastProgressAt: now - 1_000,
      phase: 'transactions',
      org: 'acme',
    };
    assert.match(stallReason(clock, now) ?? '', /ceiling/);
  });

  it('kills a forked worker that never finishes, and the next run still starts', async () => {
    const hanging = fileURLToPath(new URL('./fixtures/hangingWorker.ts', import.meta.url));
    const quick = fileURLToPath(new URL('./fixtures/quickWorker.ts', import.meta.url));

    let updates = 0;
    await assert.rejects(
      () =>
        runInWorker(hanging, [], {
          /*
           * The stall condition is the worker's own progress, not a stopwatch.
           * It used to be `Date.now() - began > 300`, which raced a fixed
           * deadline against however long a forked tsx process takes to boot;
           * on a loaded machine the kill landed before the worker had said
           * anything and the assertion below failed with `updates` at zero,
           * about one run in twelve.
           *
           * "It has reported once and is still running" *is* the stall this
           * watchdog exists to catch — the fixture reports and then parks on a
           * timer forever — so keying on the report rather than the clock tests
           * the same property without a number in it.
           */
          onUpdate: () => {
            updates += 1;
          },
          watchdog: {
            isStalled: () => (updates > 0 ? 'sync stalled: no progress' : null),
            intervalMs: 25,
            graceMs: 50,
          },
        }),
      /stalled/,
    );
    assert.equal(updates, 1, 'the update it did send did not settle the run');

    // The thing the old code could not do: start another one.
    const result = await runInWorker<{ transactions: number }>(quick);
    assert.equal(result.transactions, 1);
  });

  it('records a killed pass and lets the loop carry on', async () => {
    setSyncRunner(async () => {
      throw new Error('sync stalled in transactions/acme: alive but no progress for 31m.');
    });
    await runSyncNow();

    const stalled = syncStatus();
    assert.equal(stalled.running, false, 'the overlap guard released');
    assert.equal(stalled.consecutiveFailures, 1);
    assert.match(stalled.lastError ?? '', /stalled in transactions\/acme/);

    // And the next pass runs rather than joining a run that never ended.
    let ran = 0;
    setSyncRunner(async () => {
      ran += 1;
      return EMPTY;
    });
    await runSyncNow();
    assert.equal(ran, 1);
    assert.equal(syncStatus().consecutiveFailures, 0);
  });
});

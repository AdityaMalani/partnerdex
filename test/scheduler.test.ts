import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetEnvironment } from './helpers.js';
import { partnerQuery } from '../src/partner/client.js';
import {
  backoffDelayMs,
  onSyncComplete,
  resetSyncScheduler,
  runSyncNow,
  setSyncRunner,
  syncStatus,
  type SyncOutcome,
} from '../src/sync/scheduler.js';
import type { SyncResult } from '../src/sync/index.js';

const EMPTY: SyncResult = {
  apps: [],
  transactions: 0,
  events: 0,
  subscriptions: 0,
  installs: 0,
  customerEvents: 0,
};

/** A runner whose completion the test controls. */
function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const run = async (): Promise<SyncResult> => {
    calls += 1;
    await gate;
    return EMPTY;
  };
  return { run, release, get calls() { return calls; } };
}

describe('background sync loop', () => {
  beforeEach(() => {
    resetEnvironment();
    resetSyncScheduler();
  });
  afterEach(() => resetSyncScheduler());

  it('never runs two syncs at once', async () => {
    const runner = deferred();
    setSyncRunner(runner.run);

    // A second caller arriving mid-run joins the first rather than starting
    // another pass over the same watermarks.
    const first = runSyncNow();
    const second = runSyncNow();
    assert.equal(runner.calls, 1);
    assert.equal(syncStatus().running, true);

    runner.release();
    await Promise.all([first, second]);
    assert.equal(runner.calls, 1);
    assert.equal(syncStatus().running, false);
  });

  it('starts a fresh run once the previous one has finished', async () => {
    let calls = 0;
    setSyncRunner(async () => {
      calls += 1;
      return EMPTY;
    });

    await runSyncNow();
    await runSyncNow();
    assert.equal(calls, 2);
  });

  it('records a failure without leaving the loop wedged', async () => {
    setSyncRunner(async () => {
      throw new Error('Partner API token was revoked');
    });

    const outcome = await runSyncNow();
    assert.equal(outcome.result, null);
    assert.match(outcome.error?.message ?? '', /revoked/);

    const status = syncStatus();
    assert.equal(status.running, false);
    assert.equal(status.consecutiveFailures, 1);
    assert.match(status.lastError ?? '', /revoked/);
    assert.equal(status.lastSuccessAt, null);
  });

  it('clears the failure streak on the next success', async () => {
    setSyncRunner(async () => {
      throw new Error('network down');
    });
    await runSyncNow();
    await runSyncNow();
    assert.equal(syncStatus().consecutiveFailures, 2);

    setSyncRunner(async () => EMPTY);
    await runSyncNow();

    const status = syncStatus();
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.lastError, null);
    assert.ok(status.lastSuccessAt);
  });

  it('backs off geometrically while failing and caps the wait', () => {
    assert.equal(backoffDelayMs(5, 0), 5 * 60_000);
    assert.equal(backoffDelayMs(5, 1), 10 * 60_000);
    assert.equal(backoffDelayMs(5, 2), 20 * 60_000);
    // Capped, so an instance still recovers unattended once the cause is fixed.
    assert.equal(backoffDelayMs(5, 3), 30 * 60_000);
    assert.equal(backoffDelayMs(5, 99), 30 * 60_000);
  });

  it('hands every outcome to subscribers', async () => {
    const seen: SyncOutcome[] = [];
    const unsubscribe = onSyncComplete((outcome) => seen.push(outcome));

    setSyncRunner(async () => ({ ...EMPTY, transactions: 3 }));
    await runSyncNow();

    setSyncRunner(async () => {
      throw new Error('boom');
    });
    await runSyncNow();

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.result?.transactions, 3);
    assert.equal(seen[1]?.error?.message, 'boom');

    unsubscribe();
    setSyncRunner(async () => EMPTY);
    await runSyncNow();
    assert.equal(seen.length, 2);
  });

  it('survives a subscriber that throws', async () => {
    onSyncComplete(() => {
      throw new Error('slack webhook exploded');
    });
    setSyncRunner(async () => EMPTY);

    const outcome = await runSyncNow();
    assert.equal(outcome.error, null);
    assert.equal(syncStatus().consecutiveFailures, 0);
  });
});

describe('the Partner API client cannot be parked by a dead connection', () => {
  /*
   * Regression from a real incident. A request the server accepts and never
   * answers used to hang `await fetch` indefinitely: the retry loop handles
   * errors and bad statuses, and a request that never settles is neither. A
   * production backfill sat for over an hour with its cursor parked
   * mid-pagination, no rows written and no error — and the sync's overlap guard
   * meant no later run could start either.
   */
  it('gives up on a request that never answers, and retries it', async () => {
    const original = globalThis.fetch;
    let attempts = 0;

    // Never resolves on its own; only the caller's abort signal ends it. That is
    // the shape of the failure — not an error, just silence.
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      attempts += 1;
      if (attempts > 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })),
        );
      });
    }) as typeof fetch;

    try {
      const org = {
        organizationId: '1',
        token: 't',
        label: 'test',
        apiVersion: '2026-07',
        endpoint: 'https://partners.example/api/graphql.json',
      };
      // A short timeout keeps the test quick; the property under test is that a
      // hang aborts and is retried at all, not the production duration.
      process.env.PARTNER_REQUEST_TIMEOUT_MS = '150';
      const promise = partnerQuery(org, '{ ok }', {});
      const settled = await Promise.race([
        promise.then(() => 'resolved' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 8000)),
      ]);

      assert.equal(settled, 'resolved', 'a hung request must abort and be retried, not park');
      assert.ok(attempts >= 2, 'the hung attempt should have been retried');
    } finally {
      globalThis.fetch = original;
      delete process.env.PARTNER_REQUEST_TIMEOUT_MS;
    }
  });
});

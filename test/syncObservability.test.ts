import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetEnvironment } from './helpers.js';
import {
  formatPhaseEvent,
  SyncReporter,
  type PhaseEvent,
} from '../src/sync/progress.js';
import {
  resetSyncScheduler,
  runSyncNow,
  setSyncRunner,
  syncStatus,
} from '../src/sync/scheduler.js';
import type { SyncResult } from '../src/sync/index.js';

const EMPTY = {} as SyncResult;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('a sync that says what it is doing', () => {
  beforeEach(() => {
    resetEnvironment();
    resetSyncScheduler();
  });
  afterEach(() => resetSyncScheduler());

  it('reports the two ends of a phase, with its counts and its duration', async () => {
    const seen: PhaseEvent[] = [];
    const reporter = new SyncReporter({ onPhase: (event) => seen.push(event) }, 0);

    await reporter.phase(
      'transactions',
      'acme',
      async () => {
        await sleep(5);
        return 42;
      },
      (rows) => ({ rows }),
    );
    reporter.close();

    assert.deepEqual(
      seen.map((event) => event.state),
      ['start', 'end'],
    );
    assert.equal(seen[1]?.phase, 'transactions');
    assert.equal(seen[1]?.org, 'acme');
    assert.deepEqual(seen[1]?.counts, { rows: 42 });
    assert.ok((seen[1]?.elapsedMs ?? 0) >= 4, 'the end carries how long the phase took');
  });

  it('keeps saying it is there while a long phase is in flight', async () => {
    const seen: PhaseEvent[] = [];
    // A heartbeat every 10ms stands in for the production half minute.
    const reporter = new SyncReporter({ onPhase: (event) => seen.push(event) }, 10);

    await reporter.phase('listing', null, async () => {
      reporter.progress('  listing events: 1000 rows');
      await sleep(60);
    });
    reporter.close();

    const beats = seen.filter((event) => event.state === 'heartbeat');
    assert.ok(beats.length >= 2, `expected repeated heartbeats, saw ${beats.length}`);
    // The heartbeat carries the newest detail line, which is how "working"
    // is told apart from "hung" without printing a line per page.
    assert.equal(beats.at(-1)?.message, '  listing events: 1000 rows');
    assert.ok((beats.at(-1)?.elapsedMs ?? 0) > 0);
  });

  it('measures idleness from real progress, never from its own heartbeat', async () => {
    const seen: PhaseEvent[] = [];
    const reporter = new SyncReporter({ onPhase: (event) => seen.push(event) }, 10);

    await reporter.phase('transactions', 'acme', async () => {
      await sleep(60);
    });
    reporter.close();

    const beats = seen.filter((event) => event.state === 'heartbeat');
    // A process parked on a socket that will never answer still turns its event
    // loop, so a heartbeat proves nothing about progress and must not reset the
    // clock a stall is measured against.
    assert.ok((beats.at(-1)?.idleMs ?? 0) >= 40, 'idle time keeps growing through heartbeats');
  });

  it('does not print a line per page of results', async () => {
    const lines: string[] = [];
    const reporter = new SyncReporter({ onPhase: (event) => lines.push(formatPhaseEvent(event)) }, 0);

    await reporter.phase('transactions', 'acme', async () => {
      for (let page = 0; page < 5_000; page += 1) reporter.progress(`  transactions: ${page} rows`);
    });
    reporter.close();

    assert.equal(lines.length, 2, 'five thousand pages, two lines of log');
  });

  it('surfaces the phase, when it started and the last message through syncStatus', async () => {
    setSyncRunner(async (observer) => {
      observer.onPhase({
        phase: 'transactions',
        org: 'acme',
        state: 'start',
        startedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 0,
        idleMs: 0,
      });
      observer.onPhase({
        phase: 'transactions',
        org: 'acme',
        state: 'heartbeat',
        startedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 30_000,
        idleMs: 1_000,
        message: '  transactions: 8000 rows',
      });

      const mid = syncStatus();
      assert.equal(mid.phase, 'transactions');
      assert.equal(mid.phaseOrg, 'acme');
      assert.equal(mid.phaseStartedAt, '2026-01-01T00:00:00.000Z');
      assert.equal(mid.lastMessage, '  transactions: 8000 rows');
      return EMPTY;
    });

    await runSyncNow();

    // Cleared when the run ends: a phase left standing would read as a sync
    // still in flight long after it finished.
    assert.equal(syncStatus().phase, null);
    assert.ok((syncStatus().lastDurationMs ?? -1) >= 0);
  });

  it('records which phase and which organization a failure came from', async () => {
    setSyncRunner(async (observer) => {
      observer.onPhase({
        phase: 'events',
        org: 'northwind',
        state: 'error',
        startedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 1_200,
        idleMs: 0,
        error: 'Partner API rejected the token',
      });
      throw new Error('1 of 2 organization(s) failed to sync');
    });

    await runSyncNow();

    const status = syncStatus();
    assert.equal(status.lastErrorPhase, 'events');
    assert.equal(status.lastErrorOrg, 'northwind');
    assert.ok(status.lastErrorAt);
    assert.match(status.lastError ?? '', /failed to sync/);
  });

  it('clears the recorded failure site on the next clean pass', async () => {
    setSyncRunner(async (observer) => {
      observer.onPhase({
        phase: 'listing',
        org: null,
        state: 'error',
        startedAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 10,
        idleMs: 0,
        error: 'BigQuery refused the job',
      });
      throw new Error('BigQuery refused the job');
    });
    await runSyncNow();
    assert.equal(syncStatus().lastErrorPhase, 'listing');

    setSyncRunner(async () => EMPTY);
    await runSyncNow();
    assert.equal(syncStatus().lastErrorPhase, null);
    assert.equal(syncStatus().lastErrorOrg, null);
  });
});

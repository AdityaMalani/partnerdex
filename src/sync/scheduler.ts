import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { runInWorker, workerEntry } from './fork.js';
import { type SyncResult } from './index.js';

/**
 * The background sync loop.
 *
 * A chained timer rather than `setInterval`: the next run is scheduled only
 * once the current one has finished. Two syncs running at once would advance
 * the same watermarks and rebuild the derived tables underneath each other, and
 * a sync that outlives its interval must delay the next tick, not stack against
 * it.
 */

/** Wait this long after boot before the first run, so the HTTP port is up. */
const START_DELAY_MS = 2_000;

/** However bad things get, keep retrying at least this often. */
const MAX_BACKOFF_MS = 30 * 60_000;

export interface SyncOutcome {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Present when the run succeeded. */
  result: SyncResult | null;
  /** Present when it did not. */
  error: Error | null;
}

/**
 * Called after every run, successful or not.
 *
 * This is the seam a notifier hangs off: a Slack integration subscribes here
 * and reads the run's result rather than polling the store on its own clock.
 */
export type SyncListener = (outcome: SyncOutcome) => void;

export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
}

const state: SyncStatus = {
  enabled: false,
  intervalMinutes: 0,
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextRunAt: null,
};

const listeners = new Set<SyncListener>();

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<SyncOutcome> | null = null;
let started = false;
let runner: () => Promise<SyncResult> = () => runSyncInWorker();

/**
 * Run one sync in a child process and resolve with its result.
 *
 * The sync is synchronous SQLite work from the moment the Partner API pages
 * land, and `rebuildDerivedTables` is a single multi-second block. Running it
 * in-process stops the server answering anything at all — see `worker.ts` for
 * why it has to be somewhere else, and `fork.ts` for why that somewhere is a
 * child process rather than a worker thread.
 *
 * A child per run, rather than one long-lived child: runs are minutes apart, so
 * startup is a rounding error against the sync itself, and an exited process
 * cannot leak a SQLite handle or a half-applied write into the next run.
 */
function runSyncInWorker(): Promise<SyncResult> {
  return runInWorker<SyncResult>(workerEntry(import.meta.url, 'worker'));
}

/** Test seam: drive the loop with something other than a live Partner API. */
export function setSyncRunner(next: (() => Promise<SyncResult>) | null): void {
  runner = next ?? (() => runSyncInWorker());
}

export function onSyncComplete(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function syncStatus(): SyncStatus {
  return { ...state };
}

/**
 * How long to wait before the next attempt. Failures back off geometrically so
 * a revoked token stops hammering the Partner API 288 times a day, but the
 * ceiling keeps an unattended instance recovering on its own once the cause is
 * fixed.
 */
export function backoffDelayMs(intervalMinutes: number, consecutiveFailures: number): number {
  const base = intervalMinutes * 60_000;
  if (consecutiveFailures <= 0) return base;
  return Math.min(base * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
}

function emit(outcome: SyncOutcome): void {
  for (const listener of listeners) {
    try {
      listener(outcome);
    } catch (cause) {
      // A broken notifier is not allowed to break the sync loop.
      console.error('[partnerdex] sync listener threw:', cause);
    }
  }
}

async function execute(): Promise<SyncOutcome> {
  const began = Date.now();
  const startedAt = new Date(began).toISOString();
  state.running = true;
  state.lastStartedAt = startedAt;

  let outcome: SyncOutcome;
  try {
    const result = await runner();
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    outcome = {
      startedAt,
      finishedAt: state.lastSuccessAt,
      durationMs: Date.now() - began,
      result,
      error: null,
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    state.lastError = error.message;
    state.consecutiveFailures += 1;
    outcome = {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - began,
      result: null,
      error,
    };
  } finally {
    state.running = false;
    inFlight = null;
  }

  emit(outcome);
  return outcome;
}

/**
 * Run a sync now, or join the one already running. Never starts a second.
 */
export function runSyncNow(): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  inFlight = execute();
  return inFlight;
}

function scheduleIn(delayMs: number): void {
  if (timer) clearTimeout(timer);
  state.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  timer = setTimeout(tick, delayMs);
  // The loop must never be the reason the process refuses to exit.
  timer.unref?.();
}

async function tick(): Promise<void> {
  const outcome = await runSyncNow();

  if (outcome.error) {
    console.error(`[partnerdex] sync failed: ${outcome.error.message}`);
  } else if (outcome.result) {
    const { transactions, events, subscriptions } = outcome.result;
    console.log(
      `[partnerdex] synced in ${Math.round(outcome.durationMs / 1000)}s: ` +
        `${transactions} transaction(s), ${events} event(s), ${subscriptions} subscription(s).`,
    );
  }

  // Stopped while the run was in flight; do not resurrect the loop.
  if (!started) return;
  scheduleIn(backoffDelayMs(state.intervalMinutes, state.consecutiveFailures));
}

/**
 * Milliseconds since anything was last written to the store, or null when it
 * has never been synced.
 */
function msSinceLastSync(): number | null {
  try {
    const row = getDb().prepare('SELECT MAX(updated_at) AS at FROM sync_state').get() as
      | { at: string | null }
      | undefined;
    if (!row?.at) return null;
    const at = Date.parse(row.at);
    return Number.isFinite(at) ? Date.now() - at : null;
  } catch {
    return null;
  }
}

export function startSyncScheduler(): SyncStatus {
  const { runtime } = getConfig();

  if (runtime.syncIntervalMinutes <= 0) {
    state.enabled = false;
    return syncStatus();
  }
  if (started) return syncStatus();

  started = true;
  state.enabled = true;
  state.intervalMinutes = runtime.syncIntervalMinutes;

  /*
   * Resume the cadence rather than restarting it. `tsx watch` restarts the API
   * on every file save, and a boot-time sync would turn a morning of editing
   * into hundreds of Partner API passes.
   */
  const intervalMs = runtime.syncIntervalMinutes * 60_000;
  const since = msSinceLastSync();
  const due = since === null || since >= intervalMs;
  scheduleIn(due ? START_DELAY_MS : intervalMs - since);

  return syncStatus();
}

export function stopSyncScheduler(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  state.nextRunAt = null;
}

/** Test seam: forget every run this process has recorded. */
export function resetSyncScheduler(): void {
  stopSyncScheduler();
  listeners.clear();
  inFlight = null;
  runner = () => runSyncInWorker();
  Object.assign(state, {
    enabled: false,
    intervalMinutes: 0,
    running: false,
    lastStartedAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    nextRunAt: null,
  });
}

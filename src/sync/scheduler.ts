import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { runInWorker, workerEntry } from './fork.js';
import { type SyncResult } from './index.js';
import { type PhaseEvent } from './progress.js';

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
  /*
   * What the run in front of you is doing.
   *
   * `running: true` was the whole of the answer, which is the same answer for a
   * pass three seconds in and a pass that wedged forty minutes ago. These four
   * fields are what tell those apart, and they are the ones the dashboard footer
   * and `/api/status` now show.
   */
  /** The phase in flight, or null between runs. */
  phase: string | null;
  /** The organization that phase belongs to, where it belongs to one. */
  phaseOrg: string | null;
  phaseStartedAt: string | null;
  /** The newest detail line the run has produced, and when it produced it. */
  lastMessage: string | null;
  lastMessageAt: string | null;
  /** Where the last failure happened. `lastError` alone never said. */
  lastErrorPhase: string | null;
  lastErrorOrg: string | null;
  lastErrorAt: string | null;
  /** How long the last completed run took, successful or not. */
  lastDurationMs: number | null;
}

const BLANK: SyncStatus = {
  enabled: false,
  intervalMinutes: 0,
  running: false,
  lastStartedAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextRunAt: null,
  phase: null,
  phaseOrg: null,
  phaseStartedAt: null,
  lastMessage: null,
  lastMessageAt: null,
  lastErrorPhase: null,
  lastErrorOrg: null,
  lastErrorAt: null,
  lastDurationMs: null,
};

const state: SyncStatus = { ...BLANK };

/**
 * Fold one phase event into the status the API serves.
 *
 * Failures are remembered separately from the phase in flight, because the
 * phase clears when the run ends and the failure has to outlive it — "which
 * phase, which organization" is exactly what an operator reading `lastError`
 * after the fact wants and never had.
 */
function applyPhase(event: PhaseEvent): void {
  switch (event.state) {
    case 'start':
      state.phase = event.phase;
      state.phaseOrg = event.org;
      state.phaseStartedAt = event.startedAt;
      state.lastMessage = null;
      state.lastMessageAt = null;
      break;
    case 'heartbeat':
      state.phase = event.phase;
      state.phaseOrg = event.org;
      state.phaseStartedAt = event.startedAt;
      if (event.message) {
        state.lastMessage = event.message;
        state.lastMessageAt = new Date().toISOString();
      }
      break;
    case 'end':
      // Deliberately left standing. Phases nest — an org's pass encloses its
      // transactions — so clearing on the inner one's end would report "no
      // phase" while the outer is still working. The next `start` overwrites it
      // and the end of the run clears it.
      break;
    case 'error':
      state.lastErrorPhase = event.phase;
      state.lastErrorOrg = event.org;
      state.lastErrorAt = new Date().toISOString();
      break;
  }
}

const listeners = new Set<SyncListener>();

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<SyncOutcome> | null = null;
let started = false;
let runner: (observer: SyncRunObserver) => Promise<SyncResult> = (observer) =>
  runSyncInWorker(observer);

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
/**
 * How long a pass may make no progress at all before it is killed.
 *
 * Thirty minutes, and it is an **idle** ceiling rather than a total one — the
 * clock resets on every phase boundary and every page of results, so it cannot
 * fire during work that is merely slow, however long that work runs. A first
 * historical backfill takes hours and is never thirty minutes silent; it emits a
 * line per page.
 *
 * Thirty rather than five, because every individual step is now bounded and the
 * ceiling only has to sit above the slowest of them: a Partner request is capped
 * at two minutes and retried six times with capped backoff (about fifteen
 * minutes in the worst case, all of it a single silent step), a BigQuery job at
 * ten, an App Store page at one, and the derived rebuild is CPU-bound minutes.
 * Anything past thirty minutes of total silence is not slow work, it is a wedged
 * pass, and killing it costs nothing: cursors are written after every page, so
 * the next tick resumes from where this one stopped.
 */
export function stallTimeoutMs(): number {
  const raw = Number(process.env.SYNC_STALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
}

/**
 * An absolute ceiling on one pass, as a backstop under the idle one.
 *
 * Six hours. The idle ceiling catches a pass that has stopped; this catches one
 * that is *busy* going nowhere — a loop that keeps reporting progress it never
 * banks. Deliberately far above any legitimate run, including a first backfill,
 * because it is the cruder of the two instruments.
 */
export function maxDurationMs(): number {
  const raw = Number(process.env.SYNC_MAX_DURATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6 * 3_600_000;
}

/** Where a run had got to, as the parent understands it. */
export interface RunClock {
  startedAt: number;
  /** When the child last said anything at all, heartbeat included. */
  lastUpdateAt: number;
  /** When the child last made real progress: a phase boundary or a page. */
  lastProgressAt: number;
  phase: string | null;
  org: string | null;
}

function place(clock: RunClock): string {
  if (!clock.phase) return 'before its first phase';
  return `in ${clock.phase}${clock.org ? `/${clock.org}` : ''}`;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Whether a run has stopped being a run, and why — in words an operator can act
 * on rather than "sync failed".
 *
 * Two silences are checked, and they are not the same thing. A child that has
 * stopped *heartbeating* has a blocked event loop or is gone. A child that
 * heartbeats but reports no progress is alive and waiting on something that is
 * never going to answer. The second is what actually happens, and it is exactly
 * the case a liveness probe alone would call healthy.
 */
export function stallReason(
  clock: RunClock,
  now: number = Date.now(),
  limits: { stallMs?: number; maxMs?: number } = {},
): string | null {
  const stallMs = limits.stallMs ?? stallTimeoutMs();
  const maxMs = limits.maxMs ?? maxDurationMs();

  if (now - clock.lastUpdateAt > stallMs) {
    return (
      `sync stalled ${place(clock)}: the worker sent no sign of life for ` +
      `${minutes(now - clock.lastUpdateAt)}. Killed; the next run resumes from its cursors.`
    );
  }
  if (now - clock.lastProgressAt > stallMs) {
    return (
      `sync stalled ${place(clock)}: alive but no progress for ` +
      `${minutes(now - clock.lastProgressAt)}. Killed; the next run resumes from its cursors.`
    );
  }
  if (now - clock.startedAt > maxMs) {
    return (
      `sync exceeded its ${minutes(maxMs)} ceiling ${place(clock)}. ` +
      `Killed; the next run resumes from its cursors.`
    );
  }
  return null;
}

function runSyncInWorker(observer: SyncRunObserver): Promise<SyncResult> {
  const began = Date.now();
  const clock: RunClock = {
    startedAt: began,
    lastUpdateAt: began,
    lastProgressAt: began,
    phase: null,
    org: null,
  };

  return runInWorker<SyncResult>(workerEntry(import.meta.url, 'worker'), [], {
    onUpdate: (raw) => {
      const event = raw as PhaseEvent;
      const now = Date.now();
      clock.lastUpdateAt = now;
      clock.phase = event.phase;
      clock.org = event.org;
      /*
       * A heartbeat carries the child's own idle clock, and that is the number
       * that matters. The heartbeat itself proves only that the event loop is
       * turning, which a process parked on a socket that will never answer also
       * manages; taking its arrival as progress would make the watchdog
       * unable to fire on the one case it exists for.
       */
      clock.lastProgressAt =
        event.state === 'heartbeat' ? now - Math.max(0, event.idleMs ?? 0) : now;
      observer.onPhase(event);
    },
    watchdog: { isStalled: () => stallReason(clock) },
  });
}

/**
 * What the scheduler hands a runner so the run can report on itself.
 *
 * A runner that ignores it still works — every existing test seam does — but a
 * silent runner is exactly the thing this workstream exists to stop shipping.
 */
export interface SyncRunObserver {
  onPhase(event: PhaseEvent): void;
}

/** Test seam: drive the loop with something other than a live Partner API. */
export function setSyncRunner(
  next: ((observer: SyncRunObserver) => Promise<SyncResult>) | null,
): void {
  runner = next ?? runSyncInWorker;
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
  state.phase = null;
  state.phaseOrg = null;
  state.phaseStartedAt = null;
  state.lastMessage = null;
  state.lastMessageAt = null;

  let outcome: SyncOutcome;
  try {
    const result = await runner({ onPhase: applyPhase });
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
    state.lastErrorPhase = null;
    state.lastErrorOrg = null;
    state.lastErrorAt = null;
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
    state.lastDurationMs = Date.now() - began;
    state.phase = null;
    state.phaseOrg = null;
    state.phaseStartedAt = null;
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
    // The phase and the organization, not just the message. A failure used to
    // arrive as one sentence with no indication of where in a pass over several
    // organizations and half a dozen steps it came from.
    const where = state.lastErrorPhase
      ? ` in ${state.lastErrorPhase}${state.lastErrorOrg ? `/${state.lastErrorOrg}` : ''}`
      : '';
    console.error(
      `[partnerdex] sync failed${where} after ` +
        `${Math.round(outcome.durationMs / 1000)}s: ${outcome.error.message}`,
    );
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
  runner = (observer) => runSyncInWorker(observer);
  Object.assign(state, BLANK);
}

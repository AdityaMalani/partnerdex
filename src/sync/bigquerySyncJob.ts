import type { ListingSyncResult } from '../bigquery/ingest.js';
import { runInWorker, workerEntry } from './fork.js';

/**
 * The manual BigQuery ingest, as a job rather than a request.
 *
 * `POST /api/bigquery/sync` used to await the whole ingest on the request
 * thread. Two things were wrong with that and both are fixed here:
 *
 *   1. **It blocked.** The work is now forked (`bigqueryWorker.ts`), so the
 *      route returns as soon as the child is running and the event loop stays
 *      free for the health probe and every other reader.
 *   2. **Nothing deduped it.** Two clicks — or a click during a scheduled run —
 *      started two ingests advancing the same watermarks against the same
 *      single-writer database. The `running` guard below is the same shape as
 *      the scheduler's `inFlight`: a second start is refused, not queued, and
 *      the caller is told which run is already going.
 *
 * The state is deliberately in-process and forgotten on restart, exactly like
 * `syncStatus()`. It is progress reporting, not a ledger; the durable record of
 * what was ingested is the watermark in `sync_state` and the rows themselves.
 *
 * What this does NOT give: per-page progress. The child reports once, at the
 * end, because that is the whole protocol `fork.ts` speaks. `startedAt` plus
 * `running` is enough for the settings page to show a spinner and enough for an
 * operator to know a run is alive; streaming progress would mean an IPC channel
 * kept open and a message rate an attacker-triggered run could turn into work.
 */

export interface BigquerySyncJob {
  running: boolean;
  full: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** The last completed run's result, kept so a poll after the fact still answers. */
  result: ListingSyncResult | null;
  /** The last completed run's error message, if it failed. */
  error: string | null;
}

const state: BigquerySyncJob = {
  running: false,
  full: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

let inFlight: Promise<void> | null = null;

/** Test seam: run something other than a real forked BigQuery ingest. */
let runner: (full: boolean) => Promise<ListingSyncResult> = (full) =>
  runInWorker<ListingSyncResult>(
    workerEntry(import.meta.url, 'bigqueryWorker'),
    full ? ['--full'] : [],
  );

export function setBigquerySyncRunner(
  next: ((full: boolean) => Promise<ListingSyncResult>) | null,
): void {
  runner =
    next ??
    ((full) =>
      runInWorker<ListingSyncResult>(
        workerEntry(import.meta.url, 'bigqueryWorker'),
        full ? ['--full'] : [],
      ));
}

export function bigquerySyncJob(): BigquerySyncJob {
  return { ...state };
}

/**
 * Start an ingest, or report that one is already running.
 *
 * Returns immediately in both cases. `accepted: false` means a run was already
 * in flight — the route answers 409 with the job, so the caller can poll rather
 * than retry blindly.
 */
export function startBigquerySync(options: { full?: boolean } = {}): {
  accepted: boolean;
  job: BigquerySyncJob;
} {
  if (state.running) return { accepted: false, job: bigquerySyncJob() };

  const full = options.full === true;
  state.running = true;
  state.full = full;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.result = null;
  state.error = null;

  inFlight = runner(full)
    .then(
      (result) => {
        state.result = result;
        state.error = null;
      },
      (cause: unknown) => {
        state.result = null;
        state.error = cause instanceof Error ? cause.message : String(cause);
      },
    )
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
      inFlight = null;
    });

  return { accepted: true, job: bigquerySyncJob() };
}

/** Test seam: wait for the run in flight, if there is one. */
export function awaitBigquerySync(): Promise<void> {
  return inFlight ?? Promise.resolve();
}

/** Test seam: forget every run this process has recorded. */
export function resetBigquerySyncJob(): void {
  inFlight = null;
  setBigquerySyncRunner(null);
  Object.assign(state, {
    running: false,
    full: false,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  });
}

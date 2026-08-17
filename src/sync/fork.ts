import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Running a synchronous, long, SQLite-heavy job somewhere other than here.
 *
 * Extracted from `scheduler.ts` when the BigQuery ingest needed the same thing.
 * The reasoning is unchanged and is written out in `worker.ts`: better-sqlite3
 * is synchronous by design, so an ingest or a rebuild is one uninterrupted
 * block of JavaScript, and in-process that block is the whole server — health
 * probe included. The background loop has always forked for that reason. The
 * admin `POST /api/bigquery/sync` route did not, and the review recorded the
 * consequence: one click blocked the event loop for minutes, the Fly health
 * check failed, and the machine was pulled out of the load balancer.
 *
 * A child process rather than a worker thread, for the two reasons the
 * scheduler already had: it starts under both `tsx watch` and plain node with no
 * loader shim, and its peak footprint returns to the OS when it exits instead of
 * staying resident in the server's RSS.
 */

/**
 * Which file the child runs, which differs between the two ways this process is
 * started.
 *
 * Compiled, a module is `dist/sync/<name>.js` and its sibling is `<name>.js`.
 * Under `tsx watch` it is `src/sync/<name>.ts`; asking for `.js` there points at
 * a file that was never emitted and the run dies on `Cannot find module`.
 * Reading the *caller's* own extension keeps one code path correct in both,
 * rather than a NODE_ENV flag that dev and prod can disagree about.
 */
export function workerEntry(baseUrl: string, name: string): string {
  const sibling = baseUrl.endsWith('.ts') ? `./${name}.ts` : `./${name}.js`;
  return fileURLToPath(new URL(sibling, baseUrl));
}

/** What every worker in this directory sends back before it exits. */
export interface WorkerMessage<T> {
  ok: boolean;
  result?: T;
  message?: string;
  stack?: string;
}

/**
 * A message a worker sends *while* it is working.
 *
 * Tagged, because the parent used to treat the first message it received as the
 * run's result and settle on it. Anything a child wanted to say mid-run would
 * therefore have ended the run. The tag is what lets a worker narrate itself
 * without the parent mistaking the narration for an answer; an untagged message
 * is still the final report, which is what the BigQuery worker sends.
 */
export interface WorkerUpdate {
  kind: 'progress';
  event: unknown;
}

function isUpdate(message: unknown): message is WorkerUpdate {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { kind?: unknown }).kind === 'progress'
  );
}

export interface WorkerWatchdog {
  /**
   * Asked repeatedly while the child runs. Return a reason to kill it, or null
   * to let it carry on.
   *
   * The *policy* lives with the caller on purpose: only the scheduler knows what
   * counts as progress for a sync, and only the BigQuery job knows what counts
   * for an ingest. This module knows how to kill a process and settle a promise.
   */
  isStalled: () => string | null;
  /** How often to ask. */
  intervalMs?: number;
  /** How long a killed child gets to die politely before SIGKILL. */
  graceMs?: number;
}

export interface WorkerOptions {
  /** Called for each mid-run update the child sends. Never settles the run. */
  onUpdate?: (event: unknown) => void;
  watchdog?: WorkerWatchdog;
}

const WATCHDOG_INTERVAL_MS = 10_000;
const WATCHDOG_GRACE_MS = 10_000;

/**
 * Fork `entry`, wait for its single report, and resolve with it.
 *
 * Every terminal condition settles the promise exactly once — including the
 * child dying without reporting at all (an OOM kill, a native crash), because a
 * run that never settles is a job that stays "running" forever and blocks every
 * subsequent one.
 */
export function runInWorker<T>(
  entry: string,
  args: string[] = [],
  options: WorkerOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(entry, args);
    let settled = false;
    let poll: NodeJS.Timeout | null = null;

    /**
     * End the child, and mean it.
     *
     * SIGTERM first, because a worker that is merely slow gets to close its
     * database handle. SIGKILL after a grace period, because the case this is
     * built for — a process parked on a socket, or blocked inside a native
     * call — may never get far enough to notice the first signal. A parent that
     * settles its promise while the child lives on is how two syncs end up
     * writing the same watermarks.
     */
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const hard = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, options.watchdog?.graceMs ?? WATCHDOG_GRACE_MS);
      hard.unref?.();
    };

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      poll = null;
      act();
      stop();
    };

    if (options.watchdog) {
      const watchdog = options.watchdog;
      poll = setInterval(() => {
        const reason = watchdog.isStalled();
        if (reason) finish(() => reject(new Error(reason)));
      }, watchdog.intervalMs ?? WATCHDOG_INTERVAL_MS);
      poll.unref?.();
    }

    child.on('message', (message: WorkerMessage<T> | WorkerUpdate) => {
      if (isUpdate(message)) {
        try {
          options.onUpdate?.(message.event);
        } catch {
          // A parent that cannot read an update is not a reason to kill a run.
        }
        return;
      }
      finish(() => {
        if (message.ok && message.result !== undefined) {
          resolve(message.result);
          return;
        }
        const error = new Error(message.message ?? 'worker failed without a message');
        // An Error does not survive the IPC boundary with its stack intact, so
        // the parts worth keeping are sent as plain data and reassembled here.
        if (message.stack) error.stack = message.stack;
        reject(error);
      });
    });

    child.on('error', (cause) => finish(() => reject(cause)));

    child.on('exit', (code, signal) => {
      finish(() =>
        reject(new Error(`worker exited (code ${code}, signal ${signal}) before reporting a result`)),
      );
    });
  });
}

/**
 * The child half: report once, and only exit when the message has flushed.
 *
 * Exiting before the IPC write drains loses the result and turns a successful
 * run into "exited before reporting" in the parent.
 */
export function reportAndExit(payload: unknown): void {
  const send = process.send?.bind(process);
  if (!send) {
    /*
     * Started by hand rather than forked — which is a reasonable thing to do
     * when you want to watch one pass. There is nobody to report to, so the
     * report goes to stdout and the outcome goes into the exit status.
     *
     * It used to throw here. That was harmless until the workers began trapping
     * uncaught exceptions, at which point the trap called this, this threw, and
     * the throw re-entered the trap.
     */
    const ok = typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true;
    if (ok) console.log('[partnerdex:sync] done:', JSON.stringify(payload));
    else console.error('[partnerdex:sync] failed:', JSON.stringify(payload));
    process.exit(ok ? 0 : 1);
  }
  send(payload, () => process.exit(0));
}

/**
 * The child half of the update channel: say something without ending the run.
 *
 * Silently a no-op when the process was not forked, so the same worker module
 * can be run by hand for a one-off sync without special-casing it.
 */
export function reportUpdate(event: unknown): void {
  const send = process.send?.bind(process);
  if (!send) return;
  const update: WorkerUpdate = { kind: 'progress', event };
  try {
    send(update);
  } catch {
    // The parent has gone or the channel is closing. The run continues; it just
    // narrates to nobody.
  }
}

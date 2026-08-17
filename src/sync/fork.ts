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
 * Fork `entry`, wait for its single report, and resolve with it.
 *
 * Every terminal condition settles the promise exactly once — including the
 * child dying without reporting at all (an OOM kill, a native crash), because a
 * run that never settles is a job that stays "running" forever and blocks every
 * subsequent one.
 */
export function runInWorker<T>(entry: string, args: string[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = fork(entry, args);
    let settled = false;

    const finish = (act: () => void): void => {
      if (settled) return;
      settled = true;
      act();
      if (child.connected) child.kill();
    };

    child.on('message', (message: WorkerMessage<T>) => {
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
  if (!send) throw new Error('this module must be started as a forked child process');
  send(payload, () => process.exit(0));
}

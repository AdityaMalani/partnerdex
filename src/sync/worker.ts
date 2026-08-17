import { closeDb } from '../db/index.js';
import { reportAndExit, reportUpdate } from './fork.js';
import { runSync } from './index.js';
import { formatPhaseEvent, type PhaseEvent } from './progress.js';

/**
 * The sync, running off the request thread.
 *
 * better-sqlite3 is synchronous by design, so `rebuildDerivedTables` is one
 * uninterrupted block of JavaScript — on a real store it holds the event loop
 * for seconds. In-process that froze everything the server was meant to be
 * doing meanwhile, including `/api/health`, which is how a perfectly healthy
 * machine came to fail its platform health check on every sync.
 *
 * This runs as a forked child rather than a worker thread for two reasons. It
 * is the only one of the two that starts under both `tsx watch` and plain node
 * without a loader shim. And because the process exits after each run, its peak
 * footprint — most of the sync's ~200MB — returns to the OS between syncs
 * instead of staying resident in the server's RSS, which matters on a small
 * machine.
 *
 * WAL mode is what makes the shared database safe: this process is the single
 * writer, the server reads a committed snapshot, and the wholesale rebuild
 * stays invisible until it commits rather than exposing half-rebuilt tables.
 */

/*
 * What the operator sees, and why it is only this.
 *
 * The sync's detail callback fires once per page of results, which on a real
 * store is thousands of lines per pass — fine for a CLI someone is watching,
 * ruinous for a process that has been running every few minutes for months. So
 * the detail lines are not printed here at all. What is printed is the phase
 * boundaries, a heartbeat carrying the newest detail line while a phase is in
 * flight, and any failure with the phase and organization on it. That is a few
 * dozen lines for a healthy pass and, crucially, a line every half minute for
 * one that is stuck — which is the case this process used to report by saying
 * nothing whatsoever for fifty minutes.
 *
 * The same events go to the parent, which is where `/api/status` reads the
 * current phase from.
 */
function onPhase(event: PhaseEvent): void {
  const line = `[partnerdex:sync] ${formatPhaseEvent(event)}`;
  if (event.state === 'error') console.error(line);
  else console.log(line);
  reportUpdate(event);
}

/*
 * A rejection nothing awaited must still end the run.
 *
 * Node's default is to print and exit non-zero, which the parent does see — as
 * "worker exited before reporting a result", with no cause attached. Catching it
 * here turns the same event into a failure that names what actually happened,
 * and guarantees the parent is told rather than left inferring it from an exit
 * code.
 */
for (const signal of ['unhandledRejection', 'uncaughtException'] as const) {
  process.on(signal, (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    console.error(`[partnerdex:sync] ${signal}: ${error.message}`);
    try {
      closeDb();
    } catch {
      // Already closed, or never opened. Reporting matters more.
    }
    reportAndExit({ ok: false, message: `${signal}: ${error.message}`, stack: error.stack });
  });
}

runSync({ onPhase }).then(
  (result) => {
    closeDb();
    reportAndExit({ ok: true, result });
  },
  (cause: unknown) => {
    closeDb();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // An Error does not survive the IPC boundary with its stack intact, so the
    // parts worth keeping are sent as plain data and reassembled by the parent.
    reportAndExit({ ok: false, message: error.message, stack: error.stack });
  },
);

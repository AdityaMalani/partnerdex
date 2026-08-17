import { closeDb } from '../db/index.js';
import { reportAndExit } from './fork.js';
import { runSync } from './index.js';

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

runSync().then(
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

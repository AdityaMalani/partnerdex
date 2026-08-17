import { syncListingEvents } from '../bigquery/ingest.js';
import { closeDb, getDb } from '../db/index.js';
import { reportAndExit } from './fork.js';
import { resolveScopedAppIds } from './index.js';

/**
 * The BigQuery listing-event ingest, running off the request thread.
 *
 * This exists because `POST /api/bigquery/sync` used to run the whole thing
 * inline: up to 500 pages of 10,000 rows each, written through synchronous
 * `db.transaction` blocks, on the single thread that also answers
 * `/api/health`. It was hit in production — the event loop stalled for minutes,
 * the platform health check failed, and Fly took the machine out of the load
 * balancer. The background sync had already been forked for exactly this
 * reason; the manual route simply bypassed that decision.
 *
 * `--full` re-reads from the backfill floor, which is what a partner wants
 * immediately after fixing a dataset or a handle: the watermark left by the
 * broken configuration would otherwise skip everything it already walked past.
 *
 * As in `worker.ts`, this child is the single writer for the duration of its
 * run and the server reads a committed WAL snapshot meanwhile.
 */

const full = process.argv.includes('--full');

const db = getDb();

syncListingEvents(db, resolveScopedAppIds(db), { full }).then(
  (result) => {
    closeDb();
    reportAndExit({ ok: true, result });
  },
  (cause: unknown) => {
    closeDb();
    const error = cause instanceof Error ? cause : new Error(String(cause));
    reportAndExit({ ok: false, message: error.message, stack: error.stack });
  },
);

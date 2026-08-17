import { getConfig } from '../config.js';
import { getDb, readSyncState, writeSyncState, type Db } from '../db/index.js';
import { paginate, partnerQuery } from '../partner/client.js';
import {
  APP_EVENTS_QUERY,
  APP_QUERY,
  SALE_TRANSACTION_TYPES,
  SYNCED_EVENT_TYPES,
  TRANSACTIONS_QUERY,
} from '../partner/queries.js';
import { addDays, toUtcIso } from '../metrics/time.js';
import {
  insertAppEvents,
  insertTransactions,
  upsertApp,
  type AppEventNode,
  type TransactionNode,
} from './ingest.js';
import { rebuildDerivedTables } from './derive.js';
import { syncReviews, type ReviewSyncResult } from '../appstore/ingest.js';
import { syncListingEvents, type ListingSyncResult } from '../bigquery/ingest.js';
import { HEARTBEAT_INTERVAL_MS, SyncReporter, type PhaseEvent } from './progress.js';

/**
 * Transactions and events can be recorded slightly after they occur, so each
 * incremental run re-reads a short overlap behind the previous watermark.
 * Inserts are idempotent, so re-reading is free apart from bandwidth.
 */
const OVERLAP_DAYS = 3;

export interface SyncProgress {
  (message: string): void;
}

const noop: SyncProgress = () => {};

function windowStart(syncedThrough: string | null, syncStartDate: string): string {
  if (!syncedThrough) return toUtcIso(`${syncStartDate}T00:00:00Z`);
  return toUtcIso(addDays(new Date(syncedThrough), -OVERLAP_DAYS));
}

/**
 * Where one pass resumes: its stored cursor, but only if that cursor was made
 * for the window this pass is about to ask for.
 *
 * A Relay cursor is an opaque position inside the result set of the query that
 * produced it. Handed to a query with different arguments it does not mean
 * "the same place in the new window" — it means whatever the server decides,
 * and the honest reading of an offset-backed connection is "carry on with the
 * old walk". A pass that does that reads history it has no reason to read, at
 * the cost of the rows it was actually started for: reproduced against a fake
 * Partner API in `scripts/window-probe.ts`, where a cursor from a full-history
 * pass makes a three-day window walk tens of thousands of rows instead of
 * hundreds, and never reaches the newest ones.
 *
 * A cursor with no recorded window — every cursor written before the column
 * existed — counts as a mismatch. Re-walking one window once is the cheap
 * mistake; trusting a cursor whose provenance is unknown is the expensive one.
 */
function resumeCursor(state: { cursor: string | null; cursorWindow: string | null }, window: string): string | null {
  if (!state.cursor) return null;
  return state.cursorWindow === window ? state.cursor : null;
}

/**
 * The watermark a pass leaves behind: the newest row anyone has seen, never
 * older than what is already recorded.
 *
 * Two ways the old code could move it backwards, both of which put the sync
 * permanently behind its own data — the window is derived from this value, so
 * a watermark that regresses is re-read forever and a watermark that overshoots
 * skips rows that are never asked for again.
 *
 * The first is a pass that does not reach the newest row. It cannot: the rows
 * it saw are all it knows, and `max` over them is smaller than the recorded
 * mark. Seeding from the recorded mark rather than from the window makes the
 * comparison the right one.
 *
 * The second is a pass that returns no rows, which used to stamp the wall clock
 * — a watermark no row supports, and forward of the data rather than behind it.
 * On an install whose first pass finds nothing (a scope not yet configured, an
 * org whose token is not live yet) that writes "synced through now" over history
 * nobody has read, and everything before it minus the overlap is never fetched.
 * An empty pass learns nothing, so it now records nothing.
 */
function advanceWatermark(recorded: string | null, seen: string | null): string | null {
  if (!seen) return recorded;
  if (!recorded) return seen;
  return seen > recorded ? seen : recorded;
}

export interface SyncOptions {
  /** Ignore stored watermarks and re-read everything from SYNC_START_DATE. */
  full?: boolean;
  onProgress?: SyncProgress;
  /**
   * Phase transitions, heartbeats and failures.
   *
   * Separate from `onProgress` because the two have different audiences and
   * very different volumes: `onProgress` is a line per page of results, which
   * the CLI prints and a daemon must not, while this is a handful of lines per
   * run and is the only thing worth logging from a process that has been
   * running every few minutes for months.
   */
  onPhase?: (event: PhaseEvent) => void;
}

/**
 * The Partner API has no "list my apps" query, so scope is resolved from the
 * configured allowlist when present and otherwise from whichever apps have
 * appeared on a transaction. That also keeps app ids out of the codebase.
 */
/**
 * Variables for the transactions query.
 *
 * `appId` must be **absent** rather than null when reporting on every app: the
 * Partner API coerces an explicit null to an empty string and rejects it with
 * "Invalid GID ''". Omitting the key leaves the argument unprovided, which is
 * what actually means "no filter".
 */
export function transactionVariables(
  appId: string | null,
  createdAtMin: string,
  types: readonly string[],
): Record<string, unknown> {
  return {
    createdAtMin,
    types,
    ...(appId ? { appId: `gid://partners/App/${appId}` } : {}),
  };
}

export function resolveScopedAppIds(db: Db): string[] {
  const { scope } = getConfig();
  if (scope.appIds.length > 0) return scope.appIds;
  const rows = db.prepare('SELECT id FROM apps ORDER BY id').all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

async function syncTransactionsFor(
  db: Db,
  appId: string | null,
  options: SyncOptions,
  signal?: AbortSignal,
): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = appId ? `transactions:${appId}` : 'transactions:all';

  if (options.full) {
    writeSyncState(db, key, { cursor: null, cursorWindow: null, syncedThrough: null });
  }

  const state = readSyncState(db, key);
  const createdAtMin = windowStart(state.syncedThrough, scope.syncStartDate);

  let total = 0;
  // Seeded from the recorded watermark, not from the window, so a pass that
  // stops short of the newest row leaves the mark where it found it.
  let latest: string | null = null;

  const pages = paginate<TransactionNode>(
    TRANSACTIONS_QUERY,
    transactionVariables(appId, createdAtMin, SALE_TRANSACTION_TYPES),
    (data) => data?.transactions,
    resumeCursor(state, createdAtMin),
    { signal },
  );

  for await (const page of pages) {
    total += insertTransactions(db, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.createdAt);
      if (!latest || at > latest) latest = at;
    }
    // The window travels with the cursor, so the next pass can tell whether the
    // two still belong together.
    writeSyncState(db, key, { cursor: page.endCursor, cursorWindow: createdAtMin });
    onProgress(`  transactions: ${total} rows`);
  }

  // Cursor cleared only after a clean pass, so an interrupted run resumes.
  writeSyncState(db, key, {
    cursor: null,
    cursorWindow: null,
    syncedThrough: advanceWatermark(state.syncedThrough, latest),
  });
  return total;
}

async function syncEventsFor(
  db: Db,
  appId: string,
  options: SyncOptions,
  signal?: AbortSignal,
): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = `events:${appId}`;

  if (options.full) {
    writeSyncState(db, key, { cursor: null, cursorWindow: null, syncedThrough: null });
  }

  const state = readSyncState(db, key);
  const occurredAtMin = windowStart(state.syncedThrough, scope.syncStartDate);

  let total = 0;
  let latest: string | null = null;

  const pages = paginate<AppEventNode>(
    APP_EVENTS_QUERY,
    {
      appId: `gid://partners/App/${appId}`,
      occurredAtMin,
      types: SYNCED_EVENT_TYPES,
    },
    (data) => data?.app?.events,
    resumeCursor(state, occurredAtMin),
    { signal },
  );

  for await (const page of pages) {
    total += insertAppEvents(db, appId, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.occurredAt);
      if (!latest || at > latest) latest = at;
    }
    writeSyncState(db, key, { cursor: page.endCursor, cursorWindow: occurredAtMin });
    onProgress(`  events: ${total} rows`);
  }

  writeSyncState(db, key, {
    cursor: null,
    cursorWindow: null,
    syncedThrough: advanceWatermark(state.syncedThrough, latest),
  });
  return total;
}

/** Confirms an allowlisted app id exists and records its name locally. */
async function confirmApp(db: Db, appId: string, signal?: AbortSignal): Promise<boolean> {
  const data = await partnerQuery<{ app: { id: string; name: string; apiKey: string } | null }>(
    APP_QUERY,
    { appId: `gid://partners/App/${appId}` },
    { signal },
  );
  if (!data.app) return false;
  upsertApp(db, data.app);
  return true;
}

export interface SyncResult {
  apps: string[];
  transactions: number;
  events: number;
  subscriptions: number;
  installs: number;
  customerEvents: number;
  reviewEvents: number;
  reviews: ReviewSyncResult;
  listing: ListingSyncResult;
}

export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  // The heartbeat cadence is readable from the environment for the same reason
  // the timeouts are: so it can be turned down to watch a run without waiting
  // out half-minute silences, and up on an install that finds it chatty.
  const beat = Number(process.env.SYNC_HEARTBEAT_MS);
  const reporter = new SyncReporter(
    { onProgress: options.onProgress, onPhase: options.onPhase },
    Number.isFinite(beat) && beat > 0 ? beat : HEARTBEAT_INTERVAL_MS,
  );
  try {
    return await runSyncReported(options, reporter);
  } finally {
    reporter.close();
  }
}

async function runSyncReported(options: SyncOptions, reporter: SyncReporter): Promise<SyncResult> {
  const db = getDb();
  const { scope } = getConfig();

  /*
   * Every step below is handed the reporter's own callback rather than the
   * caller's, so a detail line updates the heartbeat's "how far has it got"
   * before it reaches whoever asked for it. The caller still sees each line
   * unchanged; it just no longer goes straight past the thing narrating the run.
   */
  const steps: SyncOptions = { full: options.full, onProgress: reporter.progressCallback() };
  const onProgress = steps.onProgress ?? noop;

  let transactions = 0;

  if (scope.appIds.length > 0) {
    onProgress(`Scope: ${scope.appIds.length} app(s) from PARTNER_APP_IDS.`);
    await reporter.phase(
      'scope',
      null,
      async () => {
        for (const appId of scope.appIds) {
          if (!(await confirmApp(db, appId))) {
            throw new Error(
              `App id ${appId} from PARTNER_APP_IDS was not found in this organization.`,
            );
          }
        }
        return scope.appIds;
      },
      (found) => ({ apps: found.length }),
    );
    for (const appId of scope.appIds) {
      onProgress(`Syncing transactions for app ${appId}...`);
      transactions += await reporter.phase(
        'transactions',
        null,
        () => syncTransactionsFor(db, appId, steps),
        (rows) => ({ rows }),
      );
    }
  } else {
    onProgress('Scope: every app with recorded transactions (PARTNER_APP_IDS is empty).');
    transactions += await reporter.phase(
      'transactions',
      null,
      () => syncTransactionsFor(db, null, steps),
      (rows) => ({ rows }),
    );
  }

  const appIds = resolveScopedAppIds(db);
  if (appIds.length === 0) {
    onProgress('No apps discovered. Set PARTNER_APP_IDS if your apps have no transactions yet.');
  }

  let events = 0;
  for (const appId of appIds) {
    onProgress(`Syncing events for app ${appId}...`);
    events += await reporter.phase(
      'events',
      null,
      () => syncEventsFor(db, appId, steps),
      (rows) => ({ rows }),
    );
  }

  // Before the rebuild, so a review that arrives this run is matched to a
  // customer and compiled onto their timeline in the same pass rather than
  // waiting out a sync.
  const reviews = await reporter.phase(
    'reviews',
    null,
    () => syncReviews(db, steps),
    (result) => ({ added: result.added, updated: result.updated, removed: result.removed }),
  );

  // The pre-install half of the funnel. Independent of everything above — it is
  // Google's data, not Shopify's — and quiet when BigQuery is not connected,
  // which is every install that has not filled in the settings page.
  const listing = await reporter.phase(
    'listing',
    null,
    () => syncListingEvents(db, appIds, steps),
    (result) => ({ rows: result.rows, apps: result.apps.length, skipped: result.skipped.length }),
  );
  if (listing.rows > 0) {
    onProgress(`Listing traffic: ${listing.rows} event(s) across ${listing.apps.length} app(s).`);
  }

  onProgress('Rebuilding derived subscription and install indexes...');
  const derived = await reporter.phase(
    'derive',
    null,
    async () => rebuildDerivedTables(db),
    (result) => ({
      subscriptions: result.subscriptions,
      installs: result.installs,
      customerEvents: result.customerEvents,
    }),
  );

  return { apps: appIds, transactions, events, reviews, listing, ...derived };
}

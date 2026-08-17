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

function windowStart(db: Db, key: string, syncStartDate: string): string {
  const { syncedThrough } = readSyncState(db, key);
  if (!syncedThrough) return toUtcIso(`${syncStartDate}T00:00:00Z`);
  return toUtcIso(addDays(new Date(syncedThrough), -OVERLAP_DAYS));
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

  if (options.full) writeSyncState(db, key, { cursor: null, syncedThrough: null });

  const createdAtMin = windowStart(db, key, scope.syncStartDate);
  const { cursor } = readSyncState(db, key);
  const startedAt = new Date().toISOString();

  let total = 0;
  let latest = createdAtMin;

  const pages = paginate<TransactionNode>(
    TRANSACTIONS_QUERY,
    transactionVariables(appId, createdAtMin, SALE_TRANSACTION_TYPES),
    (data) => data?.transactions,
    cursor,
    { signal },
  );

  for await (const page of pages) {
    total += insertTransactions(db, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.createdAt);
      if (at > latest) latest = at;
    }
    writeSyncState(db, key, { cursor: page.endCursor });
    onProgress(`  transactions: ${total} rows`);
  }

  // Cursor cleared only after a clean pass, so an interrupted run resumes.
  writeSyncState(db, key, { cursor: null, syncedThrough: total > 0 ? latest : startedAt });
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

  if (options.full) writeSyncState(db, key, { cursor: null, syncedThrough: null });

  const occurredAtMin = windowStart(db, key, scope.syncStartDate);
  const { cursor } = readSyncState(db, key);
  const startedAt = new Date().toISOString();

  let total = 0;
  let latest = occurredAtMin;

  const pages = paginate<AppEventNode>(
    APP_EVENTS_QUERY,
    {
      appId: `gid://partners/App/${appId}`,
      occurredAtMin,
      types: SYNCED_EVENT_TYPES,
    },
    (data) => data?.app?.events,
    cursor,
    { signal },
  );

  for await (const page of pages) {
    total += insertAppEvents(db, appId, page.nodes);
    for (const node of page.nodes) {
      const at = toUtcIso(node.occurredAt);
      if (at > latest) latest = at;
    }
    writeSyncState(db, key, { cursor: page.endCursor });
    onProgress(`  events: ${total} rows`);
  }

  writeSyncState(db, key, { cursor: null, syncedThrough: total > 0 ? latest : startedAt });
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

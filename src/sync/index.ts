import { getConfig, type PartnerOrg } from '../config.js';
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
import { warmCurrencyProfiles } from '../metrics/context.js';
import { warmDashboardMetrics } from '../metrics/registry.js';
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

/**
 * How long one organization may make no progress before the run moves on to the
 * next one.
 *
 * Organizations sync sequentially, which is fine while every one of them either
 * finishes or fails. It stops being fine the moment one of them does neither: a
 * pass that parks in the first organization means the second never runs *at
 * all* — not late, not partially, never — and no amount of per-organization
 * error handling helps, because a hang raises nothing to handle. A second
 * organization can sit configured and unsynced indefinitely on the strength of
 * the first one's dead socket.
 *
 * Fifteen minutes, and it is an idle clock: it resets on every page. No single
 * legitimate step comes near it — one Partner request is capped at two minutes
 * — so the only way to reach it is a chain of failures or a hang, and both are
 * better spent letting the next organization have its turn. It sits below the
 * pass-level watchdog on purpose, so the run gives up on one organization before
 * anything gives up on the whole run.
 */
function orgStallMs(): number {
  const raw = Number(process.env.SYNC_ORG_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

/**
 * A deadline for one organization, driven by the run's own progress clock.
 *
 * Aborting is what makes this real rather than decorative: a `Promise.race`
 * would let the abandoned organization carry on writing to the same database
 * underneath its successor. The signal reaches the Partner client, which stops
 * both the request in flight and the retry loop around it.
 */
function orgDeadline(
  org: PartnerOrg,
  reporter: SyncReporter,
): { signal: AbortSignal; release(): void } {
  const limit = orgStallMs();
  const controller = new AbortController();
  const timer = setInterval(() => {
    const idle = reporter.idleMs();
    if (idle < limit) return;
    const stuckFor = idle >= 60_000 ? `${Math.round(idle / 60_000)}m` : `${Math.round(idle / 1000)}s`;
    controller.abort(
      new Error(
        `Organization ${org.label} made no progress for ${stuckFor} and was given up on so the ` +
          `remaining organization(s) could sync. It resumes from its cursors on the next run.`,
      ),
    );
  }, Math.min(limit, 15_000));
  timer.unref?.();
  return { signal: controller.signal, release: () => clearInterval(timer) };
}

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

/**
 * The apps in scope, across every organization by default.
 *
 * Unfiltered is the default deliberately: every reader of this function — the
 * dashboard, the metrics, the funnel, the notifier — is
 * asking "what does this instance cover?", and the answer to that has always
 * been "all of it". Making it default to one org would silently drop the second
 * org's apps out of every existing figure the moment it was configured.
 *
 * `organizationId` narrows it, and only the sync passes it, because only the
 * sync has to pick a token.
 */
export function resolveScopedAppIds(db: Db, organizationId?: string): string[] {
  const { scope } = getConfig();

  if (organizationId === undefined) {
    if (scope.appIds.length > 0) return scope.appIds;
    const rows = db.prepare('SELECT id FROM apps ORDER BY id').all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  // Per org the database is the authority, because `PARTNER_APP_IDS` is a flat
  // list that names no organization. Intersecting keeps the allowlist meaning
  // what it always meant without pretending it knows which org an id is in.
  const rows = db
    .prepare('SELECT id FROM apps WHERE org_id = ? ORDER BY id')
    .all(organizationId) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  if (scope.appIds.length === 0) return ids;
  const allowed = new Set(scope.appIds);
  return ids.filter((id) => allowed.has(id));
}

/** Watermark keys are per organization; see the migration in `src/db/index.ts`. */
export function transactionsKey(org: PartnerOrg, appId: string | null): string {
  return `org:${org.organizationId}:transactions:${appId ?? 'all'}`;
}

export function eventsKey(org: PartnerOrg, appId: string): string {
  return `org:${org.organizationId}:events:${appId}`;
}

async function syncTransactionsFor(
  db: Db,
  org: PartnerOrg,
  appId: string | null,
  options: SyncOptions,
  signal?: AbortSignal,
): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = transactionsKey(org, appId);

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
    org,
    TRANSACTIONS_QUERY,
    transactionVariables(appId, createdAtMin, SALE_TRANSACTION_TYPES),
    (data) => data?.transactions,
    resumeCursor(state, createdAtMin),
    { signal },
  );

  for await (const page of pages) {
    total += insertTransactions(db, page.nodes, org.organizationId);
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
  org: PartnerOrg,
  appId: string,
  options: SyncOptions,
  signal?: AbortSignal,
): Promise<number> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;
  const key = eventsKey(org, appId);

  if (options.full) {
    writeSyncState(db, key, { cursor: null, cursorWindow: null, syncedThrough: null });
  }

  const state = readSyncState(db, key);
  const occurredAtMin = windowStart(state.syncedThrough, scope.syncStartDate);

  let total = 0;
  let latest: string | null = null;

  const pages = paginate<AppEventNode>(
    org,
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

/** Confirms an app id exists **in this organization** and records it locally. */
async function confirmApp(
  db: Db,
  org: PartnerOrg,
  appId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const data = await partnerQuery<{ app: { id: string; name: string; apiKey: string } | null }>(
    org,
    APP_QUERY,
    { appId: `gid://partners/App/${appId}` },
    { signal },
  );
  if (!data.app) return false;
  upsertApp(db, data.app, org.organizationId);
  return true;
}

export interface SyncResult {
  /** The organization ids this run covered, in configured order. */
  orgs: string[];
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

/**
 * One organization's Partner API pass: transactions, then that org's events.
 *
 * Events live in here rather than in a single loop afterwards because picking
 * the right token for an app means knowing its org, and because one org's
 * revoked token then strands only its own events.
 */
async function syncOrg(
  db: Db,
  org: PartnerOrg,
  options: SyncOptions,
  reporter: SyncReporter,
  signal: AbortSignal,
): Promise<{ transactions: number; events: number }> {
  const { scope } = getConfig();
  const onProgress = options.onProgress ?? noop;

  let transactions = 0;
  let claimed: string[] = [];

  if (scope.appIds.length > 0) {
    /*
     * `PARTNER_APP_IDS` is a flat list with no organization on it, so an id
     * this org does not have is not necessarily a typo any more — it is
     * probably the other org's app. A miss is recorded rather than thrown, and
     * `runSync` complains at the end about any id that *no* org claimed, which
     * is the case that really is a typo.
     */
    await reporter.phase('scope', org.label, async () => {
      for (const appId of scope.appIds) {
        if (await confirmApp(db, org, appId, signal)) claimed.push(appId);
      }
      return claimed;
    }, (found) => ({ apps: found.length, configured: scope.appIds.length }));
    onProgress(
      `[${org.label}] scope: ${claimed.length} of ${scope.appIds.length} app(s) from ` +
        `PARTNER_APP_IDS belong to this organization.`,
    );
    for (const appId of claimed) {
      onProgress(`[${org.label}] syncing transactions for app ${appId}...`);
      transactions += await reporter.phase(
        'transactions',
        org.label,
        () => syncTransactionsFor(db, org, appId, options, signal),
        (rows) => ({ rows }),
      );
    }
  } else {
    onProgress(`[${org.label}] scope: every app with recorded transactions.`);
    transactions += await reporter.phase(
      'transactions',
      org.label,
      () => syncTransactionsFor(db, org, null, options, signal),
      (rows) => ({ rows }),
    );
  }

  let events = 0;
  for (const appId of resolveScopedAppIds(db, org.organizationId)) {
    onProgress(`[${org.label}] syncing events for app ${appId}...`);
    events += await reporter.phase(
      'events',
      org.label,
      () => syncEventsFor(db, org, appId, options, signal),
      (rows) => ({ rows }),
    );
  }

  return { transactions, events };
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
  const { partner, scope } = getConfig();
  const orgs = partner.orgs;

  /*
   * Every step below is handed the reporter's own callback rather than the
   * caller's, so a detail line updates the heartbeat's "how far has it got"
   * before it reaches whoever asked for it. The caller still sees each line
   * unchanged; it just no longer goes straight past the thing narrating the run.
   */
  const steps: SyncOptions = { full: options.full, onProgress: reporter.progressCallback() };
  const onProgress = steps.onProgress ?? noop;

  let transactions = 0;
  let events = 0;

  /*
   * One organization's failure does not take the others down.
   *
   * With a single org, "abort the run" and "abort this org" were the same
   * thing. With two they are not: a revoked token on org B would otherwise stop
   * org A syncing at all, and stop the rebuild below, so every figure in the
   * dashboard would freeze because of a credential for apps it does not even
   * cover. Errors are collected, everything that can still run runs, and the
   * aggregate is thrown at the end — so the scheduler still records a failure
   * and still backs off.
   */
  const failures: Array<{ org: PartnerOrg; error: Error }> = [];

  for (const org of orgs) {
    onProgress(`Organization ${org.label} (${org.organizationId})...`);
    try {
      const deadline = orgDeadline(org, reporter);
      try {
        const counts = await reporter.phase(
          'org',
          org.label,
          () => syncOrg(db, org, steps, reporter, deadline.signal),
          (result) => ({ transactions: result.transactions, events: result.events }),
        );
        transactions += counts.transactions;
        events += counts.events;
      } finally {
        deadline.release();
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      failures.push({ org, error });
      onProgress(`Organization ${org.label} failed: ${error.message}`);
    }
  }

  const appIds = resolveScopedAppIds(db);
  if (appIds.length === 0) {
    onProgress('No apps discovered. Set PARTNER_APP_IDS if your apps have no transactions yet.');
  }

  // An id no organization claimed is the typo the old hard throw used to catch.
  // It cannot be thrown per org any more, so it is checked once, here, where
  // "no org has it" is actually knowable.
  if (scope.appIds.length > 0 && failures.length === 0) {
    const known = new Set(
      (db.prepare('SELECT id FROM apps').all() as Array<{ id: string }>).map((row) => row.id),
    );
    const orphans = scope.appIds.filter((appId) => !known.has(appId));
    if (orphans.length > 0) {
      onProgress(
        `Warning: app id(s) ${orphans.join(', ')} from PARTNER_APP_IDS were not found in any ` +
          `configured organization. Check for a typo, or add the organization that owns them.`,
      );
    }
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
    async () => rebuildDerivedTables(db, { full: options.full }),
    (result) => ({
      subscriptions: result.subscriptions,
      installs: result.installs,
      customerEvents: result.customerEvents,
      // The work, as opposed to the totals above: how many merchants this pass
      // actually rebuilt.
      pairs: result.pairs,
    }),
  );

  /*
   * Refill what the rebuild just emptied, here in the worker rather than on the
   * first request that arrives afterwards.
   *
   * `rebuildDerivedTables` clears the metric cache, and the currency profile
   * lives in it — a full scan of `transactions` that every metric needs before
   * it can even look for its own cached answer. Leaving it cold hands that scan
   * to a request thread that is also the health check's only chance to be
   * answered. Warming it costs one pass here, off the request path, in a
   * process whose only job is to be busy.
   */
  await reporter.phase('warm', null, async () => {
    warmCurrencyProfiles(db, appIds);
    warmDashboardMetrics();
  });

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${orgs.length} organization(s) failed to sync: ` +
        failures.map(({ org, error }) => `${org.label}: ${error.message}`).join('; '),
      { cause: failures[0]?.error },
    );
  }

  return {
    orgs: orgs.map((org) => org.organizationId),
    apps: appIds,
    transactions,
    events,
    reviews,
    listing,
    ...derived,
  };
}

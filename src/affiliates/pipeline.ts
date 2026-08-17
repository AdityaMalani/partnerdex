import { getConfig } from '../config.js';
import { getDb, readSyncState, writeSyncState, type Db } from '../db/index.js';
import { addDays, toUtcIso } from '../metrics/time.js';
import { connect, type Connected } from '../bigquery/client.js';
import { listAppSources, readConnection, recordCheck } from '../bigquery/connection.js';
import {
  DEFAULT_LOOKBACK_DAYS,
  runAttribution,
  type Attribution,
} from './ga4Attribution.js';
import { resolveAttributionShops, resolveClaimShops, upsertAttribution } from './store.js';
import { recomputeCommissions, type CommissionRecomputeResult } from './commissionRun.js';

/**
 * The join between the three affiliate modules and the sync loop.
 *
 * `ga4Attribution.ts` discovers referrals and writes nothing. `commission.ts`
 * computes amounts and reads nothing. `store.ts` writes rows and decides
 * nothing. Each of those is deliberately incomplete — this file is where they
 * meet a clock, and it is the only place that knows the order the three have to
 * happen in:
 *
 *   1. attribute — new referrals, from GA4, incrementally
 *   2. resolve   — referrals whose merchant the sync had not met yet
 *   3. recompute — commissions, over every referral that now has a shop
 *
 * The order is not arbitrary. A referral with no `shop_id` earns nothing,
 * because the commission engine joins transactions on (app, shop); so resolving
 * has to happen after anything that can create a referral and before anything
 * that pays on one. Running recompute first would leave a merchant unpaid for a
 * whole sync interval for no reason other than sequencing.
 *
 * **Nothing here may fail the sync.** Affiliate attribution reads BigQuery,
 * which is optional in this product and unreachable in most installs. The
 * Partner API sync is the thing that must not break — it is where MRR comes
 * from — so every step below either returns a reason or is caught, exactly as
 * `syncListingEvents` does for the funnel.
 */

/**
 * How far back an incremental attribution run re-reads, in days of install.
 *
 * The same reasoning as `LOOKBACK_HOURS` in `bigquery/ingest.ts`: GA4 keeps
 * backfilling a daily table for hours after it first appears, so the newest day
 * is never complete when first read. Attribution has a second reason the funnel
 * does not — an attribution is a *pair*, and a click that lands late can be the
 * first touch for an install already seen. Re-deriving the tail is what lets
 * that correct itself.
 *
 * `ga4Attribution.ts` already picked 3 days for its own default; this re-exports
 * that decision rather than making a second one that could drift from it.
 */
export const ATTRIBUTION_LOOKBACK_DAYS = DEFAULT_LOOKBACK_DAYS;

/**
 * How far back a first attribution run reaches when nothing is watermarked.
 *
 * A year. The scan is cheap — dry-run on the Stoq export puts the *entire*
 * multi-year history at 0.92 GB, inside BigQuery's monthly free tier — so this
 * is not a cost ceiling. It is a correctness one: referrals older than this came
 * out of the Mantle import as `source='imported'` facts, and re-deriving them
 * from GA4 would only produce claims that lose to those facts anyway (see
 * `persistAttribution`). Someone reconstructing genuinely old history should
 * run `full`, deliberately, rather than have every fresh install do it.
 */
export const ATTRIBUTION_BACKFILL_DAYS = 365;

/** What one GA4 attribution did when it met the ledger. */
export type PersistOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'kept_manual'
  | 'kept_other_affiliate'
  | 'kept_unassigned'
  | 'unknown_handle'
  | 'no_domain';

export interface AttributionSyncResult {
  /** Apps that were actually queried. */
  apps: string[];
  created: number;
  updated: number;
  /** Referrals GA4 proposed that an existing record outranked. Not an error. */
  deferred: number;
  /** Apps that could not be attributed, and why. Never thrown. */
  skipped: Array<{ appId: string; reason: string }>;
}

export interface AffiliateSyncResult {
  attribution: AttributionSyncResult;
  /** Referrals whose `shop_id` was filled in this run. */
  shopsResolved: number;
  commissions: CommissionRecomputeResult | null;
  /** Set when the whole step was skipped or failed. The sync still succeeded. */
  error: string | null;
}

export interface AffiliateSyncOptions {
  full?: boolean;
  onProgress?: (message: string) => void;
  now?: Date;
}

const EMPTY_ATTRIBUTION: AttributionSyncResult = {
  apps: [],
  created: 0,
  updated: 0,
  deferred: 0,
  skipped: [],
};

/* ------------------------------------------------------- persisting a claim */

interface LiveAttributionRow {
  id: string;
  affiliate_id: string;
  source: string;
  referred_at: string;
  shop_id: string;
}

/**
 * A myshopify domain as the ledger stores it: bare host, lower case.
 *
 * GA4's `shop_url` is written by Shopify's own install instrumentation and is
 * normally already bare, but it has been seen carrying a scheme and a trailing
 * slash. The domain is the unique key one live referral per program is enforced
 * on, so two spellings of one merchant would be two claims on the same merchant
 * — the one shape the index exists to prevent.
 */
export function normalizeDomain(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export interface ResolvedShop {
  shopId: string;
  domain: string;
}

/**
 * The merchant a GA4 install event names, as this store knows them.
 *
 * GA4 carries a numeric `shop_id` — the Shopify shop id, which is `shops.id`
 * exactly (checked across the imported referrals carrying both, with zero
 * mismatches) — and usually a `shop_url` beside it. Either can be missing, so
 * both are tried, and the *local* row wins where it exists: it is the spelling
 * every other table in this database uses.
 *
 * A blank `shopId` is a normal answer, not a failure. It means the referral
 * arrived before the Partner API sync met the merchant, which the schema
 * expects; the domain is what `resolveAttributionShops()` later re-resolves
 * from. A blank *domain* is the answer that cannot be stored, because there is
 * then no key on which to tell one claim from another.
 */
export function resolveShop(
  db: Db,
  ga4ShopId: string,
  ga4Domain: string | null,
): ResolvedShop {
  const domain = normalizeDomain(ga4Domain);

  if (ga4ShopId) {
    const byId = db
      .prepare('SELECT id, LOWER(myshopify_domain) AS domain FROM shops WHERE id = ?')
      .get(ga4ShopId) as { id: string; domain: string | null } | undefined;
    if (byId) return { shopId: byId.id, domain: byId.domain || domain };
  }

  if (domain) {
    const byDomain = db
      .prepare('SELECT id FROM shops WHERE LOWER(myshopify_domain) = ?')
      .get(domain) as { id: string } | undefined;
    if (byDomain) return { shopId: byDomain.id, domain };
  }

  return { shopId: '', domain };
}

/**
 * Write one GA4 attribution, or decline to.
 *
 * This function is the entire idempotency and precedence policy of the
 * pipeline, so it is worth being explicit about what it refuses to do.
 *
 * **It never flips a live referral to a different affiliate.** A merchant
 * already claimed by someone else stays claimed. The pipeline re-reads its own
 * tail on every run and a late-arriving click can change what first touch says;
 * allowing that to move a referral would mean an affiliate's earnings could
 * change under them days after the fact, and any commission already computed
 * against the old owner would silently become someone else's. Where the two
 * disagree, the existing record wins and the disagreement is counted.
 *
 * **It never overwrites a human decision.** `source='manual'` is an admin who
 * looked at the case and assigned it; `source='imported'` is a fact carried out
 * of the platform this one replaces. GA4 is an inference. An inference does not
 * get to overrule either — a large minority of the imported referrals were
 * manual precisely because the automated path could not see them, so a pipeline
 * that
 * overwrote manual rows would spend its life undoing the fix for its own blind
 * spot.
 *
 * **It does not resurrect an unassignment.** A referral soft-deleted *after*
 * the click being offered is the same claim, already withdrawn — by an admin or
 * by the 30-day-after-uninstall rule. Re-creating it because the click is still
 * inside the lookback window would make the removal last exactly one sync
 * interval. A click that lands *after* the removal is a genuinely new referral
 * and is allowed through.
 *
 * What it does update, on a row it already owns, is the shop id and the click
 * date — the first so a merchant that has since synced stops being unresolved,
 * the second because an earlier click is a better answer under first touch.
 */
export function persistAttribution(
  db: Db,
  attribution: Attribution,
  membership: { affiliateId: string; programId: string; handle: string },
  now: string = new Date().toISOString(),
): PersistOutcome {
  const shop = resolveShop(db, attribution.shopId, attribution.shopDomain);
  if (!shop.domain) return 'no_domain';

  const live = db
    .prepare(
      `SELECT id, affiliate_id, source, referred_at, shop_id
         FROM affiliate_attributions
        WHERE program_id = ? AND myshopify_domain = ? AND deleted_at IS NULL`,
    )
    .get(membership.programId, shop.domain) as LiveAttributionRow | undefined;

  if (live) {
    if (live.affiliate_id !== membership.affiliateId) return 'kept_other_affiliate';
    if (live.source !== 'ga4') return 'kept_manual';

    // Ours already. Only two things can legitimately improve: a merchant that
    // has since been synced, and an earlier first touch.
    const referredAt =
      attribution.clickedAt < live.referred_at ? attribution.clickedAt : live.referred_at;
    const shopId = shop.shopId || live.shop_id;
    if (referredAt === live.referred_at && shopId === live.shop_id) return 'unchanged';

    db.prepare(
      `UPDATE affiliate_attributions
          SET referred_at = ?, shop_id = ?, handle = ?, app_id = ?
        WHERE id = ?`,
    ).run(referredAt, shopId, membership.handle, attribution.appId, live.id);
    return 'updated';
  }

  // No live claim. A *withdrawn* one covering this same click still binds.
  const withdrawn = db
    .prepare(
      `SELECT 1 FROM affiliate_attributions
        WHERE program_id = ? AND myshopify_domain = ?
          AND deleted_at IS NOT NULL AND deleted_at >= ?`,
    )
    .get(membership.programId, shop.domain, attribution.clickedAt);
  if (withdrawn) return 'kept_unassigned';

  upsertAttribution(
    {
      affiliateId: membership.affiliateId,
      programId: membership.programId,
      shopId: shop.shopId,
      myshopifyDomain: shop.domain,
      appId: attribution.appId,
      // The click, not the install: it is the instant the referral was made,
      // and it is what the commission engine measures "before the referral"
      // against. The install is minutes to weeks later and is already recorded
      // by the Partner API, exactly and without depending on a cookie.
      referredAt: attribution.clickedAt,
      source: 'ga4',
      handle: membership.handle,
      createdAt: now,
    },
    db,
  );
  return 'created';
}

/* ------------------------------------------------------------- attribution */

interface HandleRow {
  handle: string;
  affiliate_id: string;
  program_id: string;
}

/**
 * The handles that may claim an install on this app, and who they belong to.
 *
 * Only `enrolled` memberships. A pending applicant has not been let into the
 * program — Stoq requires approval and has applicants waiting — and crediting
 * them would create money owed to someone nobody has agreed to pay. The cost of
 * that strictness is that their clicks are invisible until approval, which is
 * why approving a membership clears this app's watermark (see
 * `admin.ts`): the next sync re-reads from the join date and picks them up.
 *
 * Passing the real list also takes the load off the eight-character shape test
 * in `ga4Attribution.ts`, which cannot tell a handle from a campaign name.
 */
function enrolledHandles(db: Db, appId: string): HandleRow[] {
  return db
    .prepare(
      `SELECT m.handle AS handle, m.affiliate_id AS affiliate_id, m.program_id AS program_id
         FROM affiliate_memberships m
         JOIN affiliate_programs p ON p.id = m.program_id
        WHERE p.app_id = ? AND p.status = 'active' AND m.status = 'enrolled'`,
    )
    .all(appId) as HandleRow[];
}

/** Where this app's attribution run starts, in install dates. */
function windowStart(db: Db, key: string, now: Date, full: boolean): Date {
  const { scope } = getConfig();
  const configured = new Date(`${scope.syncStartDate}T00:00:00Z`);
  const backfillFloor = addDays(now, -ATTRIBUTION_BACKFILL_DAYS);
  const floor = configured.getTime() > backfillFloor.getTime() ? configured : backfillFloor;

  if (full) return floor;
  const { syncedThrough } = readSyncState(db, key);
  if (!syncedThrough) return floor;
  return addDays(new Date(syncedThrough), -ATTRIBUTION_LOOKBACK_DAYS);
}

/** `sync_state` key for one app's attribution watermark. */
export function attributionStateKey(appId: string): string {
  return `affiliates:ga4:${appId}`;
}

/**
 * Attribute installs to affiliates for every app with a GA4 dataset.
 *
 * Quiet when BigQuery is not connected, quiet when an app has no dataset, and
 * quiet when a query fails — each of those is recorded as a skip with its
 * reason rather than raised, because the caller is the sync and the sync has
 * more important work than this.
 */
export async function syncAttributions(
  db: Db,
  appIds: string[],
  options: AffiliateSyncOptions = {},
): Promise<AttributionSyncResult> {
  const onProgress = options.onProgress ?? (() => {});
  const now = options.now ?? new Date();

  const connection = readConnection(db);
  if (!connection || appIds.length === 0) return EMPTY_ATTRIBUTION;

  const sources = listAppSources(appIds, db).filter((source) => source.dataset !== null);
  if (sources.length === 0) return EMPTY_ATTRIBUTION;

  let connected: Connected;
  try {
    connected = await connect(connection);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordCheck(reason, db);
    return { ...EMPTY_ATTRIBUTION, skipped: sources.map((s) => ({ appId: s.appId, reason })) };
  }

  const result: AttributionSyncResult = { ...EMPTY_ATTRIBUTION, skipped: [] };

  for (const source of sources) {
    const handles = enrolledHandles(db, source.appId);
    if (handles.length === 0) {
      result.skipped.push({
        appId: source.appId,
        reason: 'No enrolled affiliates on this app, so no handle can claim an install.',
      });
      continue;
    }

    // One handle can belong to two affiliates only across programs, and a
    // program belongs to one app — so within an app the map is unambiguous.
    // Lower-cased because the ledger collates NOCASE and GA4 does not.
    const byHandle = new Map(handles.map((row) => [row.handle.toLowerCase(), row]));
    const key = attributionStateKey(source.appId);
    const from = windowStart(db, key, now, options.full ?? false);

    try {
      const found = await runAttribution(connected, source, {
        from,
        to: now,
        handles: [...byHandle.keys()],
      });

      const write = db.transaction((rows: Attribution[]) => {
        for (const row of rows) {
          const membership = byHandle.get(row.handle.toLowerCase());
          if (!membership) {
            result.deferred += 1;
            continue;
          }
          const outcome = persistAttribution(
            db,
            row,
            {
              affiliateId: membership.affiliate_id,
              programId: membership.program_id,
              handle: membership.handle,
            },
            now.toISOString(),
          );
          if (outcome === 'created') result.created += 1;
          else if (outcome === 'updated') result.updated += 1;
          else if (outcome !== 'unchanged') result.deferred += 1;
        }
      });
      write(found);

      // Watermarked on the window we scanned rather than on the newest
      // attribution found: a window with no referrals in it has still been
      // read, and re-reading it forever would make every run cost more than
      // the last for no new answers. The lookback overlap covers the tail.
      writeSyncState(db, key, { syncedThrough: toUtcIso(now) });
      result.apps.push(source.appId);
      onProgress(
        `  affiliate attribution (${source.appName ?? source.appId}): ` +
          `${found.length} candidate referral(s)`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result.skipped.push({ appId: source.appId, reason });
      onProgress(`  affiliate attribution (${source.appId}): ${reason}`);
    }
  }

  return result;
}

/* ------------------------------------------------------------ the sequence */

/**
 * The whole affiliate step of a sync, in the one order that works.
 *
 * Attribute, then resolve, then recompute — see the module note. The commission
 * recompute runs even when attribution was skipped entirely, because it depends
 * on transactions rather than on GA4: an install that Mantle attributed two
 * years ago goes on earning through a BigQuery outage, and stopping the
 * recompute because Google is unreachable would quietly freeze everybody's
 * balance.
 */
export async function syncAffiliates(
  db: Db = getDb(),
  appIds: string[] = [],
  options: AffiliateSyncOptions = {},
): Promise<AffiliateSyncResult> {
  const onProgress = options.onProgress ?? (() => {});

  // Nothing imported and nobody signed up: the ledger is empty and every step
  // below would be a no-op over an empty table. Cheapest possible check first,
  // so an install that does not use the affiliate feature pays nothing for it.
  const enrolled = db
    .prepare('SELECT 1 FROM affiliate_memberships LIMIT 1')
    .get() as unknown;
  const referred = db.prepare('SELECT 1 FROM affiliate_attributions LIMIT 1').get() as unknown;
  if (!enrolled && !referred) {
    return { attribution: EMPTY_ATTRIBUTION, shopsResolved: 0, commissions: null, error: null };
  }

  const result: AffiliateSyncResult = {
    attribution: EMPTY_ATTRIBUTION,
    shopsResolved: 0,
    commissions: null,
    error: null,
  };

  try {
    result.attribution = await syncAttributions(db, appIds, options);
  } catch (error) {
    // syncAttributions is written not to throw; this is the belt to its braces,
    // because the one thing that must not happen is affiliate work taking the
    // Partner API sync down with it.
    result.error = error instanceof Error ? error.message : String(error);
  }

  try {
    // Claims are drained by the same pass and counted in the same number. They
    // carry a merchant that had not synced yet for exactly the same reason a
    // referral does, and a claim whose shop never resolves is one an operator
    // cannot see the merchant behind when they come to decide it.
    result.shopsResolved = resolveAttributionShops(db) + resolveClaimShops(db);
    if (result.shopsResolved > 0) {
      onProgress(`  affiliate referrals: ${result.shopsResolved} merchant(s) resolved`);
    }

    result.commissions = recomputeCommissions(db);
    if (result.commissions.written > 0 || result.commissions.cancelled > 0) {
      onProgress(
        `  affiliate commissions: ${result.commissions.written} row(s), ` +
          `${result.commissions.cancelled} withdrawn`,
      );
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { asOfPredicate, type AsOfOptions } from '../metrics/asof.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * The shared merchant read model.
 *
 * One answer to "who is this store, and what are they worth right now", used
 * everywhere a merchant appears in the admin surface: the referral feed, an
 * affiliate's own referrals, the claim queue and a payout's itemisation. It
 * exists because those four screens were each naming a merchant with whatever
 * column happened to be at hand — sometimes `shops.name`, sometimes the bare
 * domain, sometimes the name an affiliate typed into a claim — and an operator
 * working the queue could not tell two stores apart, let alone tell whether
 * either was still installed.
 *
 * Three things about the shape of this are deliberate.
 *
 * **Nothing is stored.** There is no merchant table and no denormalised copy of
 * a plan onto `affiliate_attributions`. A referral is a source record — it says
 * that an affiliate sent this merchant on this date — and the merchant's plan is
 * not a fact about the referral. Writing today's plan onto it would make the
 * referral wrong tomorrow, and a copy that disagrees with `subscriptions` is
 * worse than no copy, because the reader has no way to know which is right.
 *
 * **A merchant may be named by shop id or by domain, and both are resolved.**
 * A sizeable share of the imported attributions carry a `myshopify_domain` and
 * no
 * `shop_id`, because the transaction backfill that would introduce us to those
 * shops has not finished. Resolving on the domain as well as the id means a
 * referral picks its merchant up the moment `shops` learns about them, without
 * waiting for the backfill pass that rewrites `shop_id`.
 *
 * **Unknown is a value, not a zero.** See `PlanStanding` and `InstallStanding`
 * below — this is the part that matters most and is easiest to get wrong.
 */

/**
 * What we can say about whether this merchant is paying.
 *
 * - `paying` — a live subscription, on the same as-of predicate MRR itself uses.
 * - `free` — this merchant has subscription rows and none of them is live. We
 *   have met their billing history, so "not paying" is an observation.
 * - `unknown` — we have no subscription row for them at all.
 *
 * The third case is the entire reason this is a three-valued type rather than a
 * boolean. `subscriptions` is **empty in production right now**: it is rebuilt
 * from transactions, and that sync phase runs after the transaction backfill,
 * which has not finished. So today every merchant answers `unknown`, and if this
 * collapsed `unknown` into `free` the admin would state, in confident type, that
 * none of the referred merchants pays us anything. Some of them pay us every
 * month. A blank is a true statement about what we know; "Free", "None" or
 * "$0.00" is a false statement about the merchant.
 */
export type PlanStanding = 'paying' | 'free' | 'unknown';

/**
 * Whether the app is installed right now.
 *
 * - `installed` — an install interval covers this instant.
 * - `uninstalled` — this merchant has install intervals and none covers now.
 * - `unknown` — no install interval for them at all.
 *
 * Same three-valued reasoning as `PlanStanding`, and the same live condition:
 * `install_intervals` is also empty in production, so absence today means "that
 * phase has not run" rather than "they left". Note the deliberate difference
 * from the Customers page, which reads a merchant with no live install as
 * `gone`. That page is driven by a synced population, where absence really is
 * evidence. A referral list is not: it is full of merchants the sync has never
 * met, and calling them uninstalled would be inventing an uninstall.
 */
export type InstallStanding = 'installed' | 'uninstalled' | 'unknown';

/** How a caller names the merchant it wants. Either field may be blank. */
export interface MerchantRef {
  /** `shops.id`. Blank or absent on the unresolved attributions. */
  shopId?: string | null;
  /** The myshopify domain, matched case-insensitively. */
  myshopifyDomain?: string | null;
  /**
   * A name the caller already holds and we do not — the store name an affiliate
   * typed into a claim. Used only when `shops` has nothing, and never allowed to
   * override a real `shops.name`: it is what somebody said the store is called,
   * which is not always what the installation is called.
   */
  fallbackName?: string | null;
}

export interface Merchant {
  /** `shops.id` once resolved; null when this merchant is not in `shops`. */
  shopId: string | null;
  myshopifyDomain: string | null;
  /** `shops.name`, else the caller's `fallbackName`, else null. Never invented. */
  name: string | null;
  /**
   * Whether a `shops` row was found. False means everything below is `unknown`
   * by construction rather than by observation, and the UI says so.
   */
  known: boolean;
  install: InstallStanding;
  plan: PlanStanding;
  /** The live plan's name. Null whenever `plan` is not `paying`. */
  planName: string | null;
  /** Normalised monthly value of the live subscriptions. Null unless `paying`. */
  monthlyAmount: number | null;
  currency: string | null;
}

export interface MerchantLookupOptions {
  /** Reporting scope. Empty means every app in scope, as the Customers page does. */
  appIds?: string[];
  /** The instant liveness is read at. Defaults to now; fixed in tests. */
  now?: string;
}

/** A merchant we could say nothing about, which is a real and common answer. */
function unknownMerchant(ref: MerchantRef): Merchant {
  const domain = normaliseDomain(ref.myshopifyDomain);
  return {
    shopId: (ref.shopId ?? '') || null,
    myshopifyDomain: domain || null,
    name: (ref.fallbackName ?? '') || null,
    known: false,
    install: 'unknown',
    plan: 'unknown',
    planName: null,
    monthlyAmount: null,
    currency: null,
  };
}

/**
 * Domains are compared lower-cased throughout.
 *
 * Not a theoretical worry: 8 of the 18,188 rows in `shops` carry a domain with
 * an upper-case character in it, while `affiliate_attributions.myshopify_domain`
 * is normalised on the way in. A plain `=` join silently loses those merchants.
 */
function normaliseDomain(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function liveOptions(appIds: string[]): AsOfOptions {
  const { reporting } = getConfig();
  return {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  };
}

/** Bind a list of values as `@prefix0, @prefix1, …`, or null when it is empty. */
function bindList(
  values: string[],
  prefix: string,
): { sql: string; params: Record<string, unknown> } | null {
  if (values.length === 0) return null;
  const params: Record<string, unknown> = {};
  const names = values.map((value, index) => {
    params[`${prefix}${index}`] = value;
    return `@${prefix}${index}`;
  });
  return { sql: names.join(', '), params };
}

/**
 * Resolve a page of merchants in a fixed number of queries.
 *
 * Batched rather than per-row on purpose: the callers are list endpoints
 * rendering fifty rows, and fifty round trips through three tables each is the
 * shape of query that only shows up as a problem in production. The result is
 * returned positionally — one `Merchant` per input `MerchantRef`, in order — so
 * a caller can zip it back onto its own rows without inventing a key.
 */
export function lookupMerchants(
  refs: MerchantRef[],
  db: Db = getDb(),
  options: MerchantLookupOptions = {},
): Merchant[] {
  if (refs.length === 0) return [];

  const appIds =
    options.appIds && options.appIds.length > 0 ? options.appIds : resolveScopedAppIds(db);
  const now = options.now ?? new Date().toISOString();

  const shopIds = [...new Set(refs.map((ref) => (ref.shopId ?? '').trim()).filter(Boolean))];
  const domains = [...new Set(refs.map((ref) => normaliseDomain(ref.myshopifyDomain)).filter(Boolean))];

  const idList = bindList(shopIds, 'mid');
  const domainList = bindList(domains, 'mdom');
  if (!idList && !domainList) return refs.map(unknownMerchant);

  const identity: string[] = [];
  if (idList) identity.push(`s.id IN (${idList.sql})`);
  if (domainList) identity.push(`LOWER(s.myshopify_domain) IN (${domainList.sql})`);

  const shops = db
    .prepare(
      `SELECT s.id AS id, s.name AS name, s.myshopify_domain AS domain
         FROM shops s
        WHERE ${identity.join(' OR ')}`,
    )
    .all({ ...(idList?.params ?? {}), ...(domainList?.params ?? {}) }) as Array<{
    id: string;
    name: string | null;
    domain: string | null;
  }>;

  const byId = new Map(shops.map((row) => [row.id, row]));
  const byDomain = new Map(shops.map((row) => [normaliseDomain(row.domain), row]));

  const resolvedIds = [...new Set(shops.map((row) => row.id))];
  const resolvedList = bindList(resolvedIds, 'msh');

  /*
   * Installs. `intervals` is the count of everything we hold for this shop, and
   * it is what separates "they uninstalled" from "we have never synced their
   * install history" — the distinction the whole `InstallStanding` type exists
   * for. Without it a zero here reads identically in both cases.
   */
  const installs = new Map<string, { live: number; intervals: number }>();
  if (resolvedList) {
    const appList = bindList(appIds, 'iapp');
    const rows = db
      .prepare(
        `SELECT i.shop_id AS shopId,
                MAX(CASE WHEN i.started_at <= @now AND (i.ended_at IS NULL OR i.ended_at > @now)
                         THEN 1 ELSE 0 END) AS live,
                COUNT(*) AS intervals
           FROM install_intervals i
          WHERE i.shop_id IN (${resolvedList.sql})
            ${appList ? `AND i.app_id IN (${appList.sql})` : ''}
          GROUP BY i.shop_id`,
      )
      .all({ ...resolvedList.params, ...(appList?.params ?? {}), now }) as Array<{
      shopId: string;
      live: number;
      intervals: number;
    }>;
    for (const row of rows) installs.set(row.shopId, { live: row.live, intervals: row.intervals });
  }

  /*
   * Subscriptions. Liveness comes from `asOfPredicate` — the same predicate the
   * MRR series and the Customers page use — so a merchant shown here as paying
   * $49 is a merchant contributing $49 to MRR, by construction rather than by
   * two queries that happen to agree today.
   *
   * Every row is read rather than only the live ones, because the count of rows
   * we hold is the evidence that separates `free` from `unknown`.
   */
  const subs = new Map<
    string,
    { rows: number; monthly: number; planName: string | null; currency: string | null; best: number }
  >();
  if (resolvedList) {
    const live = asOfPredicate(liveOptions(appIds), '@now');
    const appList = bindList(appIds, 'sapp');
    const rows = db
      .prepare(
        `SELECT s.shop_id AS shopId, s.plan_name AS planName, s.monthly_amount AS monthlyAmount,
                s.currency AS currency,
                CASE WHEN ${live.sql} THEN 1 ELSE 0 END AS isLive
           FROM subscriptions s
          WHERE s.shop_id IN (${resolvedList.sql})
            AND s.is_test = 0
            ${appList ? `AND s.app_id IN (${appList.sql})` : ''}`,
      )
      .all({
        ...resolvedList.params,
        ...(appList?.params ?? {}),
        ...live.params,
        now,
      }) as Array<{
      shopId: string;
      planName: string | null;
      monthlyAmount: number;
      currency: string | null;
      isLive: number;
    }>;

    for (const row of rows) {
      const held = subs.get(row.shopId) ?? {
        rows: 0,
        monthly: 0,
        planName: null,
        currency: null,
        best: -1,
      };
      held.rows += 1;
      if (row.isLive === 1) {
        held.monthly += row.monthlyAmount;
        // The plan a merchant is "on" is a single name, and a merchant may hold
        // two live subscriptions across two apps. The larger one is shown and
        // the total is the sum, which is the only pair that adds up: naming the
        // cheaper plan beside a combined figure would read as a wrong price.
        if (row.monthlyAmount > held.best) {
          held.best = row.monthlyAmount;
          held.planName = row.planName;
          held.currency = row.currency;
        }
      }
      subs.set(row.shopId, held);
    }
  }

  return refs.map((ref) => {
    const domain = normaliseDomain(ref.myshopifyDomain);
    const shopId = (ref.shopId ?? '').trim();
    const shop = (shopId ? byId.get(shopId) : undefined) ?? (domain ? byDomain.get(domain) : undefined);
    if (!shop) return unknownMerchant(ref);

    const install = installs.get(shop.id);
    const sub = subs.get(shop.id);
    const paying = sub !== undefined && sub.best >= 0;

    return {
      shopId: shop.id,
      // The row we found wins on both counts. A caller's domain can be stale or
      // mis-typed; `shops` is what the Partner API says the store is.
      myshopifyDomain: normaliseDomain(shop.domain) || domain || null,
      name: (shop.name ?? '') || (ref.fallbackName ?? '') || null,
      known: true,
      install:
        install === undefined || install.intervals === 0
          ? 'unknown'
          : install.live === 1
            ? 'installed'
            : 'uninstalled',
      plan: paying ? 'paying' : sub === undefined || sub.rows === 0 ? 'unknown' : 'free',
      planName: paying ? sub.planName : null,
      monthlyAmount: paying ? Math.round(sub.monthly * 100) / 100 : null,
      currency: paying ? sub.currency : null,
    };
  });
}

/** One merchant. A thin wrapper over the batch, so there is one implementation. */
export function lookupMerchant(
  ref: MerchantRef,
  db: Db = getDb(),
  options: MerchantLookupOptions = {},
): Merchant {
  return lookupMerchants([ref], db, options)[0] ?? unknownMerchant(ref);
}

/* --------------------------------------------------------------- searching */

/**
 * A merchant-search predicate, as a SQL fragment for a list query's WHERE.
 *
 * Search has to run on the server beside the existing paging. Filtering a
 * downloaded page in the browser would only ever search the fifty rows already
 * on screen, which is not searching — and fetching every referral to filter
 * locally is
 * the pattern the referral feed was explicitly built to stop doing.
 *
 * It matches on the myshopify domain **or** the store name, case-insensitively,
 * as a substring, from one box. That is not a convenience: an operator working
 * from a support thread has one of the two and does not know which, and a
 * separate field per column makes them guess. Same contract as the Customers
 * page's search, so the two behave alike.
 *
 * The name has to be reached through `shops`, since the affiliate tables hold
 * only the domain. The `EXISTS` re-resolves the merchant exactly the way
 * `lookupMerchants` does — by id, and by domain for the rows whose `shop_id` is
 * still blank — so a row that shows a name can also be found by it.
 *
 * `extraNameColumns` carries the names we hold outside `shops`: on a claim, the
 * store name the affiliate typed. Searchable because for an unsynced merchant it
 * is the only name on the screen, and a name shown but not searchable is a
 * dead end.
 *
 * The caller binds `@merchantSearch` to `%<lower-cased term>%`; see
 * `merchantSearchTerm`.
 */
export function merchantSearchSql(input: {
  shopIdColumn: string;
  domainColumn: string;
  extraNameColumns?: string[];
}): string {
  const clauses = [
    `LOWER(${input.domainColumn}) LIKE @merchantSearch`,
    `EXISTS (SELECT 1 FROM shops ms
              WHERE (ms.id = ${input.shopIdColumn}
                     OR LOWER(ms.myshopify_domain) = LOWER(${input.domainColumn}))
                AND LOWER(ms.name) LIKE @merchantSearch)`,
    ...(input.extraNameColumns ?? []).map((column) => `LOWER(${column}) LIKE @merchantSearch`),
  ];
  return `(${clauses.join('\n            OR ')})`;
}

/** The bound value for `@merchantSearch`, or null when nothing was typed. */
export function merchantSearchTerm(search: string | undefined): string | null {
  const trimmed = (search ?? '').trim().toLowerCase();
  return trimmed ? `%${trimmed}%` : null;
}

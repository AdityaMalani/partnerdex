import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { asOfPredicate, type AsOfOptions } from '../metrics/asof.js';
import { reviewsForShop, type ReviewSummary } from '../reviews/index.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * The customer read model.
 *
 * Deliberately computed at read time rather than kept as a rollup table. The
 * store is one merchant per row over a few tens of thousands of rows, and
 * SQLite answers these in single-digit milliseconds — so paying for a snapshot
 * table would buy nothing and cost the thing this project is built on: a figure
 * that can silently disagree with the reports beside it.
 *
 * Liveness comes from `asOfPredicate`, the same predicate every MRR and churn
 * chart uses. A customer's MRR on their own page is therefore the same number
 * that customer contributes to the MRR series, by construction rather than by
 * coincidence.
 */

/**
 * Where an event sits on the timeline, which is not always when it is stamped.
 *
 * A review carries the day the App Store published it and no time — the listing
 * never shows one — so it is stored at that day's midnight. On a timeline that
 * reads as 00:00, which puts it ahead of every event that day whose time *is*
 * known: a merchant who installed at 09:15 and reviewed that afternoon appears
 * to have reviewed an app they had not installed yet.
 *
 * Sorting it to the end of its own day is the one placement that cannot be
 * wrong in that way. A review can only follow the install that made it
 * possible, so within a day the position is a deduction rather than a guess.
 * Where it truly sits among that day's other events is unknowable, and nothing
 * here pretends otherwise: `occurred_at` still holds midnight, the UI still
 * shows a date without a time, and only the ordering is decided here.
 *
 * String arithmetic rather than SQLite's `datetime()`, which would return
 * `YYYY-MM-DD HH:MM:SS` and stop comparing lexically against the ISO instants
 * every other row holds.
 */
const TIMELINE_ORDER = `CASE WHEN e.type = 'review_posted'
       THEN substr(e.occurred_at, 1, 11) || '23:59:59.999Z'
       ELSE e.occurred_at END`;

/** "Live right now", read through the shared as-of predicate. */
function liveOptions(appIds: string[]): AsOfOptions {
  const { reporting } = getConfig();
  return {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  };
}

function scope(db: Db, appIds: string[]): string[] {
  return appIds.length > 0 ? appIds : resolveScopedAppIds(db);
}

export type CustomerStatus = 'paying' | 'trialing' | 'installed' | 'churned' | 'gone';

export interface CustomerSummary {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  activeSubscriptions: number;
  activeInstalls: number;
  lifetimeGross: number;
  lifetimeNet: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
}

export interface CustomerListResult {
  customers: CustomerSummary[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

interface SummaryRow {
  shopId: string;
  name: string | null;
  domain: string | null;
  mrr: number;
  currency: string | null;
  activeSubscriptions: number;
  onTrial: number;
  activeInstalls: number;
  lifetimeGross: number;
  lifetimeNet: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
}

function statusOf(row: SummaryRow, everSubscribed: number): CustomerStatus {
  if (row.activeSubscriptions > 0) return 'paying';
  if (row.onTrial > 0) return 'trialing';
  if (row.activeInstalls > 0) return 'installed';
  // No install and no live subscription. Distinguish a merchant who left after
  // paying from one who only ever installed, because they are different losses.
  return everSubscribed > 0 ? 'churned' : 'gone';
}

/**
 * Builds the per-shop aggregate. One statement rather than a query per shop,
 * because the list page renders a page of them at a time.
 *
 * `search` matches the merchant's display name or their myshopify domain, which
 * is how a support ticket or a Partner dashboard link identifies them.
 */
function summarySql(appIds: string[], searching: boolean): { sql: string; params: Record<string, unknown> } {
  const live = asOfPredicate(liveOptions(appIds), '@now');
  const appList = appIds.map((_, i) => `@sapp${i}`).join(', ');
  const appParams: Record<string, unknown> = {};
  appIds.forEach((id, i) => {
    appParams[`sapp${i}`] = id;
  });
  const inScope = appIds.length > 0 ? `IN (${appList})` : 'IS NOT NULL';

  return {
    params: { ...live.params, ...appParams },
    sql: `
      WITH matched AS (
        SELECT id, name, myshopify_domain
        FROM shops
        ${searching ? 'WHERE name LIKE @q OR myshopify_domain LIKE @q OR id = @exact' : ''}
      ),
      live_subs AS (
        SELECT s.shop_id AS shop_id,
               COALESCE(SUM(s.monthly_amount), 0) AS mrr,
               COUNT(s.charge_id) AS n,
               MAX(s.currency) AS currency
        FROM subscriptions s
        WHERE ${live.sql}
        GROUP BY s.shop_id
      ),
      trialing AS (
        SELECT shop_id, COUNT(*) AS n
        FROM subscriptions
        WHERE is_test = 0 AND app_id ${inScope}
          AND trial_status = 'in_trial'
          AND (churn_at IS NULL OR churn_at > @now)
        GROUP BY shop_id
      ),
      ever_subs AS (
        SELECT shop_id, COUNT(*) AS n
        FROM subscriptions
        WHERE is_test = 0 AND app_id ${inScope} AND conversion_at IS NOT NULL
        GROUP BY shop_id
      ),
      installs AS (
        SELECT shop_id, COUNT(DISTINCT app_id) AS n
        FROM install_intervals
        WHERE app_id ${inScope}
          AND started_at <= @now
          AND (ended_at IS NULL OR ended_at > @now)
        GROUP BY shop_id
      ),
      paid AS (
        SELECT shop_id,
               COALESCE(SUM(gross_amount), 0) AS gross,
               COALESCE(SUM(net_amount), 0) AS net,
               MAX(currency) AS currency
        FROM transactions
        WHERE app_id ${inScope}
        GROUP BY shop_id
      ),
      seen AS (
        SELECT shop_id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
        FROM customer_events
        WHERE suppressed = 0 AND app_id ${inScope}
        GROUP BY shop_id
      )
      SELECT m.id AS shopId,
             m.name AS name,
             m.myshopify_domain AS domain,
             COALESCE(ls.mrr, 0) AS mrr,
             COALESCE(ls.currency, p.currency) AS currency,
             COALESCE(ls.n, 0) AS activeSubscriptions,
             COALESCE(t.n, 0) AS onTrial,
             COALESCE(i.n, 0) AS activeInstalls,
             COALESCE(p.gross, 0) AS lifetimeGross,
             COALESCE(p.net, 0) AS lifetimeNet,
             COALESCE(es.n, 0) AS everSubscribed,
             se.first_at AS firstSeenAt,
             se.last_at AS lastEventAt
      FROM matched m
      LEFT JOIN live_subs ls ON ls.shop_id = m.id
      LEFT JOIN trialing t ON t.shop_id = m.id
      LEFT JOIN ever_subs es ON es.shop_id = m.id
      LEFT JOIN installs i ON i.shop_id = m.id
      LEFT JOIN paid p ON p.shop_id = m.id
      LEFT JOIN seen se ON se.shop_id = m.id
      -- A shop the feed never mentioned in scope is not a customer of these
      -- apps; it arrived on some other app's transaction.
      WHERE se.shop_id IS NOT NULL OR i.shop_id IS NOT NULL OR p.shop_id IS NOT NULL
    `,
  };
}

export type CustomerSort = 'mrr' | 'lifetime' | 'recent' | 'name';

const ORDER_BY: Record<CustomerSort, string> = {
  mrr: 'mrr DESC, lifetimeGross DESC, name ASC',
  lifetime: 'lifetimeGross DESC, mrr DESC, name ASC',
  recent: 'lastEventAt DESC, mrr DESC',
  name: 'name ASC, domain ASC',
};

export function listCustomers(options: {
  search?: string;
  limit?: number;
  offset?: number;
  sort?: CustomerSort;
  appIds?: string[];
} = {}): CustomerListResult {
  const db = getDb();
  const appIds = scope(db, options.appIds ?? []);
  const search = (options.search ?? '').trim();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  // `hasOwnProperty`, not a truthiness check: `sort=constructor` resolves
  // through Object.prototype, so the old test passed and a function's source
  // text was interpolated into the ORDER BY — a 500 on every such request.
  const asked = options.sort ?? 'mrr';
  const sort: CustomerSort = Object.prototype.hasOwnProperty.call(ORDER_BY, asked)
    ? asked
    : 'mrr';

  const built = summarySql(appIds, search.length > 0);
  const params: Record<string, unknown> = {
    ...built.params,
    now: new Date().toISOString(),
  };
  if (search.length > 0) {
    params.q = `%${search}%`;
    // A pasted shop id should find exactly one merchant, not every id containing it.
    params.exact = search;
  }

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM (${built.sql})`).get(params) as { n: number }
  ).n;

  const rows = db
    .prepare(`${built.sql} ORDER BY ${ORDER_BY[sort]} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset }) as Array<SummaryRow & { everSubscribed: number }>;

  return {
    customers: rows.map((row) => ({
      shopId: row.shopId,
      name: row.name,
      domain: row.domain,
      status: statusOf(row, row.everSubscribed),
      mrr: row.mrr,
      currency: row.currency,
      activeSubscriptions: row.activeSubscriptions,
      activeInstalls: row.activeInstalls,
      lifetimeGross: row.lifetimeGross,
      lifetimeNet: row.lifetimeNet,
      firstSeenAt: row.firstSeenAt,
      lastEventAt: row.lastEventAt,
    })),
    total,
    limit,
    offset,
    query: search,
  };
}

export interface CustomerSubscription {
  chargeId: string;
  appId: string;
  appName: string | null;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  currency: string | null;
  billingInterval: string;
  status: 'active' | 'trialing' | 'frozen' | 'churned' | 'replaced' | 'pending';
  activatedAt: string | null;
  conversionAt: string | null;
  churnAt: string | null;
  churnReason: string | null;
  trialStatus: string;
  trialEndsAt: string | null;
  paidSaleCount: number;
  lastSaleAt: string | null;
}

export interface CustomerEventRecord {
  eventId: string;
  type: string;
  occurredAt: string;
  appId: string;
  appName: string | null;
  chargeId: string;
  planName: string | null;
  planAmount: number | null;
  billingInterval: string | null;
  currency: string | null;
  netChange: number | null;
  amount: number | null;
  detail: Record<string, unknown> | null;
}

export interface CustomerDetail {
  shopId: string;
  name: string | null;
  domain: string | null;
  status: CustomerStatus;
  mrr: number;
  currency: string | null;
  lifetimeGross: number;
  lifetimeNet: number;
  paymentCount: number;
  firstSeenAt: string | null;
  lastEventAt: string | null;
  subscriptions: CustomerSubscription[];
  events: CustomerEventRecord[];
  /**
   * One row per app this merchant has ever had, whether or not they pay for it.
   *
   * The page used to lead with live subscriptions, which answered "what are
   * they paying for" and quietly dropped every app they installed and never
   * bought — the population most worth looking at on a customer's page.
   */
  apps: CustomerApp[];
}

/** The whole relationship with one app, on one line. */
export interface CustomerApp {
  appId: string;
  appName: string | null;
  /**
   * The app's App Store listing, when one is mapped. Present so the page can
   * offer a "write a review" link for a merchant who has not left one.
   */
  listingUrl: string | null;
  /** The plan in force, or the last one they held. */
  planName: string | null;
  /** The price as billed — 299 on an annual plan, not the normalized 24.92. */
  amount: number | null;
  billingInterval: string | null;
  currency: string | null;
  /** Normalized monthly, and zero unless a subscription is live right now. */
  mrr: number;
  /** The same five words the Customers list uses, scoped to this one app. */
  status: CustomerStatus;
  /** When this app first appeared for this merchant: install, else activation. */
  since: string | null;
  paymentCount: number;
  paidGross: number;
  /** What they said on the listing, if we have found it. */
  review: ReviewSummary | null;
}

interface SubDetailRow {
  chargeId: string;
  appId: string;
  appName: string | null;
  planName: string | null;
  amount: number;
  monthlyAmount: number;
  currency: string | null;
  billingInterval: string;
  activatedAt: string | null;
  conversionAt: string | null;
  churnAt: string | null;
  churnReason: string | null;
  frozenAt: string | null;
  unfrozenAt: string | null;
  trialStatus: string;
  trialEndsAt: string | null;
  paidSaleCount: number;
  lastSaleAt: string | null;
  isPlanChange: number;
}

function subscriptionStatus(
  row: SubDetailRow,
  isLive: boolean,
  now: string,
): CustomerSubscription['status'] {
  // A subscription the merchant swapped out of is not a subscription they
  // cancelled. Showing both as "cancelled" makes an afternoon of tier-shopping
  // read as four lost customers.
  if (row.isPlanChange === 1) return 'replaced';
  if (row.churnAt && row.churnAt <= now) return 'churned';
  const frozen =
    row.frozenAt && row.frozenAt <= now && (!row.unfrozenAt || row.unfrozenAt <= row.frozenAt);
  if (frozen) return 'frozen';
  if (isLive) return 'active';
  if (row.trialStatus === 'in_trial') return 'trialing';
  // Activated but never billed and never cancelled: it has not started earning.
  return 'pending';
}

/**
 * One row per app, folded together from the four things that know about it.
 *
 * The awkward part is that none of the sources agrees on which apps exist. A
 * merchant can pay for an app whose install predates `SYNC_START_DATE`, install
 * one they never pay for, and — through a manual link — have a review against
 * an app we have no other record of. Taking the union rather than driving off
 * any one table is what keeps all three on the page.
 */
function buildCustomerApps(input: {
  subs: SubDetailRow[];
  detailed: CustomerSubscription[];
  liveCharges: Set<string>;
  installs: Array<{ appId: string; since: string | null; liveNow: number }>;
  moneyByApp: Array<{ appId: string; paidGross: number; paymentCount: number }>;
  listingUrls: Map<string, string>;
  reviewsByApp: Map<string, ReviewSummary>;
  appNames: Map<string, string>;
}): CustomerApp[] {
  const { subs, detailed, liveCharges, installs, moneyByApp, listingUrls, reviewsByApp, appNames } =
    input;

  const installByApp = new Map(installs.map((row) => [row.appId, row]));
  const moneyByAppId = new Map(moneyByApp.map((row) => [row.appId, row]));
  const statusByCharge = new Map(detailed.map((row) => [row.chargeId, row.status]));

  const appIdsSeen = new Set<string>([
    ...installs.map((row) => row.appId),
    ...subs.map((row) => row.appId),
    ...moneyByApp.map((row) => row.appId),
    ...reviewsByApp.keys(),
  ]);

  const rows: CustomerApp[] = [];

  for (const appId of appIdsSeen) {
    // `subs` arrives newest first, so the first match is the current story and
    // the rest are the plan changes behind it.
    const forApp = subs.filter((row) => row.appId === appId);
    const current = forApp[0] ?? null;
    const live = forApp.find((row) => liveCharges.has(row.chargeId)) ?? null;
    const shown = live ?? current;

    const install = installByApp.get(appId);
    const money = moneyByAppId.get(appId);
    const review = reviewsByApp.get(appId) ?? null;

    // The same five words the Customers list uses, scoped to this one app, so a
    // merchant reading as "paying" overall cannot be a mystery when only one of
    // their three apps is what is paying.
    const status = statusOf(
      {
        shopId: '',
        name: null,
        domain: null,
        mrr: 0,
        currency: null,
        activeSubscriptions: live ? 1 : 0,
        onTrial: forApp.some((row) => statusByCharge.get(row.chargeId) === 'trialing') ? 1 : 0,
        activeInstalls: install?.liveNow === 1 ? 1 : 0,
        lifetimeGross: 0,
        lifetimeNet: 0,
        firstSeenAt: null,
        lastEventAt: null,
      },
      forApp.filter((row) => row.conversionAt !== null).length,
    );

    rows.push({
      appId,
      // An app they installed and never paid for has no subscription to carry
      // its name, which is exactly the row this table exists to show.
      appName: appNames.get(appId) ?? shown?.appName ?? review?.appName ?? null,
      listingUrl: listingUrls.get(appId) ?? null,
      planName: shown?.planName ?? null,
      amount: shown?.amount ?? null,
      billingInterval: shown?.billingInterval ?? null,
      currency: shown?.currency ?? null,
      // Only a live subscription contributes, on the same gate MRR itself uses:
      // the figure here and the figure in the MRR series are the same number.
      mrr: live ? live.monthlyAmount : 0,
      status,
      since: install?.since ?? shown?.activatedAt ?? null,
      paymentCount: money?.paymentCount ?? 0,
      paidGross: money?.paidGross ?? 0,
      review,
    });
  }

  // Paying apps first, then by what they have been worth: the top of this table
  // should be the part of the relationship worth protecting.
  const rank: Record<CustomerStatus, number> = {
    paying: 0,
    trialing: 1,
    installed: 2,
    churned: 3,
    gone: 4,
  };
  return rows.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      b.mrr - a.mrr ||
      b.paidGross - a.paidGross ||
      (a.appName ?? a.appId).localeCompare(b.appName ?? b.appId),
  );
}

export function getCustomer(
  shopId: string,
  options: { appIds?: string[]; eventLimit?: number } = {},
): CustomerDetail | null {
  const db = getDb();
  const appIds = scope(db, options.appIds ?? []);
  const now = new Date().toISOString();
  const eventLimit = Math.min(Math.max(options.eventLimit ?? 500, 1), 2000);

  const shop = db
    .prepare('SELECT id, name, myshopify_domain AS domain FROM shops WHERE id = ?')
    .get(shopId) as { id: string; name: string | null; domain: string | null } | undefined;
  if (!shop) return null;

  const appList = appIds.map((_, i) => `@dapp${i}`).join(', ');
  const appParams: Record<string, unknown> = {};
  appIds.forEach((id, i) => {
    appParams[`dapp${i}`] = id;
  });
  const inScope = appIds.length > 0 ? `IN (${appList})` : 'IS NOT NULL';

  // Liveness is decided by the shared as-of predicate rather than by re-reading
  // the dates here, so a subscription shown as active on this page is exactly a
  // subscription counted in MRR. Read as its own set instead of as a correlated
  // subquery, because the predicate is written against one fixed table alias.
  const live = asOfPredicate(liveOptions(appIds), '@now');
  const liveCharges = new Set(
    (
      db
        .prepare(
          `SELECT s.charge_id AS id FROM subscriptions s WHERE ${live.sql} AND s.shop_id = @shopId`,
        )
        .all({ ...live.params, shopId, now }) as Array<{ id: string }>
    ).map((row) => row.id),
  );

  const subs = db
    .prepare(
      `SELECT s.charge_id AS chargeId,
              s.app_id AS appId,
              a.name AS appName,
              s.plan_name AS planName,
              s.amount AS amount,
              s.monthly_amount AS monthlyAmount,
              s.currency AS currency,
              s.billing_interval AS billingInterval,
              s.activated_at AS activatedAt,
              s.conversion_at AS conversionAt,
              s.churn_at AS churnAt,
              s.churn_reason AS churnReason,
              s.frozen_at AS frozenAt,
              s.unfrozen_at AS unfrozenAt,
              s.trial_status AS trialStatus,
              s.trial_ends_at AS trialEndsAt,
              s.paid_sale_count AS paidSaleCount,
              s.last_sale_at AS lastSaleAt,
              s.is_plan_change AS isPlanChange
       FROM subscriptions s
       LEFT JOIN apps a ON a.id = s.app_id
       WHERE s.shop_id = @shopId AND s.is_test = 0 AND s.app_id ${inScope}
       ORDER BY COALESCE(s.activated_at, s.accepted_at) DESC`,
    )
    .all({ ...appParams, shopId }) as SubDetailRow[];

  const events = db
    .prepare(
      `SELECT e.event_id AS eventId,
              e.type AS type,
              e.occurred_at AS occurredAt,
              e.app_id AS appId,
              a.name AS appName,
              e.charge_id AS chargeId,
              e.plan_name AS planName,
              e.plan_amount AS planAmount,
              e.billing_interval AS billingInterval,
              e.currency AS currency,
              e.net_change AS netChange,
              e.amount AS amount,
              e.detail AS detail
       FROM customer_events e
       LEFT JOIN apps a ON a.id = e.app_id
       WHERE e.shop_id = @shopId AND e.suppressed = 0 AND e.app_id ${inScope}
       ORDER BY ${TIMELINE_ORDER} DESC, e.event_id DESC
       LIMIT @eventLimit`,
    )
    .all({ ...appParams, shopId, eventLimit }) as Array<
    Omit<CustomerEventRecord, 'detail'> & { detail: string | null }
  >;

  const money = db
    .prepare(
      `SELECT COALESCE(SUM(gross_amount), 0) AS gross,
              COALESCE(SUM(net_amount), 0) AS net,
              COUNT(*) AS n,
              MAX(currency) AS currency
       FROM transactions
       WHERE shop_id = @shopId AND app_id ${inScope}`,
    )
    .get({ ...appParams, shopId }) as {
    gross: number;
    net: number;
    n: number;
    currency: string | null;
  };

  /**
   * Installs per app: when the relationship started, and whether it is still on.
   *
   * `MIN(started_at)` rather than the current interval's start, because a
   * merchant who uninstalled for a fortnight in 2023 has been a customer since
   * they first arrived, not since they came back.
   */
  const installs = db
    .prepare(
      `SELECT i.app_id AS appId,
              MIN(i.started_at) AS since,
              MAX(CASE WHEN i.started_at <= @now AND (i.ended_at IS NULL OR i.ended_at > @now)
                       THEN 1 ELSE 0 END) AS liveNow
       FROM install_intervals i
       WHERE i.shop_id = @shopId AND i.app_id ${inScope}
       GROUP BY i.app_id`,
    )
    .all({ ...appParams, shopId, now }) as Array<{
    appId: string;
    since: string | null;
    liveNow: number;
  }>;

  /**
   * Money per app.
   *
   * Payments counts only charges, while the total nets refunds off — a merchant
   * who paid twice and was refunded once made two payments, not three, and is
   * out one payment's worth of money.
   */
  const moneyByApp = db
    .prepare(
      `SELECT app_id AS appId,
              COALESCE(SUM(gross_amount), 0) AS paidGross,
              COALESCE(SUM(CASE WHEN gross_amount > 0 THEN 1 ELSE 0 END), 0) AS paymentCount
       FROM transactions
       WHERE shop_id = @shopId AND app_id ${inScope}
       GROUP BY app_id`,
    )
    .all({ ...appParams, shopId }) as Array<{
    appId: string;
    paidGross: number;
    paymentCount: number;
  }>;

  const listings = db
    .prepare('SELECT app_id AS appId, url FROM app_listings')
    .all() as Array<{ appId: string; url: string }>;

  const appNames = db.prepare('SELECT id, name FROM apps').all() as Array<{
    id: string;
    name: string;
  }>;

  const reviewsByApp = new Map<string, ReviewSummary>();
  for (const review of reviewsForShop(shop.id)) {
    // The App Store allows one review per shop per app, but a manual link can
    // put a second against the pair. A review still on the listing wins over one
    // that is gone — a removal must not hide what a merchant is publicly saying
    // today — and the newest wins between two of the same kind.
    const held = reviewsByApp.get(review.appId);
    const better =
      !held ||
      (held.removedAt !== null && review.removedAt === null) ||
      (held.removedAt === null) === (review.removedAt === null) && review.postedOn > held.postedOn;
    if (better) reviewsByApp.set(review.appId, review);
  }

  const detailed: CustomerSubscription[] = subs.map((row) => ({
    chargeId: row.chargeId,
    appId: row.appId,
    appName: row.appName,
    planName: row.planName,
    amount: row.amount,
    monthlyAmount: row.monthlyAmount,
    currency: row.currency,
    billingInterval: row.billingInterval,
    status: subscriptionStatus(row, liveCharges.has(row.chargeId), now),
    activatedAt: row.activatedAt,
    conversionAt: row.conversionAt,
    churnAt: row.churnAt,
    churnReason: row.churnReason,
    trialStatus: row.trialStatus,
    trialEndsAt: row.trialEndsAt,
    paidSaleCount: row.paidSaleCount,
    lastSaleAt: row.lastSaleAt,
  }));

  const apps = buildCustomerApps({
    subs,
    detailed,
    liveCharges,
    installs,
    moneyByApp,
    listingUrls: new Map(listings.map((row) => [row.appId, row.url])),
    reviewsByApp,
    appNames: new Map(appNames.map((row) => [row.id, row.name])),
  });

  const mrr = subs.reduce(
    (sum, row) => sum + (liveCharges.has(row.chargeId) ? row.monthlyAmount : 0),
    0,
  );
  const activeSubscriptions = detailed.filter((row) => row.status === 'active').length;
  const onTrial = detailed.filter((row) => row.status === 'trialing').length;
  const everSubscribed = subs.filter((row) => row.conversionAt !== null).length;

  // Read the extremes from the whole history rather than from the capped page
  // of events, so a long-lived merchant does not appear to have arrived
  // whenever their 500th-most-recent event happened to land.
  const span = db
    .prepare(
      `SELECT MIN(occurred_at) AS firstAt, MAX(occurred_at) AS lastAt
       FROM customer_events
       WHERE shop_id = @shopId AND suppressed = 0 AND app_id ${inScope}`,
    )
    .get({ ...appParams, shopId }) as { firstAt: string | null; lastAt: string | null };

  return {
    shopId: shop.id,
    name: shop.name,
    domain: shop.domain,
    status: statusOf(
      {
        shopId: shop.id,
        name: shop.name,
        domain: shop.domain,
        mrr,
        currency: null,
        activeSubscriptions,
        onTrial,
        // `apps` now carries every app they have ever had, so the count of
        // *live* installs has to be taken rather than assumed from its length —
        // otherwise a merchant who uninstalled everything reads as installed.
        activeInstalls: installs.filter((row) => row.liveNow === 1).length,
        lifetimeGross: money.gross,
        lifetimeNet: money.net,
        firstSeenAt: null,
        lastEventAt: null,
      },
      everSubscribed,
    ),
    mrr,
    currency: subs[0]?.currency ?? money.currency,
    lifetimeGross: money.gross,
    lifetimeNet: money.net,
    paymentCount: money.n,
    firstSeenAt: span.firstAt,
    lastEventAt: span.lastAt,
    subscriptions: detailed,
    events: events.map((event) => ({
      ...event,
      detail: event.detail ? (JSON.parse(event.detail) as Record<string, unknown>) : null,
    })),
    apps,
  };
}

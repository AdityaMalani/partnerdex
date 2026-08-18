import { getDb, type Db } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * The review read model.
 *
 * Read straight from `app_reviews` with no as-of reconstruction, because unlike
 * every other list in this project a review is not a state that has to be
 * rebuilt from events — it is a document that was published on a date, possibly
 * rewritten, possibly taken down, and all three facts are columns.
 *
 * What this layer does add is the customer join, and the way it presents an
 * unmatched review. A review with no shop is shown as unmatched rather than
 * dropped or quietly attributed, because the partner reading the page is the
 * only one who can recognise a store name that our matcher could not.
 */

export type ReviewMatchMethod = 'auto' | 'manual' | 'ambiguous' | 'none';

export interface ReviewSummary {
  reviewId: string;
  appId: string;
  appName: string | null;
  rating: number;
  postedOn: string;
  body: string;
  storeName: string;
  country: string | null;
  usageDuration: string | null;
  replyBody: string | null;
  replyOn: string | null;
  permalink: string | null;
  /** Null when no customer is linked. */
  shopId: string | null;
  shopName: string | null;
  shopDomain: string | null;
  matchMethod: ReviewMatchMethod;
  /** The rating before the merchant last rewrote it, if they did. */
  priorRating: number | null;
  editedAt: string | null;
  /**
   * When a sweep first found this review gone. Null while it is still on the
   * listing. Says nothing about *who* removed it, because the listing does not.
   */
  removedAt: string | null;
  firstSeenAt: string;
}

export interface ReviewListResult {
  reviews: ReviewSummary[];
  total: number;
  limit: number;
  offset: number;
  query: string;
  /** Counts across the whole filtered scope, for the page's summary strip. */
  totals: {
    live: number;
    removed: number;
    unmatched: number;
    averageRating: number | null;
  };
}

interface ReviewRow {
  reviewId: string;
  appId: string;
  appName: string | null;
  rating: number;
  postedOn: string;
  body: string;
  storeName: string;
  country: string | null;
  usageDuration: string | null;
  replyBody: string | null;
  replyOn: string | null;
  permalink: string | null;
  shopId: string;
  shopName: string | null;
  shopDomain: string | null;
  matchMethod: string;
  priorRating: number | null;
  editedAt: string | null;
  removedAt: string | null;
  firstSeenAt: string;
}

const SELECT = `
  SELECT r.review_id      AS reviewId,
         r.app_id         AS appId,
         a.name           AS appName,
         r.rating         AS rating,
         r.posted_on      AS postedOn,
         r.body           AS body,
         r.store_name     AS storeName,
         r.country        AS country,
         r.usage_duration AS usageDuration,
         r.reply_body     AS replyBody,
         r.reply_on       AS replyOn,
         r.permalink      AS permalink,
         r.shop_id        AS shopId,
         s.name           AS shopName,
         s.myshopify_domain AS shopDomain,
         r.match_method   AS matchMethod,
         r.prior_rating   AS priorRating,
         r.edited_at      AS editedAt,
         r.removed_at     AS removedAt,
         r.first_seen_at  AS firstSeenAt
    FROM app_reviews r
    LEFT JOIN apps a ON a.id = r.app_id
    LEFT JOIN shops s ON s.id = r.shop_id AND r.shop_id <> ''`;

export type ReviewSort = 'newest' | 'oldest' | 'rating_low' | 'rating_high';

const ORDER_BY: Record<ReviewSort, string> = {
  // Ties broken on the id, which increases with time, so paging is stable
  // across the many reviews that share a posting date.
  newest: 'postedOn DESC, CAST(reviewId AS INTEGER) DESC',
  oldest: 'postedOn ASC, CAST(reviewId AS INTEGER) ASC',
  rating_low: 'rating ASC, postedOn DESC',
  rating_high: 'rating DESC, postedOn DESC',
};

export type ReviewStatusFilter = 'all' | 'live' | 'removed';
export type ReviewLinkFilter = 'all' | 'matched' | 'unmatched';

export interface ReviewListOptions {
  search?: string;
  appIds?: string[];
  /** A single star rating to filter to, or null for every rating. */
  rating?: number | null;
  status?: ReviewStatusFilter;
  linked?: ReviewLinkFilter;
  sort?: ReviewSort;
  limit?: number;
  offset?: number;
}

function scope(db: Db, appIds: string[]): string[] {
  return appIds.length > 0 ? appIds : resolveScopedAppIds(db);
}

function whereFor(options: ReviewListOptions, appIds: string[]): {
  sql: string;
  params: Record<string, unknown>;
} {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (appIds.length > 0) {
    const names = appIds.map((id, index) => {
      params[`app${index}`] = id;
      return `@app${index}`;
    });
    clauses.push(`r.app_id IN (${names.join(', ')})`);
  }

  const search = (options.search ?? '').trim();
  if (search) {
    // The store name as the listing spells it, the merchant's own words, and
    // the customer we linked them to — all three are ways a partner remembers
    // a review they are trying to find again.
    clauses.push('(r.store_name LIKE @q OR r.body LIKE @q OR s.name LIKE @q OR s.myshopify_domain LIKE @q)');
    params.q = `%${search}%`;
  }

  if (options.rating != null) {
    clauses.push('r.rating = @rating');
    params.rating = options.rating;
  }

  if (options.status === 'live') clauses.push('r.removed_at IS NULL');
  if (options.status === 'removed') clauses.push('r.removed_at IS NOT NULL');

  if (options.linked === 'matched') clauses.push("r.shop_id <> ''");
  if (options.linked === 'unmatched') clauses.push("r.shop_id = ''");

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listReviews(options: ReviewListOptions = {}): ReviewListResult {
  const db = getDb();
  const appIds = scope(db, options.appIds ?? []);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  // See `customers/index.ts` for why this is `hasOwnProperty` and not a
  // truthiness check on the lookup.
  const asked = options.sort ?? 'newest';
  const sort: ReviewSort = Object.prototype.hasOwnProperty.call(ORDER_BY, asked)
    ? asked
    : 'newest';

  const where = whereFor(options, appIds);

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM (${SELECT} ${where.sql})`)
      .get(where.params) as { n: number }
  ).n;

  const rows = db
    .prepare(`${SELECT} ${where.sql} ORDER BY ${ORDER_BY[sort]} LIMIT @limit OFFSET @offset`)
    .all({ ...where.params, limit, offset }) as ReviewRow[];

  // The summary strip ignores the status and link filters on purpose: it is the
  // thing a reader checks the filters *against*, so it has to describe the whole
  // set rather than the slice currently on screen.
  const scoped = whereFor(
    { search: options.search, appIds: options.appIds, rating: options.rating },
    appIds,
  );
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN removedAt IS NULL THEN 1 ELSE 0 END), 0) AS live,
         COALESCE(SUM(CASE WHEN removedAt IS NOT NULL THEN 1 ELSE 0 END), 0) AS removed,
         COALESCE(SUM(CASE WHEN shopId = '' THEN 1 ELSE 0 END), 0) AS unmatched,
         AVG(CASE WHEN removedAt IS NULL THEN rating END) AS averageRating
       FROM (${SELECT} ${scoped.sql})`,
    )
    .get(scoped.params) as {
    live: number;
    removed: number;
    unmatched: number;
    averageRating: number | null;
  };

  return {
    reviews: rows.map(toSummary),
    total,
    limit,
    offset,
    query: (options.search ?? '').trim(),
    totals: {
      ...totals,
      averageRating:
        totals.averageRating === null ? null : Math.round(totals.averageRating * 100) / 100,
    },
  };
}

function toSummary(row: ReviewRow): ReviewSummary {
  return {
    ...row,
    shopId: row.shopId || null,
    matchMethod: (row.matchMethod as ReviewMatchMethod) ?? 'none',
  };
}

/** Every review left by one merchant, for their customer page. */
export function reviewsForShop(shopId: string): ReviewSummary[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE r.shop_id = @shopId ORDER BY r.posted_on DESC`)
    .all({ shopId }) as ReviewRow[];
  return rows.map(toSummary);
}

/**
 * Shops a review could plausibly belong to, for the manual link picker.
 *
 * Ordered so the ones that installed the app being reviewed come first: the
 * reviewer is necessarily among them, and a partner scanning the list should
 * not have to wade past shops that could not have written it.
 */
export function linkCandidates(reviewId: string, search: string, limit = 20): Array<{
  shopId: string;
  name: string | null;
  domain: string | null;
  installedThisApp: boolean;
}> {
  const db = getDb();
  const review = db
    .prepare('SELECT app_id FROM app_reviews WHERE review_id = ?')
    .get(reviewId) as { app_id: string } | undefined;
  if (!review) return [];

  const term = search.trim();
  const rows = db
    .prepare(
      `SELECT s.id AS shopId,
              s.name AS name,
              s.myshopify_domain AS domain,
              EXISTS (
                SELECT 1 FROM install_intervals i
                 WHERE i.shop_id = s.id AND i.app_id = @appId
              ) AS installedThisApp
         FROM shops s
        WHERE (@q = '' OR s.name LIKE @like OR s.myshopify_domain LIKE @like OR s.id = @q)
        ORDER BY installedThisApp DESC, s.name ASC
        LIMIT @limit`,
    )
    .all({ appId: review.app_id, q: term, like: `%${term}%`, limit }) as Array<{
    shopId: string;
    name: string | null;
    domain: string | null;
    installedThisApp: number;
  }>;

  return rows.map((row) => ({ ...row, installedThisApp: Boolean(row.installedThisApp) }));
}

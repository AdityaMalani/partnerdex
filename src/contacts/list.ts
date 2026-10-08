import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { asOfPredicate, type AsOfOptions } from '../metrics/asof.js';
import { resolveScopedAppIds } from '../sync/index.js';
import type { ContactRole, MatchMethod } from './upsert.js';

/**
 * The contacts read model.
 *
 * People, not stores. Each row is one email from `contacts`, with the shops
 * they manage joined from `contact_shops` and each shop's live MRR taken from
 * the same as-of predicate the Customers list uses — so a contact's store MRR
 * is the same number that merchant contributes to the MRR series.
 *
 * Scope is app-shaped, the way everything else in this store is. A contact
 * linked only to an app outside reporting scope does not appear. A contact
 * with no `contact_shops` row at all does appear: those are the unlinked
 * people the importer kept on purpose, and the Unlinked filter is how a
 * human resolves them.
 */

export type ContactLinkedFilter = 'all' | 'unlinked' | 'ambiguous' | 'suppressed';
export type ContactSort =
  | 'name'
  | 'name_desc'
  | 'email'
  | 'mrr'
  | 'recent'
  | 'recent_asc'
  | 'created'
  | 'created_asc'
  | 'customer'
  | 'customer_desc';

export interface ContactShop {
  shopId: string;
  appId: string;
  name: string | null;
  domain: string | null;
  role: ContactRole;
  matchMethod: MatchMethod;
  mrr: number;
  currency: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface ContactSummary {
  email: string;
  firstName: string | null;
  lastName: string | null;
  isSuppressed: boolean;
  source: string;
  role: ContactRole | null;
  matchMethod: MatchMethod | null;
  shops: ContactShop[];
  /** The shop shown in the Customers column: owner first, then highest MRR. */
  primaryShop: ContactShop | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
}

export interface ContactListResult {
  contacts: ContactSummary[];
  total: number;
  limit: number;
  offset: number;
  query: string;
  totals: {
    all: number;
    unlinked: number;
    ambiguous: number;
    suppressed: number;
  };
}

export interface ShopCandidate {
  shopId: string;
  name: string | null;
  domain: string | null;
}

function liveOptions(appIds: string[]): AsOfOptions {
  const { reporting } = getConfig();
  return {
    appIds,
    includeAnnual: reporting.includeAnnual,
    includeTrials: reporting.includeTrials,
  };
}

function appInClause(
  appIds: string[],
  prefix: string,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  if (appIds.length === 0) return { sql: 'IS NOT NULL', params };
  const names = appIds.map((id, index) => {
    params[`${prefix}${index}`] = id;
    return `@${prefix}${index}`;
  });
  return { sql: `IN (${names.join(', ')})`, params };
}

/**
 * Reporting-scope membership, before the Unlinked / Ambiguous / Suppressed
 * slice and before search.
 *
 * `includeUnlinked` is on when the reader asked for every app in scope: an
 * unlinked person has no app_id to filter on, and dropping them would hide
 * the working surface the Unlinked filter exists to show. A single-app
 * picker turns it off, because "this app's contacts" cannot include people
 * with no membership at all.
 */
function inScopeSql(
  appIds: string[],
  includeUnlinked: boolean,
): { sql: string; params: Record<string, unknown> } {
  const apps = appInClause(appIds, 'scope');
  const unlinked = includeUnlinked
    ? `OR NOT EXISTS (SELECT 1 FROM contact_shops x WHERE x.email = c.email)`
    : '';
  return {
    params: apps.params,
    sql: `
      (
        EXISTS (
          SELECT 1 FROM contact_shops cs
           WHERE cs.email = c.email AND cs.app_id ${apps.sql}
        )
        ${unlinked}
      )
    `,
  };
}

function whereFor(
  options: {
    search?: string;
    linked?: ContactLinkedFilter;
    shopId?: string;
    includeUnlinked: boolean;
  },
  appIds: string[],
): { sql: string; params: Record<string, unknown> } {
  const scoped = inScopeSql(appIds, options.includeUnlinked);
  const clauses = [scoped.sql];
  const params: Record<string, unknown> = { ...scoped.params };
  const apps = appInClause(appIds, 'link');
  Object.assign(params, apps.params);

  const search = (options.search ?? '').trim();
  if (search) {
    // Name, email, and the store they belong to — three ways a partner
    // remembers a person they are trying to find again.
    clauses.push(`(
      c.email LIKE @q
      OR IFNULL(c.first_name, '') LIKE @q
      OR IFNULL(c.last_name, '') LIKE @q
      OR trim(IFNULL(c.first_name, '') || ' ' || IFNULL(c.last_name, '')) LIKE @q
      OR EXISTS (
        SELECT 1
          FROM contact_shops cs
          JOIN shops s ON s.id = cs.shop_id
         WHERE cs.email = c.email
           AND cs.app_id ${apps.sql}
           AND (s.name LIKE @q OR s.myshopify_domain LIKE @q OR s.id = @exact)
      )
    )`);
    params.q = `%${search}%`;
    params.exact = search;
  }

  if (options.shopId) {
    // One store's people, as its customer page lists them. Membership through
    // any app in scope, so a person linked under two apps shows once.
    clauses.push(`EXISTS (
      SELECT 1 FROM contact_shops cs
       WHERE cs.email = c.email
         AND cs.shop_id = @shopId
         AND cs.app_id ${apps.sql}
    )`);
    params.shopId = options.shopId;
  }

  if (options.linked === 'unlinked') {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM contact_shops cs
       WHERE cs.email = c.email AND cs.app_id ${apps.sql}
    )`);
  }
  if (options.linked === 'ambiguous') {
    clauses.push(`EXISTS (
      SELECT 1 FROM contact_shops cs
       WHERE cs.email = c.email
         AND cs.app_id ${apps.sql}
         AND cs.match_method = 'ambiguous'
    )`);
  }
  if (options.linked === 'suppressed') {
    clauses.push('c.is_suppressed = 1');
  }

  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

// A person with no first name shows their email in the Name column, so that
// email is the name key. Last name only breaks ties between the same first name.
const firstNameKey = `lower(CASE
           WHEN trim(IFNULL(c.first_name, '')) <> '' THEN c.first_name
           ELSE c.email
         END)`;
const lastNameKey = `lower(IFNULL(c.last_name, ''))`;

const ORDER_BY: Record<ContactSort, string> = {
  name: `${firstNameKey} ASC, ${lastNameKey} ASC, c.email ASC`,
  name_desc: `${firstNameKey} DESC, ${lastNameKey} DESC, c.email DESC`,
  email: 'c.email ASC',
  mrr: 'primaryMrr DESC, c.email ASC',
  recent: 'c.last_seen_at DESC, c.email ASC',
  recent_asc: 'c.last_seen_at ASC, c.email ASC',
  created: 'c.created_at DESC, c.email ASC',
  created_asc: 'c.created_at ASC, c.email ASC',
  // The Customers column shows one account. Order follows that account's name.
  // Role picks which account is shown when a person has several. It does not
  // order the page.
  customer: `CASE WHEN primaryName = '' THEN 1 ELSE 0 END ASC, lower(primaryName) ASC, c.email ASC`,
  customer_desc: `CASE WHEN primaryName = '' THEN 1 ELSE 0 END ASC, lower(primaryName) DESC, c.email ASC`,
};

interface ContactRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  isSuppressed: number;
  source: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  primaryMrr: number;
}

interface LinkRow {
  email: string;
  appId: string;
  shopId: string;
  role: string;
  matchMethod: string;
  shopName: string | null;
  shopDomain: string | null;
  mrr: number;
  currency: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

function toShop(row: LinkRow): ContactShop {
  return {
    shopId: row.shopId,
    appId: row.appId,
    name: row.shopName,
    domain: row.shopDomain,
    role: row.role as ContactRole,
    matchMethod: row.matchMethod as MatchMethod,
    mrr: row.mrr,
    currency: row.currency,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function rankShop(shop: ContactShop): number {
  if (shop.role === 'owner') return 0;
  if (shop.role === 'staff') return 1;
  return 2;
}

function sortShops(shops: ContactShop[]): ContactShop[] {
  return [...shops].sort(
    (a, b) =>
      rankShop(a) - rankShop(b) ||
      b.mrr - a.mrr ||
      (a.name ?? a.domain ?? a.shopId).localeCompare(b.name ?? b.domain ?? b.shopId),
  );
}

export function listContacts(
  options: {
    search?: string;
    linked?: ContactLinkedFilter;
    sort?: ContactSort;
    limit?: number;
    offset?: number;
    appIds?: string[];
    shopId?: string;
  } = {},
): ContactListResult {
  const db = getDb();
  const requested = (options.appIds ?? []).filter(Boolean);
  const scoped = resolveScopedAppIds(db);
  const appIds = requested.length > 0 ? requested.filter((id) => scoped.includes(id)) : scoped;
  const shopId = (options.shopId ?? '').trim() || undefined;
  // An unlinked person belongs to no store, so a store's list never has one.
  const includeUnlinked = requested.length === 0 && !shopId;
  const search = (options.search ?? '').trim();
  const linked = options.linked ?? 'all';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const sort = ORDER_BY[options.sort ?? 'name'] ? (options.sort ?? 'name') : 'name';

  const where = whereFor({ search, linked, shopId, includeUnlinked }, appIds);
  const live = asOfPredicate(liveOptions(appIds), '@now');
  const now = new Date().toISOString();
  const apps = appInClause(appIds, 'hyd');

  // The displayed Store MRR is the primary shop's figure. Sorting by that
  // same number (max live MRR among linked shops) keeps the column and the
  // order in agreement when a person manages more than one store.
  // primaryName is that same shop (owner, then highest MRR, then name) so a
  // Customers sort follows the account name on the row.
  const primaryNameSql = `
    COALESCE((
      SELECT COALESCE(NULLIF(trim(sh.name), ''), NULLIF(trim(sh.myshopify_domain), ''), cs.shop_id)
        FROM contact_shops cs
        LEFT JOIN shops sh ON sh.id = cs.shop_id
        LEFT JOIN (
          SELECT s.shop_id AS shop_id,
                 COALESCE(SUM(s.monthly_amount), 0) AS mrr
            FROM subscriptions s
           WHERE ${live.sql}
           GROUP BY s.shop_id
        ) ls ON ls.shop_id = cs.shop_id
       WHERE cs.email = c.email AND cs.app_id ${apps.sql}
       ORDER BY CASE cs.role WHEN 'owner' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END,
                COALESCE(ls.mrr, 0) DESC,
                lower(COALESCE(sh.name, sh.myshopify_domain, cs.shop_id))
       LIMIT 1
    ), '')
  `;
  const primaryMrrSql = `
    COALESCE((
      SELECT MAX(shop_mrr) FROM (
        SELECT COALESCE(SUM(s.monthly_amount), 0) AS shop_mrr
          FROM contact_shops cs
          LEFT JOIN subscriptions s
            ON s.shop_id = cs.shop_id AND ${live.sql}
         WHERE cs.email = c.email AND cs.app_id ${apps.sql}
         GROUP BY cs.shop_id
      )
    ), 0)
  `;
  const selectSql = `
    SELECT c.email AS email,
           c.first_name AS firstName,
           c.last_name AS lastName,
           c.is_suppressed AS isSuppressed,
           c.source AS source,
           c.first_seen_at AS firstSeenAt,
           c.last_seen_at AS lastSeenAt,
           c.created_at AS createdAt,
           ${primaryNameSql} AS primaryName,
           ${primaryMrrSql} AS primaryMrr
      FROM contacts c
      ${where.sql}
  `;

  const listParams = { ...where.params, ...live.params, ...apps.params, now };

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM contacts c ${where.sql}`).get(where.params) as {
      n: number;
    }
  ).n;

  const rows = db
    .prepare(`${selectSql} ORDER BY ${ORDER_BY[sort]} LIMIT @limit OFFSET @offset`)
    .all({ ...listParams, limit, offset }) as ContactRow[];

  const emails = rows.map((row) => row.email);
  const shopsByEmail = new Map<string, ContactShop[]>();
  if (emails.length > 0) {
    const emailNames = emails.map((_, index) => `@em${index}`);
    const emailParams: Record<string, unknown> = {};
    emails.forEach((email, index) => {
      emailParams[`em${index}`] = email;
    });

    const linkRows = db
      .prepare(
        `SELECT cs.email AS email,
                cs.app_id AS appId,
                cs.shop_id AS shopId,
                cs.role AS role,
                cs.match_method AS matchMethod,
                cs.first_seen_at AS firstSeenAt,
                cs.last_seen_at AS lastSeenAt,
                s.name AS shopName,
                s.myshopify_domain AS shopDomain,
                COALESCE(ls.mrr, 0) AS mrr,
                ls.currency AS currency
           FROM contact_shops cs
           LEFT JOIN shops s ON s.id = cs.shop_id
           LEFT JOIN (
             SELECT s.shop_id AS shop_id,
                    COALESCE(SUM(s.monthly_amount), 0) AS mrr,
                    MAX(s.currency) AS currency
               FROM subscriptions s
              WHERE ${live.sql}
              GROUP BY s.shop_id
           ) ls ON ls.shop_id = cs.shop_id
          WHERE cs.email IN (${emailNames.join(', ')})
            AND cs.app_id ${apps.sql}`,
      )
      .all({ ...emailParams, ...live.params, ...apps.params, now }) as LinkRow[];

    for (const row of linkRows) {
      const list = shopsByEmail.get(row.email) ?? [];
      list.push(toShop(row));
      shopsByEmail.set(row.email, list);
    }
  }

  const scopeWhere = whereFor({ includeUnlinked, shopId, linked: 'all' }, appIds);
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS allCount,
         COALESCE(SUM(CASE WHEN NOT EXISTS (
           SELECT 1 FROM contact_shops cs
            WHERE cs.email = c.email AND cs.app_id ${apps.sql}
         ) THEN 1 ELSE 0 END), 0) AS unlinked,
         COALESCE(SUM(CASE WHEN EXISTS (
           SELECT 1 FROM contact_shops cs
            WHERE cs.email = c.email
              AND cs.app_id ${apps.sql}
              AND cs.match_method = 'ambiguous'
         ) THEN 1 ELSE 0 END), 0) AS ambiguous,
         COALESCE(SUM(CASE WHEN c.is_suppressed = 1 THEN 1 ELSE 0 END), 0) AS suppressed
       FROM contacts c
       ${scopeWhere.sql}`,
    )
    .get({ ...scopeWhere.params, ...apps.params }) as {
    allCount: number;
    unlinked: number;
    ambiguous: number;
    suppressed: number;
  };

  return {
    contacts: rows.map((row) => {
      const shops = sortShops(shopsByEmail.get(row.email) ?? []);
      const primaryShop = shops[0] ?? null;
      return {
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        isSuppressed: row.isSuppressed === 1,
        source: row.source,
        role: primaryShop?.role ?? null,
        matchMethod: primaryShop?.matchMethod ?? (shops.length === 0 ? 'none' : null),
        shops,
        primaryShop,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
      };
    }),
    total,
    limit,
    offset,
    query: search,
    totals: {
      all: totals.allCount,
      unlinked: totals.unlinked,
      ambiguous: totals.ambiguous,
      suppressed: totals.suppressed,
    },
  };
}

/**
 * Shops offered when linking a contact by hand.
 *
 * Ordered by name. The partner recognises the store; we do not try to guess
 * which of several similarly-named shops they mean.
 */
export function shopCandidates(
  search: string,
  options: { limit?: number } = {},
): ShopCandidate[] {
  const db = getDb();
  const term = search.trim();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const rows = db
    .prepare(
      `SELECT s.id AS shopId,
              s.name AS name,
              s.myshopify_domain AS domain
         FROM shops s
        WHERE (@q = '' OR s.name LIKE @like OR s.myshopify_domain LIKE @like OR s.id = @q)
        ORDER BY s.name ASC
        LIMIT @limit`,
    )
    .all({ q: term, like: `%${term}%`, limit }) as ShopCandidate[];
  return rows;
}

import { getConfig, normalizeAppId } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import type { AsOfOptions } from './asof.js';
import { resolveWindow, type Window } from './time.js';

export class MetricRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'MetricRequestError';
  }
}

/** Raw query-string shape. Values arrive as strings and are validated here. */
export interface RawMetricQuery {
  period?: string;
  start?: string;
  end?: string;
  interval?: string;
  appIds?: string;
  includeAnnual?: string;
  includeUsage?: string;
  includeTrials?: string;
  byShop?: string;
  /** A single star rating, 1-5. Only the review reports read it. */
  rating?: string;
  nocache?: string;
}

function flag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  throw new MetricRequestError(`${name} must be true or false, got "${raw}".`);
}

export interface MetricContext {
  db: Db;
  window: Window;
  /** Apps this request reports on, already intersected with the org scope. */
  appIds: string[];
  asOf: AsOfOptions;
  includeUsage: boolean;
  byShop: boolean;
  churnWindowDays: number;
  planChangeWindowDays: number;
  currency: string | null;
  /** Visible buckets preceded by the hidden leading bucket. */
  bucketsWithLead: Window['buckets'];
  /**
   * Narrow the review reports to one star rating. Null means every rating.
   *
   * Deliberately not part of `asOf`: that predicate decides which subscriptions
   * were live at an instant and is shared by every money report, and a rating
   * has no business being anywhere near it.
   */
  rating: number | null;
}

export interface CurrencyProfile {
  currency: string | null;
  mixed: boolean;
}

/**
 * The cache key a currency profile is stored under.
 *
 * Sorted, because the scope is a *set*: `?appIds=a,b` and `?appIds=b,a` are the
 * same question and must not compute the answer twice.
 */
export function currencyProfileKey(appIds: string[]): string {
  return cacheKey('currency_profile', { scope: [...appIds].sort().join(',') });
}

/**
 * The dominant currency across recorded transactions. Partner payouts are
 * normally single-currency; if an org mixes them the reports would be summing
 * unlike units, so the mix is surfaced in `meta` rather than silently converted.
 *
 * This is the uncached form, and it is the most expensive statement on the
 * request path: `currency <> ''` matches nearly every row, so the answer costs a
 * pass over the whole transactions table however few currencies come back —
 * 1.8 s at 4.1M transactions, measured. `buildContext` calls it for *every*
 * metric, before the metric cache is even consulted and again for the
 * comparison window, which is what made a fully cached 23-metric dashboard load
 * take 42 s. Callers want `currencyProfile` below; this exists for the warm
 * pass, which computes every scope's answer in one go.
 */
export function computeCurrencyProfile(db: Db, appIds: string[]): CurrencyProfile {
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    params[`c${index}`] = id;
    return `@c${index}`;
  });
  const filter = names.length > 0 ? `AND app_id IN (${names.join(', ')})` : '';

  const rows = db
    .prepare(
      `SELECT currency, COUNT(*) AS n
       FROM transactions
       WHERE currency <> '' ${filter}
       GROUP BY currency
       ORDER BY n DESC`,
    )
    .all(params) as Array<{ currency: string; n: number }>;

  if (rows.length === 0) return { currency: null, mixed: false };
  return { currency: rows[0]!.currency, mixed: rows.length > 1 };
}

/**
 * The same answer, read through the metric cache.
 *
 * It belongs in that table rather than in a variable for the reason every other
 * figure does: the cache is cleared by the rebuild at the end of each sync, so
 * the profile is invalidated by exactly the event that can change it — new
 * transactions — and by nothing else. A process-local memo would additionally
 * have to survive the fact that the sync runs in a *different* process, and
 * could not be warmed from there.
 *
 * A miss falls through to the scan, so a database that has never been synced,
 * or one running with the cache disabled, still answers correctly. It is slow
 * exactly once per sync, and `warmCurrencyProfiles` moves even that off the
 * request path.
 */
export function currencyProfile(db: Db, appIds: string[]): CurrencyProfile {
  const key = currencyProfileKey(appIds);
  const cached = readCache<CurrencyProfile>(db, key);
  if (cached) return cached;

  const profile = computeCurrencyProfile(db, appIds);
  writeCache(db, key, profile);
  return profile;
}

/**
 * Fill the cache for the scopes the dashboard actually asks for, in one pass.
 *
 * Called by the sync, in the sync's own process, immediately after the rebuild
 * has cleared the cache — so the first dashboard request after a sync reads a
 * stored answer instead of paying for a full table scan on the request thread
 * of a single-threaded server.
 *
 * One `GROUP BY app_id, currency` covers every scope worth warming: the whole
 * scope (what an unfiltered dashboard asks for) and each app on its own (what
 * the app picker asks for). A reader who selects some other combination still
 * gets a correct answer the slow way.
 */
export function warmCurrencyProfiles(db: Db, appIds: string[]): number {
  const rows = db
    .prepare(
      `SELECT app_id, currency, COUNT(*) AS n
         FROM transactions
        WHERE currency <> ''
        GROUP BY app_id, currency`,
    )
    .all() as Array<{ app_id: string; currency: string; n: number }>;

  const profileOf = (scope: string[]): CurrencyProfile => {
    const totals = new Map<string, number>();
    for (const row of rows) {
      if (scope.length > 0 && !scope.includes(row.app_id)) continue;
      totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.n);
    }
    // Highest count wins, and ties keep the order SQLite returned — the same
    // rule `computeCurrencyProfile`'s `ORDER BY n DESC` applies.
    let best: string | null = null;
    let bestCount = 0;
    for (const [currency, n] of totals) {
      if (n > bestCount) {
        best = currency;
        bestCount = n;
      }
    }
    return { currency: best, mixed: totals.size > 1 };
  };

  // Deduplicated by key, because a partner with one app in scope asks the same
  // question twice: "every app" and "that app" are the same set.
  const scopes = new Map<string, string[]>();
  for (const scope of [appIds, ...appIds.map((id) => [id])]) {
    scopes.set(currencyProfileKey(scope), scope);
  }
  for (const [key, scope] of scopes) writeCache(db, key, profileOf(scope));
  return scopes.size;
}

export function buildContext(query: RawMetricQuery, now?: Date): MetricContext {
  const db = getDb();
  const { runtime, scope, reporting } = getConfig();

  const inScope = resolveScopedAppIds(db);
  let appIds = inScope;

  if (query.appIds) {
    const requested = query.appIds
      .split(',')
      .map((part) => normalizeAppId(part))
      .filter(Boolean);
    // Permission gate at the scope layer, not only inside the query: asking for
    // an app outside the configured scope is an error, not an empty result.
    const outside = requested.filter((id) => !inScope.includes(id));
    if (outside.length > 0) {
      throw new MetricRequestError(
        `Requested app id(s) outside the configured reporting scope: ${outside.join(', ')}.`,
        403,
      );
    }
    appIds = requested;
  }

  const window = resolveWindow({
    period: query.period,
    start: query.start,
    end: query.end,
    interval: query.interval,
    timeZone: runtime.timezone,
    allTimeStart: scope.syncStartDate,
    now,
  });

  const asOf: AsOfOptions = {
    appIds,
    includeAnnual: flag(query.includeAnnual, reporting.includeAnnual, 'includeAnnual'),
    includeTrials: flag(query.includeTrials, reporting.includeTrials, 'includeTrials'),
  };

  const { currency } = currencyProfile(db, appIds);

  return {
    db,
    window,
    appIds,
    asOf,
    includeUsage: flag(query.includeUsage, reporting.includeUsage, 'includeUsage'),
    byShop: flag(query.byShop, reporting.byShop, 'byShop'),
    churnWindowDays: reporting.churnWindowDays,
    planChangeWindowDays: reporting.planChangeWindowDays,
    currency,
    bucketsWithLead: [window.leading, ...window.buckets],
    rating: ratingFilter(query.rating),
  };
}

/** A star rating to narrow the review reports to, or null for all of them. */
function ratingFilter(raw: string | undefined): number | null {
  if (raw === undefined || raw === '' || raw === '0') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new MetricRequestError(`rating must be a whole number from 1 to 5, got "${raw}".`);
  }
  return value;
}

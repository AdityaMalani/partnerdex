import { getDb, type Db } from '../db/index.js';
import { AffiliateAdminError } from './admin.js';

/**
 * How a click becomes a referral, as data.
 *
 * These five values were code constants: `REFERRAL_WINDOW_DAYS = 30`, a
 * first-touch rule implicit in a comparison, the parameter list
 * `['mref','utm_source','ref']`, the host allowlist `apps.shopify.com`, and a
 * competing-claim policy that was not expressed anywhere because an operator
 * decided by hand. Four of them are genuine business rules, and a business rule
 * compiled into a file is one a fresh install cannot have an opinion about.
 *
 * ## Instance-wide, not per programme
 *
 * A click is a URL on a listing page. Which programme it belongs to is only
 * known *after* the handle resolves, and two programmes can share an app — so a
 * per-programme window would mean two programmes disagreeing about one click
 * with no principled tie-break. The parameter names and the host allowlist are
 * properties of the tracking setup rather than of anybody's terms.
 *
 * ## Changing these does not restate attributions
 *
 * An attribution is a durable fact with money already computed from it, so a
 * settings change applies to the next pipeline run and nothing already credited
 * moves. This is the opposite decision from programme terms, and for the
 * opposite reason: terms are a *rule* that prices a charge, and attribution is a
 * *finding* about something that happened. Re-deriving a past finding under a
 * new rule would move referrals between affiliates, which is the one thing
 * `persistAttribution` refuses to do even when it has better evidence.
 */

export type TouchRule = 'first' | 'last';

export interface AttributionSettings {
  touch: TouchRule;
  windowDays: number;
  /** In precedence order. The order *is* the rule. */
  parameters: string[];
  /** Hosts a click may be counted from. A trust boundary; see below. */
  clickHosts: string[];
  /** One value today. The field exists so a second policy has somewhere to go. */
  conflictPolicy: 'manual_review';
}

export const DEFAULT_ATTRIBUTION_SETTINGS: AttributionSettings = {
  touch: 'first',
  windowDays: 30,
  parameters: ['mref', 'utm_source', 'ref'],
  clickHosts: ['apps.shopify.com'],
  conflictPolicy: 'manual_review',
};

const MAX_WINDOW_DAYS = 365;

function parseList(raw: unknown, fallback: string[]): string[] {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (Array.isArray(parsed)) {
      const entries = parsed.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
      if (entries.length > 0) return entries;
    }
  } catch {
    // A column that will not parse falls back to the compiled default rather
    // than to an empty list. Empty is the dangerous reading: no parameters
    // means no click ever carries a handle, and the pipeline would report a
    // clean run that attributed nothing.
  }
  return fallback;
}

export function readAttributionSettings(db: Db = getDb()): AttributionSettings {
  const row = db
    .prepare(
      `SELECT touch, window_days AS windowDays, parameters, click_hosts AS clickHosts,
              conflict_policy AS conflictPolicy
         FROM affiliate_attribution_settings WHERE id = 1`,
    )
    .get() as Record<string, unknown> | undefined;

  // No row is the normal state for an instance that has never opened the
  // screen, and it means the defaults — which are exactly the constants this
  // replaced, so behaviour is unchanged until somebody chooses otherwise.
  if (!row) return { ...DEFAULT_ATTRIBUTION_SETTINGS };

  const windowDays = Number(row.windowDays);
  return {
    touch: row.touch === 'last' ? 'last' : 'first',
    windowDays:
      Number.isFinite(windowDays) && windowDays > 0 && windowDays <= MAX_WINDOW_DAYS
        ? Math.trunc(windowDays)
        : DEFAULT_ATTRIBUTION_SETTINGS.windowDays,
    parameters: parseList(row.parameters, DEFAULT_ATTRIBUTION_SETTINGS.parameters),
    clickHosts: parseList(row.clickHosts, DEFAULT_ATTRIBUTION_SETTINGS.clickHosts),
    conflictPolicy: 'manual_review',
  };
}

/** A URL query parameter name: what can appear before `=` and be matched safely. */
function checkParameter(raw: unknown): string {
  const value = String(raw ?? '').trim();
  // Interpolated into a regex on the TypeScript side and into a BigQuery
  // pattern on the SQL side, so the shape is a security property and not a
  // tidiness one. Letters, digits, underscore and hyphen have no meaning in
  // either syntax; anything else could change what the pattern matches.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new AffiliateAdminError(
      `"${value}" is not a usable query parameter name. Use letters, digits, ` +
        `underscore or hyphen.`,
    );
  }
  return value;
}

/** A bare hostname. No scheme, no path, no port. */
function checkHost(raw: unknown): string {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/.test(value) || !value.includes('.')) {
    throw new AffiliateAdminError(
      `"${value}" is not a hostname. Give the host alone, such as apps.example.com.`,
    );
  }
  return value;
}

export function updateAttributionSettings(
  input: Record<string, unknown>,
  db: Db = getDb(),
): AttributionSettings {
  const current = readAttributionSettings(db);
  const has = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;

  let touch = current.touch;
  if (has('touch')) {
    if (input.touch !== 'first' && input.touch !== 'last') {
      throw new AffiliateAdminError(`"touch" must be "first" or "last".`);
    }
    touch = input.touch;
  }

  let windowDays = current.windowDays;
  if (has('windowDays')) {
    const parsed = Number(input.windowDays);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
      throw new AffiliateAdminError(
        `"windowDays" must be a whole number of days between 1 and ${MAX_WINDOW_DAYS}.`,
      );
    }
    windowDays = parsed;
  }

  let parameters = current.parameters;
  if (has('parameters')) {
    if (!Array.isArray(input.parameters) || input.parameters.length === 0) {
      throw new AffiliateAdminError(
        `"parameters" must be a non-empty list, in precedence order. With none, no click ` +
          `carries a handle and nothing is ever attributed.`,
      );
    }
    parameters = input.parameters.map(checkParameter);
  }

  let clickHosts = current.clickHosts;
  if (has('clickHosts')) {
    if (!Array.isArray(input.clickHosts) || input.clickHosts.length === 0) {
      throw new AffiliateAdminError(
        `"clickHosts" must name at least one host. It is a trust boundary: a GA4 ` +
          `measurement id is public, and without it any site that mirrors your listing ` +
          `page and its tag can award itself commissions with a made-up code.`,
      );
    }
    clickHosts = input.clickHosts.map(checkHost);
  }

  db.prepare(
    `INSERT INTO affiliate_attribution_settings
       (id, touch, window_days, parameters, click_hosts, conflict_policy, updated_at)
     VALUES (1, @touch, @windowDays, @parameters, @clickHosts, 'manual_review', @now)
     ON CONFLICT(id) DO UPDATE SET
       touch = excluded.touch,
       window_days = excluded.window_days,
       parameters = excluded.parameters,
       click_hosts = excluded.click_hosts,
       updated_at = excluded.updated_at`,
  ).run({
    touch,
    windowDays,
    parameters: JSON.stringify(parameters),
    clickHosts: JSON.stringify(clickHosts),
    now: new Date().toISOString(),
  });

  return readAttributionSettings(db);
}

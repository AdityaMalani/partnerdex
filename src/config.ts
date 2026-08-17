import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

loadDotenv();

export class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${value}".`);
}

function int(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name} must be a number, got "${value}".`);
  return Math.trunc(parsed);
}

/** An interval or count that a negative value would make meaningless. */
function nonNegative(name: string, fallback: number): number {
  const value = int(name, fallback);
  if (value < 0) throw new ConfigError(`${name} must be zero or greater, got "${value}".`);
  return value;
}

/**
 * App ids may be given as bare numbers or full gids. Everything downstream
 * stores and compares the numeric portion, so normalize on the way in.
 */
export function normalizeAppId(raw: string): string {
  const trimmed = raw.trim();
  const tail = trimmed.split('/').pop() ?? trimmed;
  return tail;
}

function appIds(): string[] {
  const raw = process.env.PARTNER_APP_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeAppId(part))
    .filter((part) => part.length > 0);
}

/**
 * App id → App Store listing handle, as an optional *seed* for `app_listings`.
 *
 * The mapping itself lives in the database and is entered in the dashboard: an
 * organization has many apps, the Partner API will not say which listing any of
 * them is published under, and that is a fact the partner knows and may change
 * on any given day — not a deployment concern.
 *
 * This variable stays supported so a container coming up on an empty volume can
 * sync before anyone opens the UI. It only fills in apps that have no row yet;
 * see `seedListingsFromConfig`.
 */
function appStoreHandles(): Record<string, string> {
  const raw = process.env.APP_STORE_HANDLES?.trim();
  if (!raw) return {};

  const handles: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const pair = entry.trim();
    if (!pair) continue;

    const separator = pair.indexOf(':');
    if (separator < 0) {
      throw new ConfigError(
        `APP_STORE_HANDLES entries must be "<appId>:<handle>", got "${pair}".`,
      );
    }

    const appId = normalizeAppId(pair.slice(0, separator));
    const handle = pair.slice(separator + 1).trim();

    if (!appId) throw new ConfigError(`APP_STORE_HANDLES entry "${pair}" has no app id.`);
    // The slug as it appears in the listing URL — letters, digits, hyphens. A
    // full URL pasted in here would otherwise be silently glued onto the host
    // and 404 on every crawl.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(handle)) {
      throw new ConfigError(
        `APP_STORE_HANDLES handle for app ${appId} must be the slug from ` +
          `apps.shopify.com/<handle>, got "${handle}".`,
      );
    }
    handles[appId] = handle.toLowerCase();
  }
  return handles;
}

/**
 * One Shopify Partner organization and the credential that opens it.
 *
 * The organization id is part of the endpoint *path*, not a header, so the
 * endpoint is per-org and there is no such thing as an org-agnostic Partner API
 * call. That is why this object — not a bare id — is what gets passed around:
 * a caller holding a `PartnerOrg` cannot pair one org's id with another's token.
 */
export interface PartnerOrg {
  organizationId: string;
  token: string;
  /** Human label for logs and the doctor output; defaults to the id. */
  label: string;
  apiVersion: string;
  endpoint: string;
}

/** The one place the endpoint URL template exists. */
export function endpointFor(organizationId: string, apiVersion: string): string {
  return `https://partners.shopify.com/${organizationId}/api/${apiVersion}/graphql.json`;
}

function apiVersion(): string {
  const value = optional('PARTNER_API_VERSION', '2026-07');
  if (!/^(\d{4}-\d{2}|unstable)$/.test(value)) {
    throw new ConfigError(`PARTNER_API_VERSION must be YYYY-MM or "unstable", got "${value}".`);
  }
  return value;
}

/**
 * Every organization named by the environment, in priority order. May be empty.
 *
 * This list is the **seed**, not the answer. Organizations live in the
 * `organizations` table now; `getDb()` inserts anything here that the table does
 * not already have, and the table wins from then on — see
 * `seedOrganizationsFromEnv`. Everything that opens a Partner endpoint reads
 * `activeOrgs()`, never this.
 *
 * Empty is legal, and that is the change an existing deployment cannot see but a
 * new one depends on: an install with no secrets set has to boot far enough to
 * serve the page you add an organization on. The old refusal — "Missing required
 * environment variable PARTNER_ORGANIZATION_ID" at `getConfig()` — has moved to
 * where the question can actually be answered, which is after the table has been
 * consulted. `requireOrgs()` in the sync raises it there, with the same advice.
 *
 * Two forms, and they **combine** rather than override, because the combination
 * is the migration path:
 *
 *   1. `PARTNER_ORGANIZATION_ID` + `PARTNER_API_TOKEN` — the original pair.
 *      Still supported, still first in the list, still the source of the same
 *      error message when nothing at all is configured. An existing deployment
 *      changes no variable it already has.
 *   2. `PARTNER_ORG_<n>_ID` + `PARTNER_ORG_<n>_TOKEN` (+ optional
 *      `PARTNER_ORG_<n>_LABEL`) for any positive integer n.
 *
 * So adding a second organization to a running instance is exactly two new
 * secrets and nothing removed — `fly secrets set PARTNER_ORG_2_ID=...
 * PARTNER_ORG_2_TOKEN=...`. Indexed variables rather than one
 * `PARTNER_ORGS="id:token,id:token"` list for three reasons: `fly secrets set`
 * takes one name-value pair at a time, so rotating org B's token would
 * otherwise mean re-pasting org A's; a token is never a substring of a larger
 * value that some log line might print whole; and there is no delimiter for a
 * token to collide with.
 *
 * The indices are *scanned*, not counted up from 1, so deleting
 * `PARTNER_ORG_2_*` and leaving `PARTNER_ORG_3_*` in place drops one org
 * instead of silently dropping two.
 *
 * Order matters beyond cosmetics: `orgs[0]` is what the `apps.org_id` migration
 * backfills existing rows to. With the legacy pair present it is the legacy
 * org, which is by definition the only org those rows can have come from.
 */
function partnerOrgs(version: string): PartnerOrg[] {
  const orgs: PartnerOrg[] = [];
  const seen = new Map<string, string>();

  const add = (rawId: string, token: string, label: string, source: string): void => {
    const organizationId = normalizeAppId(rawId);
    if (!/^\d+$/.test(organizationId)) {
      throw new ConfigError(
        `${source} must be the numeric organization id from the Partner dashboard URL, ` +
          `got "${rawId}".`,
      );
    }
    if (!token) {
      throw new ConfigError(`Organization ${organizationId} (${source}) has no access token.`);
    }
    const previous = seen.get(organizationId);
    if (previous) {
      throw new ConfigError(
        `Organization ${organizationId} is configured twice, by ${previous} and ${source}. ` +
          `Two entries for one org would sync it twice and fight over its watermarks.`,
      );
    }
    seen.set(organizationId, source);
    orgs.push({
      organizationId,
      token,
      label: label || organizationId,
      apiVersion: version,
      endpoint: endpointFor(organizationId, version),
    });
  };

  const legacyId = process.env.PARTNER_ORGANIZATION_ID?.trim();
  if (legacyId) {
    add(
      legacyId,
      required('PARTNER_API_TOKEN'),
      process.env.PARTNER_ORG_LABEL?.trim() ?? '',
      'PARTNER_ORGANIZATION_ID',
    );
  }

  const indices = Object.keys(process.env)
    .map((name) => /^PARTNER_ORG_(\d+)_ID$/.exec(name)?.[1])
    .filter((index): index is string => Boolean(index))
    .map(Number)
    .sort((a, b) => a - b);

  for (const index of indices) {
    const id = process.env[`PARTNER_ORG_${index}_ID`]?.trim();
    if (!id) continue;
    add(
      id,
      required(`PARTNER_ORG_${index}_TOKEN`),
      process.env[`PARTNER_ORG_${index}_LABEL`]?.trim() ?? '',
      `PARTNER_ORG_${index}_ID`,
    );
  }

  return orgs;
}

/**
 * The dashboard password, or null when the gate is off.
 *
 * A short password is worse than none, because it invites exposing the port on
 * the strength of it. Eight characters is not a policy, only a floor — and it
 * fails at startup rather than at the first login attempt.
 */
function dashboardPassword(): string | null {
  const value = process.env.DASHBOARD_PASSWORD ?? '';
  if (!value) return null;
  if (value.length < 8) {
    throw new ConfigError(
      `DASHBOARD_PASSWORD must be at least 8 characters. Leave it empty to run without a login.`,
    );
  }
  return value;
}

/** `:memory:` is passed through verbatim; anything else is a real file path. */
function databasePath(): string {
  const raw = optional('DATABASE_PATH', './data/partnerdex.db');
  return raw === ':memory:' ? raw : path.resolve(raw);
}

function isoDate(name: string, fallback: string): string {
  const value = optional(name, fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ConfigError(`${name} must be a YYYY-MM-DD date, got "${value}".`);
  }
  return value;
}

function timezone(name: string, fallback: string): string {
  const value = optional(name, fallback);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new ConfigError(`${name} must be a valid IANA timezone, got "${value}".`);
  }
  return value;
}

export interface ReportingDefaults {
  includeAnnual: boolean;
  includeUsage: boolean;
  includeTrials: boolean;
  /** Count distinct shops rather than distinct charges in ARPU/churn populations. */
  byShop: boolean;
  trialMinGapDays: number;
  churnWindowDays: number;
  churnOnUninstall: boolean;
  planChangeWindowDays: number;
}

export interface Config {
  partner: {
    apiVersion: string;
    /**
     * The organizations the *environment* names, which is the bootstrap path
     * and nothing more. May be empty. The live set is `activeOrgs()`, read from
     * the `organizations` table.
     *
     * There is deliberately no `organizationId`/`token`/`endpoint` beside this.
     * A convenience "default org" on the config object is exactly the silent
     * fallback this whole change exists to remove: a caller that forgot to say
     * which org it meant would keep compiling and write one org's data under
     * the other org's app.
     */
    orgs: PartnerOrg[];
  };
  auth: {
    /**
     * Null when `DASHBOARD_PASSWORD` is unset, which leaves the API open — the
     * behaviour every existing localhost install already has. Setting it turns
     * the gate on; nothing else has to change.
     */
    password: string | null;
  };
  scope: {
    appIds: string[];
    syncStartDate: string;
    /**
     * App id → App Store listing handle. Empty means review tracking is off,
     * because there is no way to guess an app's listing slug from the API.
     */
    appStoreHandles: Record<string, string>;
  };
  runtime: {
    databasePath: string;
    port: number;
    timezone: string;
    cacheTtlSeconds: number;
    /** Cadence of the background sync loop in `serve`. 0 disables it. */
    syncIntervalMinutes: number;
    /**
     * How often to walk every page of a listing rather than just the newest.
     *
     * Only a full walk can notice a review that is *gone*, and a full walk costs
     * a request per ten reviews. A change in the listing's own review count
     * forces one early regardless, so this is the ceiling on how long a removal
     * can sit unnoticed while the count happens to stay level.
     */
    reviewSweepHours: number;
    /**
     * How old an event may be and still be worth announcing.
     *
     * The delivery ledger stops anything being said twice, but it cannot stop
     * something being said *late*. Two things produce a backlog of undelivered
     * history: an instance that was down for a while, and a release that adds
     * event types to a topic a channel already subscribes to — the watermark is
     * per topic, so widening one silently reclassifies months of past events as
     * unsent news. Neither is worth a hundred pings about merchants who came and
     * went weeks ago.
     *
     * Set to 0 to announce a backlog however old.
     */
    notificationMaxAgeHours: number;
    /**
     * Whether a reverse proxy terminates TLS in front of this process.
     *
     * Off by default because it is only safe when something really is in front:
     * it makes Express believe `X-Forwarded-For` and `X-Forwarded-Proto`, and a
     * directly-reachable server would let any client forge both — spoofing a
     * fresh IP per request to walk around the login lockout, which keys on it.
     */
    trustProxy: boolean;
  };
  reporting: ReportingDefaults;
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  const version = apiVersion();

  cached = {
    partner: {
      apiVersion: version,
      orgs: partnerOrgs(version),
    },
    auth: {
      password: dashboardPassword(),
    },
    scope: {
      appIds: appIds(),
      syncStartDate: isoDate('SYNC_START_DATE', '2015-01-01'),
      appStoreHandles: appStoreHandles(),
    },
    runtime: {
      databasePath: databasePath(),
      port: int('PORT', 8787),
      timezone: timezone('REPORTING_TIMEZONE', 'UTC'),
      cacheTtlSeconds: int('CACHE_TTL_SECONDS', 600),
      syncIntervalMinutes: nonNegative('SYNC_INTERVAL_MINUTES', 5),
      reviewSweepHours: nonNegative('REVIEW_SWEEP_HOURS', 24),
      notificationMaxAgeHours: nonNegative('NOTIFICATION_MAX_AGE_HOURS', 24),
      trustProxy: bool('TRUST_PROXY', false),
    },
    reporting: {
      includeAnnual: bool('METRICS_INCLUDE_ANNUAL', true),
      includeUsage: bool('METRICS_INCLUDE_USAGE', true),
      includeTrials: bool('METRICS_INCLUDE_TRIALS', false),
      byShop: bool('METRICS_BY_SHOP', true),
      trialMinGapDays: int('TRIAL_MIN_GAP_DAYS', 2),
      churnWindowDays: int('CHURN_WINDOW_DAYS', 30),
      churnOnUninstall: bool('CHURN_ON_UNINSTALL', true),
      planChangeWindowDays: int('PLAN_CHANGE_WINDOW_DAYS', 2),
    },
  };

  return cached;
}

/**
 * The primary environment organization — `orgs[0]` — or null when the
 * environment names none.
 *
 * Exactly one thing is allowed to use this: the `apps.org_id` backfill, which
 * is answering "which org did the rows in this database, synced when only one
 * org could be configured, come from?". It is not a default for API calls. Use
 * `activeOrg` when you have an id, and take a `PartnerOrg` parameter otherwise.
 *
 * Null is a real answer now that the environment is optional, and the backfill
 * handles it by leaving the column blank rather than guessing — see `migrate()`.
 */
export function primaryEnvOrg(): PartnerOrg | null {
  return getConfig().partner.orgs[0] ?? null;
}

/** The same, for callers that treat "no environment organization" as an error. */
export function getPrimaryOrg(): PartnerOrg {
  const first = primaryEnvOrg();
  if (!first) throw new ConfigError('No Shopify Partner organization is configured.');
  return first;
}

/** Credentials for a known *environment* organization id, refused rather than guessed. */
export function getOrg(organizationId: string): PartnerOrg {
  const match = getConfig().partner.orgs.find(
    (org) => org.organizationId === organizationId,
  );
  if (!match) {
    throw new ConfigError(
      `No credentials configured for Shopify Partner organization ${organizationId}. ` +
        `Set PARTNER_ORG_<n>_ID and PARTNER_ORG_<n>_TOKEN for it.`,
    );
  }
  return match;
}

/** Test seam: drop the memoized config so a new environment can be read. */
export function resetConfig(): void {
  cached = null;
}

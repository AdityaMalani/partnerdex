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

/**
 * Shared secret for POST /api/contacts/ingest (machine-to-machine).
 *
 * Separate from DASHBOARD_PASSWORD on purpose: that credential is for a human
 * at a browser; this one is what app producers send as a bearer token. Null
 * disables the endpoint with 503.
 */
function contactsIngestToken(): string | null {
  const value = process.env.CONTACTS_INGEST_TOKEN?.trim() ?? '';
  return value ? value : null;
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
}

export interface Config {
  partner: {
    token: string;
    organizationId: string;
    apiVersion: string;
    endpoint: string;
  };
  auth: {
    /**
     * Null when `DASHBOARD_PASSWORD` is unset, which leaves the API open — the
     * behaviour every existing localhost install already has. Setting it turns
     * the gate on; nothing else has to change.
     */
    password: string | null;
    /** Null disables POST /api/contacts/ingest. */
    contactsIngestToken: string | null;
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

  const organizationId = normalizeAppId(required('PARTNER_ORGANIZATION_ID'));
  const apiVersion = optional('PARTNER_API_VERSION', '2026-07');
  if (!/^(\d{4}-\d{2}|unstable)$/.test(apiVersion)) {
    throw new ConfigError(`PARTNER_API_VERSION must be YYYY-MM or "unstable", got "${apiVersion}".`);
  }

  cached = {
    partner: {
      token: required('PARTNER_API_TOKEN'),
      organizationId,
      apiVersion,
      endpoint: `https://partners.shopify.com/${organizationId}/api/${apiVersion}/graphql.json`,
    },
    auth: {
      password: dashboardPassword(),
      contactsIngestToken: contactsIngestToken(),
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
    },
  };

  return cached;
}

/** Test seam: drop the memoized config so a new environment can be read. */
export function resetConfig(): void {
  cached = null;
}

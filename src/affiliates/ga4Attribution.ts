import { getDb, type Db } from '../db/index.js';
import { addDays } from '../metrics/time.js';
import { connect, runQuery, type Connected } from '../bigquery/client.js';
import {
  assertIdentifier,
  BigQueryError,
  listAppSources,
  readConnection,
  type AppSource,
} from '../bigquery/connection.js';

/**
 * Deciding which affiliate sent a merchant, from the GA4 export alone.
 *
 * The affiliate link is `apps.shopify.com/<listing>?mref=<handle>`. Nothing in
 * the Shopify app ever saw that parameter — it was never forwarded anywhere —
 * so the only place the handle exists is in the URL Google recorded when the
 * browser opened the listing. Attribution is therefore a join between two
 * things GA4 knows and nothing else does:
 *
 *   - a listing page whose `page_location` carries the referral parameter, and
 *     which identifies the visitor only as a `user_pseudo_id` — a cookie
 *   - a `shopify_app_install`, which is the one event in the export carrying
 *     `shop_url` and `shop_id`, and which carries the same `user_pseudo_id`
 *
 * The install event is the bridge. `src/bigquery/ingest.ts` deliberately skips
 * it, and is right to: the funnel wants installs, installs are already complete
 * and exact in the Partner API, and reading them from a cookie-dependent
 * browser event instead would make a solid number worse. Attribution wants
 * something different from the same event — not the fact of the install, which
 * it already has, but the single row in the whole export where a browser cookie
 * and a shop appear side by side. That is the only reason it is read here, and
 * the install timestamp it returns should be treated as GA4's account of the
 * install rather than the authoritative one.
 *
 * **The limitation this inherits.** GA4 counts browsers; the Partner API counts
 * shops. PartnerDex refuses to join across that seam anywhere else, on purpose.
 * Affiliate attribution is the one place that has to, and it pays the usual
 * price: a merchant who clicks the link on their phone and installs from their
 * laptop is two `user_pseudo_id`s and cannot be joined, and a merchant whose
 * browser blocks analytics never produces a click row at all. Both are missed
 * silently — they look exactly like an install nobody referred. Mantle had the
 * same limitation and the same blind spot; this is not a regression, and it is
 * why a manual attribution path has to exist alongside this one rather than
 * being treated as a stopgap.
 */

/**
 * How long a click stays eligible to claim an install.
 *
 * 30 days, matching the cookie lifetime in Mantle's own spec. It is a business
 * rule rather than a property of the data, which is why it is a parameter of
 * the selection function rather than a constant baked into the SQL.
 */
export const REFERRAL_WINDOW_DAYS = 30;

/**
 * What an affiliate handle looks like: eight lowercase alphanumerics.
 *
 * This matters more than it first appears. The referral parameter is read with
 * the precedence Mantle used — `mref || utm_source || ref` — and the last two
 * are ordinary marketing parameters carrying ordinary values. Shopify's own
 * admin search links arrive with `utm_source=admin-web`; the app's marketing
 * site sends `utm_source=website`. Those are not affiliates, and without a
 * shape test they do not merely add noise, they *win*: first touch takes the
 * earliest qualifying click, and a junk click that lands before the real
 * affiliate click would take the attribution away from the affiliate who
 * earned it. Measured on a real listing export, filtering only after the
 * first-touch pick attributed noticeably fewer installs than filtering before
 * it did.
 *
 * The shape test is a fallback, not the right answer. It cannot tell an
 * affiliate handle from an eight-character campaign name — a campaign called
 * `showcase` passes it — which is what `handles` on the options below is for: once the
 * affiliate table exists, pass the real handles and this regex stops being
 * load-bearing.
 */
export const HANDLE_SHAPE = /^[a-z0-9]{8}$/;

/**
 * The only host a referral click is accepted from.
 *
 * Fixed rather than configurable, for the same reason the funnel's event names
 * are: there is one App Store and one hostname it serves listings on. A field
 * offering to change it would only offer a way to widen the trust boundary
 * described on the click CTE below.
 */
export const LISTING_HOST = 'apps.shopify.com';

/**
 * How far back an incremental run re-reads, in days of install date.
 *
 * The same reasoning as `LOOKBACK_HOURS` in `ingest.ts`, one unit coarser. GA4
 * backfills a daily table for hours after it first appears, so the newest day
 * is never complete when it is first read. Attribution has a second reason to
 * overlap that the funnel does not: an attribution is a *pair*, and a late
 * click can change which affiliate an install already seen belongs to. Re-deriving
 * the tail is what lets that correct itself instead of freezing the first answer.
 *
 * Nothing here writes, so the overlap costs bytes and nothing else. Callers
 * that persist results must treat a re-derived attribution as an upsert keyed
 * on the shop, not as a new one.
 */
export const DEFAULT_LOOKBACK_DAYS = 3;

/**
 * A ceiling on rows returned from one dataset in one run.
 *
 * Deliberately generous — the join is already narrowed to clicks that carry a
 * plausible handle, so a full-history backfill on a real property returns
 * thousands, not millions. It exists so a filter that fails open (an allowlist
 * accidentally passed empty, say) is caught as a refusal rather than as a
 * process that quietly eats memory.
 */
const MAX_ROWS = 200_000;

/** One click that could claim one install. The SQL emits these; the rule below picks. */
export interface AttributionCandidate {
  /** GA4's `shop_id` from the install event, as a string — it is an id, not a number. */
  shopId: string;
  /** The myshopify domain from the install event. Null if GA4 recorded the id only. */
  shopDomain: string | null;
  /** The browser cookie both events shared. Kept so a disputed attribution can be traced. */
  anonymousId: string;
  handle: string;
  clickedAt: string;
  installedAt: string;
}

/** One merchant, credited to one affiliate. Plain data — persistence is elsewhere. */
export interface Attribution {
  appId: string;
  handle: string;
  shopId: string;
  shopDomain: string | null;
  clickedAt: string;
  installedAt: string;
  anonymousId: string;
}

/* ------------------------------------------------------------- pure rules */

/**
 * The referral handle a listing URL carries, or null.
 *
 * Precedence is Mantle's, from `affiliates/implementation-spec.md:198-207`:
 * `mref` first, then `utm_source`, then `ref`. Order matters on a URL carrying
 * both — an affiliate link that has also picked up a campaign tag is still an
 * affiliate link, and reading `utm_source` off it would credit the campaign.
 *
 * Kept as a function on the TypeScript side even though the SQL extracts the
 * same three parameters itself, because this is the definition and the SQL is
 * its translation. A test can hold this to the URLs that actually appear in
 * the export; nothing can hold a regex inside a BigQuery string to anything.
 */
export function extractReferralHandle(pageLocation: string | null | undefined): string | null {
  if (!pageLocation) return null;
  for (const key of ['mref', 'utm_source', 'ref']) {
    // Anchored on `?` or `&` so `ref` does not also match the tail of `mref`,
    // and stopped at `#` so a fragment cannot end up inside the handle.
    const match = pageLocation.match(new RegExp(`[?&]${key}=([^&#]*)`));
    const value = match?.[1];
    if (value) return decodeURIComponent(value);
  }
  return null;
}

/** Whether a value is shaped like an affiliate handle, when no real list is available. */
export function isHandleShaped(value: string): boolean {
  return HANDLE_SHAPE.test(value);
}

export interface SelectionOptions {
  /** Defaults to `REFERRAL_WINDOW_DAYS`. */
  windowDays?: number;
  /** The real affiliate handles, when the caller has them. Case-insensitive. */
  handles?: string[];
}

/**
 * Whether a click is still eligible to claim an install.
 *
 * Both ends are inclusive, and both are deliberate. A click at the same
 * microsecond as the install is the common case, not an edge one — the listing
 * page and the install fire within the same second on a fast install — so
 * excluding equality would drop real referrals. At the far end, a click exactly
 * 30 days out is inside a 30-day window; a merchant who installs on the last
 * day of the cookie is a merchant the affiliate referred.
 *
 * A click *after* the install never qualifies, however close. That is not a
 * tolerance to be widened: the merchant was already a customer, and the click
 * is them returning to the listing they now use.
 */
export function qualifies(
  candidate: Pick<AttributionCandidate, 'clickedAt' | 'installedAt'>,
  windowDays: number = REFERRAL_WINDOW_DAYS,
): boolean {
  const click = Date.parse(candidate.clickedAt);
  const install = Date.parse(candidate.installedAt);
  if (Number.isNaN(click) || Number.isNaN(install)) return false;
  if (click > install) return false;
  return click >= install - windowDays * 86_400_000;
}

/**
 * First touch wins, one attribution per merchant.
 *
 * The earliest qualifying click takes the install and every other click is
 * discarded — no split credit, no last touch, no second attribution to a
 * different affiliate for the same shop. That is what Mantle did, and it is the
 * only rule under which a commission ledger reconciles: two affiliates credited
 * for one merchant is two invoices for one sale.
 *
 * Ties are broken on the handle rather than left to whatever order BigQuery
 * returned rows in. Two clicks at the same microsecond is a pathological case,
 * but a pipeline that answers differently on two runs of the same data is a
 * worse problem than picking arbitrarily — arbitrary and *stable* can at least
 * be reconciled and, if wrong, corrected by hand once.
 */
export function selectFirstTouch(
  appId: string,
  candidates: AttributionCandidate[],
  options: SelectionOptions = {},
): Attribution[] {
  const windowDays = options.windowDays ?? REFERRAL_WINDOW_DAYS;
  const allowed = options.handles
    ? new Set(options.handles.map((handle) => handle.trim().toLowerCase()))
    : null;

  const best = new Map<string, AttributionCandidate>();

  for (const candidate of candidates) {
    const handle = candidate.handle?.trim().toLowerCase();
    if (!handle) continue;
    // Re-applied here even though the SQL already filtered: the two filters
    // answer to different owners. The SQL one exists to keep bytes down, and a
    // caller is free to hand the runner rows from anywhere.
    if (allowed ? !allowed.has(handle) : !isHandleShaped(handle)) continue;
    if (!candidate.shopId) continue;
    if (!qualifies(candidate, windowDays)) continue;

    const current = best.get(candidate.shopId);
    if (
      !current ||
      candidate.clickedAt < current.clickedAt ||
      (candidate.clickedAt === current.clickedAt && handle < current.handle.toLowerCase())
    ) {
      best.set(candidate.shopId, { ...candidate, handle });
    }
  }

  return [...best.values()]
    .map((candidate) => ({
      appId,
      handle: candidate.handle,
      shopId: candidate.shopId,
      shopDomain: candidate.shopDomain,
      clickedAt: candidate.clickedAt,
      installedAt: candidate.installedAt,
      anonymousId: candidate.anonymousId,
    }))
    .sort((a, b) => a.installedAt.localeCompare(b.installedAt) || a.shopId.localeCompare(b.shopId));
}

/* ------------------------------------------------------------------- SQL */

/** `YYYYMMDD`, the suffix GA4 shards its daily tables by. */
function tableSuffix(instant: Date): string {
  return instant.toISOString().slice(0, 10).replace(/-/g, '');
}

/** BigQuery hands INT64 back as a string, a number, or a wrapper. Flatten it. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return toNumber((value as { value?: unknown }).value);
  }
  return null;
}

function isoFromMicros(value: unknown): string | null {
  const micros = toNumber(value);
  if (micros === null) return null;
  return new Date(Math.floor(micros / 1000)).toISOString();
}

/**
 * The click-to-install join.
 *
 * ### Cost
 *
 * These are years of daily tables and `events_*` with no suffix bound is a scan
 * of every day the property has ever recorded. Three things keep the bill down,
 * and all three are load-bearing:
 *
 *  1. `_TABLE_SUFFIX BETWEEN` is always present and always bound. It is what
 *     turns a wildcard into a range scan; BigQuery prunes the other tables
 *     before reading a byte.
 *  2. Only four columns are touched — `event_name`, `user_pseudo_id`,
 *     `event_timestamp` and `event_params`. BigQuery bills for columns read, not
 *     rows, and `event_params` is by far the widest of the four. Adding one more
 *     nested field to the projection costs more than adding a month to the range.
 *  3. Both sides are read in one pass over one scan. Reading clicks and installs
 *     as two separate wildcard queries would double the bill for the same answer,
 *     because their date ranges overlap almost entirely.
 *
 * Dry-run against one app's `analytics_<ga4-property-id>` dataset on 2026-08-13:
 *
 * | scan | bytes |
 * | --- | --- |
 * | 3 days of installs, the default incremental run | 0.007 GB |
 * | 105 days — 75 of installs plus the 30-day click lookback | 0.138 GB |
 * | the entire multi-year export, a one-off backfill | 0.920 GB |
 *
 * A full-history backfill costs under a gigabyte and fits inside BigQuery's
 * monthly free tier on its own. Nothing here needs to be rationed; what it needs
 * is for the suffix bound to never go missing, which is why it is not optional
 * in the builder. The 20 GiB `maximumBytesBilled` ceiling in `client.ts` still
 * applies and would catch a bound that failed to bind.
 *
 * ### Shape
 *
 * The intraday tables are excluded by the same accident that excludes them from
 * the funnel: `events_intraday_20260813` sorts after every `YYYYMMDD`, so the
 * BETWEEN never reaches them. Today's installs are therefore attributable
 * tomorrow, which is also why the lookback overlap exists.
 *
 * The suffix range is padded by a day at each end and the exact bounds are then
 * applied to `event_timestamp`. GA4 dates its tables in the *property's*
 * timezone and stamps `event_timestamp` in UTC; without the padding, an install
 * just after local midnight on the first day of the window sits in the previous
 * day's table and is never read.
 */
export function attributionQuery(
  projectId: string,
  dataset: string,
  options: { byHandleList: boolean } = { byHandleList: false },
): string {
  const table = `\`${assertIdentifier(projectId, 'Project id')}.${assertIdentifier(
    dataset,
    'Dataset',
  )}.events_*\``;
  const param = (key: string) =>
    `(SELECT value.string_value FROM UNNEST(e.event_params) WHERE key = '${key}')`;

  // The one filter that changes shape rather than value. Both branches compare
  // against bound parameters; neither interpolates anything a caller supplied.
  const handleFilter = options.byHandleList
    ? 'AND LOWER(handle) IN UNNEST(@handles)'
    : 'AND REGEXP_CONTAINS(handle, @handleShape)';

  return `
    WITH scanned AS (
      SELECT
        e.event_name                     AS event_name,
        e.user_pseudo_id                 AS user_pseudo_id,
        e.event_timestamp                AS micros,
        ${param('page_location')}        AS page_location,
        ${param('shop_url')}             AS shop_url,
        CAST(
          COALESCE(
            (SELECT value.int_value FROM UNNEST(e.event_params) WHERE key = 'shop_id'),
            SAFE_CAST(${param('shop_id')} AS INT64)
          ) AS STRING
        )                                AS shop_id
      FROM ${table} e
      WHERE e._TABLE_SUFFIX BETWEEN @scanFrom AND @scanTo
        AND e.user_pseudo_id IS NOT NULL
    ),
    /*
     * Every event carrying the parameter counts as the click, not just
     * \`page_view\`. GA4 stamps \`page_location\` onto whatever else fires in the
     * same view — \`user_engagement\`, \`view_item\`, \`add_to_cart\` — and on a real
     * export there are merchants whose only surviving referral URL is on one of
     * those. Restricting to \`page_view\` was measured to lose real
     * attributions for no gain in precision: the parameter is the same
     * parameter whichever event carried it.
     *
     * \`shopify_app_install\` is excluded because it is the other side of this
     * join and its own \`page_location\`, where present, describes where the
     * merchant landed after installing.
     *
     * The hostname check is the one filter here that is a trust boundary rather
     * than a narrowing. A GA4 measurement id is a public string in the page
     * source, and any site that copies it emits events into this property —
     * over one six-week window a real dataset carried three events from an
     * unrelated third-party site that appears to have mirrored the listing page
     * along with its tag. Those three change nothing today. But this query
     * decides who gets paid, and without the check, any site carrying a copied
     * tag can emit a \`page_view\` with an arbitrary \`?mref=\` and assign itself
     * commissions. It costs nothing and closes that.
     *
     * It is applied to the click side only, and must stay that way. The install
     * event is server-side — Shopify sends it through the Measurement Protocol —
     * so it has no \`page_location\` at all. Filtering both sides on hostname
     * would drop every install and return zero attributions without an error.
     */
    clicks AS (
      SELECT * FROM (
        SELECT
          user_pseudo_id,
          micros AS click_micros,
          COALESCE(
            NULLIF(REGEXP_EXTRACT(page_location, r'[?&]mref=([^&#]*)'), ''),
            NULLIF(REGEXP_EXTRACT(page_location, r'[?&]utm_source=([^&#]*)'), ''),
            NULLIF(REGEXP_EXTRACT(page_location, r'[?&]ref=([^&#]*)'), '')
          ) AS handle
        FROM scanned
        WHERE event_name != 'shopify_app_install'
          AND page_location IS NOT NULL
          AND NET.HOST(page_location) = @listingHost
          AND micros BETWEEN @clickFromMicros AND @installToMicros
      )
      WHERE handle IS NOT NULL ${handleFilter}
    ),
    /*
     * One install per browser and shop. The event repeats — Shopify fires it
     * again on a reinstall, and GA4 will happily record it twice within a
     * session — and the earliest is the one the click has to beat.
     */
    installs AS (
      SELECT user_pseudo_id, shop_url, shop_id, MIN(micros) AS install_micros
      FROM scanned
      WHERE event_name = 'shopify_app_install'
        AND shop_id IS NOT NULL
        AND micros BETWEEN @installFromMicros AND @installToMicros
      GROUP BY user_pseudo_id, shop_url, shop_id
    )
    SELECT
      i.shop_id        AS shop_id,
      i.shop_url       AS shop_url,
      i.user_pseudo_id AS anonymous_id,
      c.handle         AS handle,
      c.click_micros   AS click_micros,
      i.install_micros AS install_micros
    FROM installs i
    JOIN clicks c ON c.user_pseudo_id = i.user_pseudo_id
    WHERE c.click_micros <= i.install_micros
      AND c.click_micros >= i.install_micros - @windowMicros
    ORDER BY i.install_micros, c.click_micros
    LIMIT @maxRows
  `;
}

/* ---------------------------------------------------------------- runner */

export interface AttributionRunOptions extends SelectionOptions {
  /** Earliest install to consider. Inclusive. */
  from: Date;
  /** Latest install to consider. Exclusive, so a caller can pass midnight. */
  to: Date;
}

interface CandidateRow {
  shop_id: string | null;
  shop_url: string | null;
  anonymous_id: string | null;
  handle: string | null;
  click_micros: unknown;
  install_micros: unknown;
}

/**
 * Runs the join for one dataset and applies the rule.
 *
 * The split is deliberate: BigQuery narrows, TypeScript decides. Everything
 * that costs money to evaluate over billions of rows — the date bounds, the
 * parameter extraction, the handle filter — happens in SQL, and the part that
 * has to be *right* rather than cheap happens here, where it can be tested
 * against fixtures instead of against a bill.
 */
export async function runAttribution(
  connected: Connected,
  source: Pick<AppSource, 'appId' | 'dataset' | 'location'>,
  options: AttributionRunOptions,
): Promise<Attribution[]> {
  if (!source.dataset) throw new BigQueryError('No GA4 dataset set for this app.');

  const windowDays = options.windowDays ?? REFERRAL_WINDOW_DAYS;
  const handles = options.handles?.map((handle) => handle.trim().toLowerCase()).filter(Boolean);
  // An allowlist that arrived empty means "no affiliates", which would match
  // nothing and read as a clean run with no referrals. Falling back to the
  // shape test is the less surprising failure — and a caller that really has no
  // affiliates has no reason to run this at all.
  const byHandleList = Boolean(handles && handles.length > 0);

  const clickFrom = addDays(options.from, -windowDays);
  const query = attributionQuery(connected.connection.projectId, source.dataset, { byHandleList });

  const rows = (await runQuery(
    connected,
    query,
    {
      scanFrom: tableSuffix(addDays(clickFrom, -1)),
      scanTo: tableSuffix(addDays(options.to, 1)),
      clickFromMicros: clickFrom.getTime() * 1000,
      installFromMicros: options.from.getTime() * 1000,
      installToMicros: options.to.getTime() * 1000,
      windowMicros: windowDays * 86_400 * 1_000_000,
      listingHost: LISTING_HOST,
      maxRows: MAX_ROWS,
      ...(byHandleList ? { handles } : { handleShape: '^[a-z0-9]{8}$' }),
    },
    { location: source.location, dataset: source.dataset },
  )) as unknown as CandidateRow[];

  if (rows.length >= MAX_ROWS) {
    throw new BigQueryError(
      `The attribution join returned ${MAX_ROWS} candidate rows, which is the cap. Narrow the ` +
        'window rather than trusting a truncated result — first touch over a truncated set can ' +
        'credit the wrong affiliate.',
    );
  }

  const candidates: AttributionCandidate[] = [];
  for (const row of rows) {
    const clickedAt = isoFromMicros(row.click_micros);
    const installedAt = isoFromMicros(row.install_micros);
    if (!clickedAt || !installedAt || !row.shop_id || !row.handle) continue;
    candidates.push({
      shopId: row.shop_id,
      shopDomain: row.shop_url?.trim().toLowerCase() || null,
      anonymousId: row.anonymous_id ?? '',
      handle: row.handle,
      clickedAt,
      installedAt,
    });
  }

  return selectFirstTouch(source.appId, candidates, { windowDays, handles: options.handles });
}

export interface AttributeOptions extends SelectionOptions {
  /** Explicit window. Without it, the run covers `DEFAULT_LOOKBACK_DAYS` of installs. */
  from?: Date;
  to?: Date;
  lookbackDays?: number;
  now?: Date;
  onProgress?: (message: string) => void;
}

export interface AttributeResult {
  attributions: Attribution[];
  /** Apps that could not be queried, and why. Never thrown — attribution is not the sync. */
  skipped: Array<{ appId: string; reason: string }>;
  window: { from: string; to: string };
}

/**
 * Attribution across every app that has a GA4 dataset configured.
 *
 * Returns plain objects and writes nothing. That is not an oversight: an
 * attribution is a durable fact about who is owed money, and the decision about
 * where it lands — and about what happens when a re-run disagrees with a row
 * already written — belongs with the schema that stores it, not with the query
 * that discovered it.
 */
export async function attributeReferrals(
  appIds: string[],
  options: AttributeOptions = {},
  db: Db = getDb(),
): Promise<AttributeResult> {
  const now = options.now ?? new Date();
  const to = options.to ?? now;
  const from = options.from ?? addDays(to, -(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const onProgress = options.onProgress ?? (() => {});
  const window = { from: from.toISOString(), to: to.toISOString() };

  const connection = readConnection(db);
  if (!connection) {
    return {
      attributions: [],
      skipped: appIds.map((appId) => ({ appId, reason: 'BigQuery is not connected.' })),
      window,
    };
  }

  const skipped: AttributeResult['skipped'] = [];
  const attributions: Attribution[] = [];

  let connected: Connected;
  try {
    connected = await connect(connection);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { attributions: [], skipped: appIds.map((appId) => ({ appId, reason })), window };
  }

  for (const source of listAppSources(appIds, db)) {
    if (!source.dataset) {
      skipped.push({
        appId: source.appId,
        reason: 'No GA4 dataset set. Add one under Settings → BigQuery.',
      });
      continue;
    }
    try {
      const found = await runAttribution(connected, source, { ...options, from, to });
      attributions.push(...found);
      onProgress(`  ${source.appName ?? source.appId}: ${found.length} attributed install(s)`);
    } catch (error) {
      skipped.push({
        appId: source.appId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attributions, skipped, window };
}

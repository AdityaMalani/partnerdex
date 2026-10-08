import { getDb } from '../../db/index.js';
import { normalizeAppId, getConfig } from '../../config.js';
import { readConnection } from '../../bigquery/connection.js';
import { bucketsCte } from '../asof.js';
import { cacheKey, readCache, writeCache } from '../cache.js';
import { MetricRequestError } from '../context.js';
import { resolveScopedAppIds } from '../../sync/index.js';
import { resolveWindow, type Bucket, type Interval, type Window } from '../time.js';

/**
 * The install funnel (spec 4.12).
 *
 * Six ordered steps drawn from three different stores:
 *
 *   1 listing page view   GA4 export      a browser opened the App Store listing
 *   2 add-app click       GA4 export      that browser clicked Install
 *   3 installed           Partner API     a merchant chose the app, first time
 *                                         or fifth. Not a shop reopening.
 *   4 trial started       Partner API     that shop began a free period
 *   5 trial converted     Partner API     the free period ended in a payment
 *   6 left a review       listing crawl   a merchant posted a public review
 *
 * The seam between step 2 and step 3 is the whole difficulty of this report, and
 * it is not closed here. GA4 counts browsers; the Partner API counts shops. A
 * merchant who reads the listing on a laptop and installs from their desktop is
 * two visitors and one install, and one whose browser blocks analytics is no
 * visitor and one install. So the 2→3 rate is directional — it says whether
 * things are getting better or worse, not what fraction of clickers installed —
 * and steps 3-5 are read from the Partner API precisely because they are
 * complete there and would not be here.
 *
 * Step 6 is last because it happens last, not because the merchants in it came
 * through step 5. Reviewing is an outcome of adoption rather than a stage on the
 * way to revenue: a merchant on a free plan who never trialled can leave one, so
 * the step is not a subset of the step above it and will routinely exceed it.
 * That is said in the notes on every response rather than raised as a warning —
 * it is the normal case, and a warning that always fires teaches a reader to
 * skip the ones that mean something. It goes at the bottom rather than in the
 * middle for the same reason: placed between "Installed" and "Trial started" it
 * would break a chain where each step really is a subset of the one above it.
 *
 * The spec's marketing cap does not apply. That rule exists for funnels that
 * *begin* with marketing-site traffic, where an uncapped downstream reports more
 * subscribers than visitors; this one begins at the listing page, and capping
 * installs to fit GA4's coverage would delete real installs to make a chart
 * monotonic. Where the counts do not descend, the report says so instead.
 */

export type Granularity = 'day' | 'week' | 'month' | 'previous_7_days';

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month', 'previous_7_days'];

export type FunnelStepKey =
  | 'listing_view'
  | 'add_app_click'
  | 'installed'
  | 'trial_started'
  | 'trial_converted'
  | 'review_posted';

export interface FunnelStep {
  key: FunnelStepKey;
  label: string;
  description: string;
  /** Which store the figure is read from — the honest caption for the seam. */
  source: 'bigquery' | 'partner' | 'appstore';
  /**
   * What one unit is. Browsers upstream, shops downstream, and reviews at the
   * bottom: a review names a store but not a shop id, and the link back to a
   * customer is a guess that does not always land, so counting shops there
   * would silently drop every review the matcher could not place.
   */
  unit: 'visitor' | 'shop' | 'review';
}

export const FUNNEL_STEPS: FunnelStep[] = [
  {
    key: 'listing_view',
    label: 'Listing page view',
    description: '',
    source: 'bigquery',
    unit: 'visitor',
  },
  {
    key: 'add_app_click',
    label: 'Add app clicked',
    description: '',
    source: 'bigquery',
    unit: 'visitor',
  },
  {
    key: 'installed',
    label: 'Installed',
    description: '',
    source: 'partner',
    unit: 'shop',
  },
  {
    key: 'trial_started',
    label: 'Trial started',
    description: '',
    source: 'partner',
    unit: 'shop',
  },
  {
    key: 'trial_converted',
    label: 'Trial converted',
    description: '',
    source: 'partner',
    unit: 'shop',
  },
  {
    key: 'review_posted',
    label: 'Left a review',
    description: '',
    source: 'appstore',
    unit: 'review',
  },
];

export interface FunnelBucket {
  periodStart: string;
  periodEnd: string;
  /**
   * One count per step, in `FUNNEL_STEPS` order. Null is not zero: it means the
   * step cannot be measured here at all — no BigQuery connection, or no listing
   * traffic ever collected for these apps — and a zero would be a claim that
   * nobody visited.
   */
  counts: Array<number | null>;
  /** Percentage of the step before. Null at step 0 and wherever a side is null. */
  conversion: Array<number | null>;
  /** Percentage of step 1, which is the spec's definition of funnel conversion. */
  conversionFromStart: Array<number | null>;
  /** Count lost against the step before. */
  dropOff: Array<number | null>;
  /** The newest bucket is still filling; its trials have had least time to decide. */
  provisional?: boolean;
}

export interface FunnelResponse {
  granularity: Granularity;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeSeriesInterval: Interval;
  appIds: string[];
  steps: FunnelStep[];
  buckets: FunnelBucket[];
  /** The same shape over the whole window, so a header row can state it once. */
  totals: Omit<FunnelBucket, 'provisional'>;
  meta: {
    bigqueryConnected: boolean;
    /** Apps in scope that have collected listing traffic. */
    appsWithListingTraffic: number;
    appsInScope: number;
    /** Named, because a partial top is why a conversion can read over 100%. */
    appsWithoutListingTraffic: string[];
    /** Subscriptions that went straight to paid without a trial, in the window. */
    directToPaid: number;
    /**
     * Shops that reopened in the window. Held off step 3 deliberately — see
     * `shopCounts` — and reported so the gap against the installs figure on
     * every other page is stated rather than discovered.
     */
    reopenedNotCounted: number;
    /** Apps in scope whose App Store listing has been crawled at least once. */
    appsWithReviewCrawl: number;
    /** Named for the same reason the listing-traffic gap is: a partial bottom. */
    appsWithoutReviewCrawl: string[];
    /**
     * When we first looked at a listing in scope. Reviews still live then were
     * captured whenever they were posted, so posted history is complete from
     * that instant on; anything taken down before it is invisible and always
     * will be. Null when no listing here has ever been crawled.
     */
    reviewsCrawledFrom: string | null;
    /** Things the reader has to know to read the numbers correctly. */
    notes: string[];
    warnings: string[];
  };
}

export interface RawFunnelQuery {
  period?: string;
  start?: string;
  end?: string;
  granularity?: string;
  appIds?: string;
  nocache?: string;
}

function parseGranularity(raw: string | undefined): Granularity {
  if (!raw) return 'day';
  if ((GRANULARITIES as readonly string[]).includes(raw)) return raw as Granularity;
  throw new MetricRequestError(
    `Unknown granularity "${raw}". Allowed: ${GRANULARITIES.join(', ')}.`,
  );
}

/**
 * Resolves the window a granularity implies.
 *
 * Three of the four are ordinary interval overrides on whatever range the reader
 * picked. `previous_7_days` is not a granularity at all in the same sense — it
 * is one bucket covering the last seven days — so it fixes the range too, and
 * the range control has nothing left to say.
 */
function windowFor(query: RawFunnelQuery, granularity: Granularity, now?: Date): Window {
  const { runtime, scope } = getConfig();

  if (granularity === 'previous_7_days') {
    const window = resolveWindow({
      period: 'last_7_days',
      timeZone: runtime.timezone,
      allTimeStart: scope.syncStartDate,
      now,
    });
    // Collapsed after resolution rather than instead of it, so the leading
    // bucket and the boundary clamping stay exactly what every other report got.
    const single: Bucket = { start: window.start, end: window.end };
    return { ...window, buckets: [single] };
  }

  return resolveWindow({
    period: query.period,
    start: query.start,
    end: query.end,
    interval: granularity,
    timeZone: runtime.timezone,
    allTimeStart: scope.syncStartDate,
    now,
  });
}

function appParams(appIds: string[], prefix: string): { sql: string; params: Record<string, unknown> } {
  if (appIds.length === 0) return { sql: '', params: {} };
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    params[`${prefix}${index}`] = id;
    return `@${prefix}${index}`;
  });
  return { sql: names.join(', '), params };
}

interface VisitorRow {
  idx: number;
  views: number;
  clicks: number;
}

/**
 * Steps 1 and 2, from the synced GA4 export.
 *
 * **People, not events.** Someone who opens the listing six times in a week is
 * one visitor, not six, so every figure here is a `COUNT(DISTINCT …)` over the
 * resolved user rather than a row count.
 *
 * `user_key` is that resolved identity — the shop where the event carried one,
 * else GA4's User-ID, else the browser (see `resolveUserKey`). It falls back to
 * `anonymous_id` for rows collected before the column existed, and finally to
 * the event's own id: an event with no identity at all is one visitor of its
 * own, because the alternative collapses every anonymous hit into a single
 * phantom merchant.
 */
function visitorCounts(
  db: ReturnType<typeof getDb>,
  buckets: Bucket[],
  appIds: string[],
): Map<number, VisitorRow> {
  const cte = bucketsCte(buckets);
  const apps = appParams(appIds, 'lapp');
  const visitor = `COALESCE(NULLIF(e.user_key, ''), NULLIF(e.anonymous_id, ''), e.event_id)`;

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              COUNT(DISTINCT CASE WHEN e.type = 'listing_view'  THEN ${visitor} END) AS views,
              COUNT(DISTINCT CASE WHEN e.type = 'add_app_click' THEN ${visitor} END) AS clicks
       FROM buckets b
       LEFT JOIN listing_events e
         ON e.occurred_at >= b.bucket_from
        AND e.occurred_at <  b.as_of
        ${apps.sql ? `AND e.app_id IN (${apps.sql})` : ''}
       GROUP BY b.idx
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as VisitorRow[];

  return new Map(rows.map((row) => [row.idx, row]));
}

interface ShopRow {
  idx: number;
  installed: number;
  reopened: number;
  trial_started: number;
  trial_converted: number;
  direct_to_paid: number;
}

/**
 * Steps 3 to 5, from the Partner API store.
 *
 * Step 3 counts installs, not live relationships, and the two differ by exactly
 * one event. A shop that was closed and has reopened arrives as
 * RELATIONSHIP_REACTIVATED and opens an install interval like any other — which
 * is right for active installs and for logo churn, where the question is whether
 * the app is on the shop. It is wrong here: nobody read the listing, nobody
 * clicked Install, and there is no step 1 or 2 for that shop to have come from,
 * so counting it adds a numerator with no possible denominator and pushes the
 * 2→3 rate up. Re-installs are the opposite case and are counted: a merchant who
 * uninstalled in March and chose the app again in August is an acquisition in
 * August, and arrives as RELATIONSHIP_INSTALLED like any first-timer.
 *
 * Each step is counted in shops rather than in charges, so a merchant who
 * restarts a subscription inside one bucket is one shop at every step and the
 * funnel keeps descending. Plan changes are excluded from the trial steps for the reason
 * spelled out in the lifecycle compiler: a merchant moving tier carries a
 * nominal trial window they never actually sat through, and counting it turns
 * an afternoon of tier-shopping into a fresh trial cohort.
 *
 * Step 5 is bucketed by when the trial *started*, not by when the money landed,
 * so a column reads "of the trials that began here, this many converted" — the
 * same cohort rule the trials report uses. It is also why the newest buckets are
 * provisional: those trials have not finished deciding.
 */
function shopCounts(
  db: ReturnType<typeof getDb>,
  buckets: Bucket[],
  appIds: string[],
): Map<number, ShopRow> {
  const cte = bucketsCte(buckets);
  const installApps = appParams(appIds, 'iapp');
  const subApps = appParams(appIds, 'sapp');

  const inBucket = (column: string) =>
    `${column} >= b.bucket_from AND ${column} < b.as_of`;

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              (SELECT COUNT(DISTINCT i.app_id || ' ' || i.shop_id)
                 FROM install_intervals i
                WHERE ${inBucket('i.started_at')}
                  AND i.shop_id <> ''
                  AND i.started_by = 'installed'
                  ${installApps.sql ? `AND i.app_id IN (${installApps.sql})` : ''}
              ) AS installed,
              -- Not a step. Counted only so the report can say how many shops
              -- it left out, rather than quietly reporting a smaller number
              -- than the installs metric on every other page.
              (SELECT COUNT(DISTINCT i.app_id || ' ' || i.shop_id)
                 FROM install_intervals i
                WHERE ${inBucket('i.started_at')}
                  AND i.shop_id <> ''
                  AND i.started_by = 'reactivated'
                  ${installApps.sql ? `AND i.app_id IN (${installApps.sql})` : ''}
              ) AS reopened,
              (SELECT COUNT(DISTINCT s.app_id || ' ' || s.shop_id)
                 FROM subscriptions s
                WHERE s.is_test = 0
                  AND s.is_plan_change = 0
                  AND s.trial_started_at IS NOT NULL
                  AND ${inBucket('s.trial_started_at')}
                  ${subApps.sql ? `AND s.app_id IN (${subApps.sql})` : ''}
              ) AS trial_started,
              (SELECT COUNT(DISTINCT s.app_id || ' ' || s.shop_id)
                 FROM subscriptions s
                WHERE s.is_test = 0
                  AND s.is_plan_change = 0
                  AND s.trial_status = 'converted'
                  AND s.trial_started_at IS NOT NULL
                  AND ${inBucket('s.trial_started_at')}
                  ${subApps.sql ? `AND s.app_id IN (${subApps.sql})` : ''}
              ) AS trial_converted,
              (SELECT COUNT(DISTINCT s.app_id || ' ' || s.shop_id)
                 FROM subscriptions s
                WHERE s.is_test = 0
                  AND s.is_plan_change = 0
                  AND s.trial_status = 'none'
                  AND s.conversion_at IS NOT NULL
                  AND ${inBucket('s.conversion_at')}
                  ${subApps.sql ? `AND s.app_id IN (${subApps.sql})` : ''}
              ) AS direct_to_paid
       FROM buckets b
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...installApps.params, ...subApps.params }) as ShopRow[];

  return new Map(rows.map((row) => [row.idx, row]));
}

interface ReviewRow {
  idx: number;
  reviewed: number;
}

/**
 * The listing publishes a date with no time, so both sides of the bucket
 * predicate have to be put in the same form: a bare `2024-03-01` sorts *before*
 * `2024-03-01T00:00:00.000Z` lexically, and a review would land in the bucket
 * before its own. Written the same way the reviews report writes it, so a review
 * cannot fall in one column here and a different one there.
 */
const POSTED_AT = "(r.posted_on || 'T00:00:00.000Z')";

/**
 * Step 6, from the crawled App Store listing.
 *
 * **Reviews, not reviewers.** Every other step counts distinct people; this one
 * counts rows, and the difference is the shop link. A review publishes the
 * merchant's store name and never their myshopify domain, so `shop_id` is a
 * guess that the matcher leaves empty whenever two installers share a name or
 * none answers to it. Counting distinct shops would quietly drop exactly those
 * reviews — a real merchant's real review, deleted from the funnel because we
 * could not work out who they were. A review row is one merchant reviewing one
 * app, which is the same grain as the `app_id || shop_id` pairs below the seam.
 *
 * **Counted by the day it was posted**, which is event time rather than the
 * cohort time step 5 uses. A review in March from a merchant who installed in
 * January belongs to March's column, and does not belong to that column's
 * trials. Said in the notes, because a column that mixes the two readings
 * without saying so is the kind of thing a reader only discovers by being wrong
 * in a meeting.
 *
 * **A removed review still counts.** `removed_at` is deliberately not filtered:
 * the merchant did leave the review, and the funnel is asking what happened in
 * that period, not what is on the listing today. The one thing this cannot see
 * is a review taken down before the first crawl, which never reached the store
 * at all — hence `reviewsCrawledFrom` on the response.
 */
function reviewCounts(
  db: ReturnType<typeof getDb>,
  buckets: Bucket[],
  appIds: string[],
): Map<number, ReviewRow> {
  const cte = bucketsCte(buckets);
  const apps = appParams(appIds, 'rapp');

  const rows = db
    .prepare(
      `WITH ${cte.sql}
       SELECT b.idx AS idx,
              (SELECT COUNT(*)
                 FROM app_reviews r
                WHERE ${POSTED_AT} >= b.bucket_from
                  AND ${POSTED_AT} < b.as_of
                  ${apps.sql ? `AND r.app_id IN (${apps.sql})` : ''}
              ) AS reviewed
       FROM buckets b
       ORDER BY b.idx`,
    )
    .all({ ...cte.params, ...apps.params }) as ReviewRow[];

  return new Map(rows.map((row) => [row.idx, row]));
}

function percent(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000) / 100;
}

/** Turns a column of counts into the three derived columns beside it. */
function derive(counts: Array<number | null>): Pick<
  FunnelBucket,
  'conversion' | 'conversionFromStart' | 'dropOff'
> {
  const first = counts[0] ?? null;

  return {
    conversion: counts.map((value, index) => {
      if (index === 0) return null;
      const previous = counts[index - 1] ?? null;
      // A null on either side is unmeasurable, and a zero denominator has no
      // finite rate. Neither is 0% — saying so would read as "nobody converted".
      if (value === null || previous === null || previous === 0) return null;
      return percent(value, previous);
    }),
    conversionFromStart: counts.map((value, index) => {
      if (index === 0) return null;
      if (value === null || first === null || first === 0) return null;
      return percent(value, first);
    }),
    dropOff: counts.map((value, index) => {
      if (index === 0) return null;
      const previous = counts[index - 1] ?? null;
      if (value === null || previous === null) return null;
      return previous - value;
    }),
  };
}

function buildFunnel(query: RawFunnelQuery, now?: Date): FunnelResponse {
  const db = getDb();
  const granularity = parseGranularity(query.granularity);

  const inScope = resolveScopedAppIds(db);
  let appIds = inScope;
  if (query.appIds) {
    const requested = query.appIds.split(',').map(normalizeAppId).filter(Boolean);
    const outside = requested.filter((id) => !inScope.includes(id));
    if (outside.length > 0) {
      throw new MetricRequestError(
        `Requested app id(s) outside the configured reporting scope: ${outside.join(', ')}.`,
        403,
      );
    }
    appIds = requested;
  }

  const window = windowFor(query, granularity, now);
  const visitors = visitorCounts(db, window.buckets, appIds);
  const shops = shopCounts(db, window.buckets, appIds);
  const reviews = reviewCounts(db, window.buckets, appIds);

  /*
   * Whether the top of the funnel is measurable at all.
   *
   * A connected BigQuery with no rows yet, and a live one whose listing simply
   * had a quiet Tuesday, must not look the same. The first reports nothing; only
   * the second reports zero. The test is per scope rather than per bucket: an
   * app that has ever collected listing traffic is instrumented, so a zero in
   * one of its buckets is a real zero.
   */
  const connection = readConnection(db);
  const apps = appParams(appIds, 'tapp');

  /*
   * Instrumentation is per app, and mixed scopes are the trap.
   *
   * One GA4 property covers the listing whose measurement id points at it, and
   * no others. Report on three apps where only one is instrumented and the top
   * two steps cover one app while the bottom three cover three — which reads as
   * a conversion rate well over 100% and looks like a bug in the arithmetic
   * rather than a hole in the coverage. So the apps are named.
   */
  /*
   * `crawls` is the same question for the bottom step, asked of the one table
   * that answers it honestly. A snapshot row is written on every successful
   * crawl whether or not the listing had any reviews on it, so its presence
   * means "we have looked", which is exactly the line between a real zero and an
   * unmeasured one. Counting `app_reviews` instead would report a listing that
   * genuinely has no reviews yet as unmeasurable, and `app_listings` would
   * report one that was mapped this morning and never fetched as measured.
   */
  const coverage = db
    .prepare(
      `SELECT a.id AS app_id,
              a.name AS app_name,
              (SELECT COUNT(*) FROM listing_events e WHERE e.app_id = a.id) AS events,
              (SELECT COUNT(*) FROM app_review_snapshots s WHERE s.app_id = a.id) AS crawls
         FROM apps a
        ${apps.sql ? `WHERE a.id IN (${apps.sql})` : ''}
        ORDER BY a.name`,
    )
    .all(apps.params) as Array<{
      app_id: string;
      app_name: string | null;
      events: number;
      crawls: number;
    }>;

  const instrumented = coverage.filter((row) => row.events > 0);
  const uninstrumented = coverage.filter((row) => row.events === 0);
  const topMeasurable = connection !== null && instrumented.length > 0;

  const crawled = coverage.filter((row) => row.crawls > 0);
  const uncrawled = coverage.filter((row) => row.crawls === 0);
  const reviewsMeasurable = crawled.length > 0;

  const crawlHorizon = db
    .prepare(
      `SELECT MIN(s.captured_at) AS at
         FROM app_review_snapshots s
        ${apps.sql ? `WHERE s.app_id IN (${apps.sql})` : ''}`,
    )
    .get(apps.params) as { at: string | null };
  const reviewsCrawledFrom = crawlHorizon.at;

  const nowInstant = now ?? new Date();

  const buckets: FunnelBucket[] = window.buckets.map((bucket, idx) => {
    const visitor = visitors.get(idx);
    const shop = shops.get(idx);
    const review = reviews.get(idx);

    const counts: Array<number | null> = [
      topMeasurable ? visitor?.views ?? 0 : null,
      topMeasurable ? visitor?.clicks ?? 0 : null,
      shop?.installed ?? 0,
      shop?.trial_started ?? 0,
      shop?.trial_converted ?? 0,
      // Null for the same reason the listing steps are: a listing nobody has
      // crawled has no reviews we know of, which is not the same claim as a
      // listing nobody reviewed.
      reviewsMeasurable ? review?.reviewed ?? 0 : null,
    ];

    return {
      periodStart: bucket.start.toISOString(),
      periodEnd: bucket.end.toISOString(),
      counts,
      ...derive(counts),
      ...(bucket.end.getTime() >= nowInstant.getTime() ? { provisional: true } : {}),
    };
  });

  /*
   * Totals are counted over the whole window, not summed from the columns.
   *
   * Every step counts distinct people — visitors above the seam, shops below —
   * and distinct counts do not add up. Someone who opened the listing on three
   * days is three column-entries and one visitor; a shop that installed, left
   * and installed again is two months and one shop. Summing turned the Total
   * into a number that was larger than any honest reading of it, and made the
   * end-to-end conversion above it wrong in the same direction.
   *
   * So it is a second pass over one bucket spanning the range: two more
   * queries, and a column that means what it says.
   */
  const wholeRange: Bucket[] = [{ start: window.start, end: window.end }];
  const rangeVisitors = visitorCounts(db, wholeRange, appIds).get(0);
  const rangeShops = shopCounts(db, wholeRange, appIds).get(0);
  const rangeReviews = reviewCounts(db, wholeRange, appIds).get(0);

  const totalCounts: Array<number | null> = [
    topMeasurable ? rangeVisitors?.views ?? 0 : null,
    topMeasurable ? rangeVisitors?.clicks ?? 0 : null,
    rangeShops?.installed ?? 0,
    rangeShops?.trial_started ?? 0,
    rangeShops?.trial_converted ?? 0,
    // The one step whose total genuinely is the columns added up, since a review
    // is an event rather than a person and no row spans two buckets. Counted
    // over the range anyway, so one function owns the figure.
    reviewsMeasurable ? rangeReviews?.reviewed ?? 0 : null,
  ];

  const directToPaid = rangeShops?.direct_to_paid ?? 0;
  const reopened = rangeShops?.reopened ?? 0;

  const notes: string[] = [];
  const warnings: string[] = [];

  if (!connection) {
    notes.push(
      'BigQuery is not connected, so the two listing steps cannot be measured. ' +
      'Connect a GA4 export in Settings → BigQuery.',
    );
  } else if (instrumented.length === 0) {
    notes.push(
      'No listing traffic has been collected for these apps yet. Check the GA4 dataset and ' +
      'app mapping in Settings → BigQuery; the first sync backfills up to a year.',
    );
  } else {
    notes.push(
      'Steps 1-2 count people from Google Analytics; steps 3-5 count shops from the Partner ' +
        'API. The rate between them is directional, not a true per-visitor conversion.',
    );
    notes.push(
      'Every figure counts each person once. A visitor is the shop the event named, or Google’s ' +
        'user id, or failing both the browser — so one merchant across two devices is two.',
    );
    notes.push(
      'The Total column counts each person once across the whole range, so it is smaller than ' +
        'the columns added together.',
    );
  }

  /*
   * The mixed-scope warning, and the reason it comes before the arithmetic one
   * below: when it fires, the "installs exceed clicks" message underneath it is
   * a symptom rather than the cause, and a reader who fixes the coverage stops
   * seeing both.
   */
  if (connection && instrumented.length > 0 && uninstrumented.length > 0) {
    const naming = uninstrumented
      .map((row) => row.app_name ?? row.app_id)
      .slice(0, 4)
      .join(', ');
    warnings.push(
      `Steps 1-2 cover ${instrumented.length} of ${coverage.length} apps in view. No listing ` +
      `traffic has ever been collected for ${naming}, so their visitors are missing while ` +
      'their installs, trials and conversions are counted — which is why the rate into ' +
      '"Installed" can exceed 100%. Either pick a single app above, or give each app its own ' +
      'GA4 dataset under Settings → BigQuery.',
    );
  }

  notes.push(
    'Trial conversions are credited to the period the trial started in, so the newest columns ' +
    'are provisional until those trials decide.',
  );

  /*
   * The bottom step's three caveats, in the order a reader trips over them: it
   * is not a subset, it is not the same clock, and it is not complete before we
   * started looking. All notes, none a warning — every one of them is the normal
   * condition of the step rather than something wrong with this response.
   */
  if (!reviewsMeasurable) {
    notes.push(
      '"Left a review" cannot be measured: no App Store listing has been crawled for these ' +
      'apps. Map one under Settings → App listings, and the first crawl reads the whole ' +
      'review history off the page.',
    );
  } else {
    notes.push(
      '"Left a review" counts reviews posted on the App Store listing, and a reviewer does not ' +
      'have to have trialled or paid. It is the last step because it happens last, not because ' +
      'those merchants came through the step above — so it can exceed it, and the rate into it ' +
      'is not a fraction of it.',
    );
    notes.push(
      'Reviews are counted in the period they were posted, not the period the merchant ' +
      'installed in, so a review here can belong to someone who arrived long before this ' +
      'column. The listing publishes a date and no time, so each one sits at UTC midnight.',
    );

    if (reviewsCrawledFrom !== null && reviewsCrawledFrom > window.start.toISOString()) {
      notes.push(
        `Reviews were first crawled on ${reviewsCrawledFrom.slice(0, 10)}. Any review taken ` +
        'down before then was never on a page we read, so periods before that date can ' +
        'under-count. Periods after it are complete.',
      );
    }
  }

  if (crawled.length > 0 && uncrawled.length > 0) {
    const naming = uncrawled
      .map((row) => row.app_name ?? row.app_id)
      .slice(0, 4)
      .join(', ');
    warnings.push(
      `"Left a review" covers ${crawled.length} of ${coverage.length} apps in view. No App ` +
      `Store listing has been crawled for ${naming}, so their reviews are missing while their ` +
      'installs, trials and conversions are counted. Map each listing under Settings → App ' +
      'listings, or pick a single app above.',
    );
  }

  if (reopened > 0) {
    notes.push(
      `"Installed" counts merchants choosing the app, first time or fifth. ${reopened} shop(s) ` +
      'reopened in this range after being closed and are not counted: no one visited the ' +
      'listing, so they have no step 1 or 2 to have come from. Other reports count them, so ' +
      'this figure runs below the installs shown elsewhere.',
    );
  }

  if (directToPaid > 0) {
    notes.push(
      `${directToPaid} subscription(s) in this range went straight to paid without a trial. ` +
      'They install and pay but never appear in steps 4-5.',
    );
  }

  /*
   * Non-monotonic steps are reported, never corrected. See the header comment.
   *
   * "Left a review" is left out of this loop rather than added to it. Every
   * other step here is a subset of the one above, so a step that exceeds its
   * predecessor is news; that step is not a subset of anything, so it would
   * warn on almost every account almost every month, and a warning that always
   * fires is a warning nobody reads. Its standing note above carries the
   * explanation instead.
   */
  for (let step = 1; step < FUNNEL_STEPS.length; step += 1) {
    if (FUNNEL_STEPS[step]!.key === 'review_posted') continue;
    const value = totalCounts[step] ?? null;
    const previous = totalCounts[step - 1] ?? null;
    if (value !== null && previous !== null && value > previous) {
      warnings.push(
        `"${FUNNEL_STEPS[step]!.label}" (${value}) exceeds "${FUNNEL_STEPS[step - 1]!.label}" ` +
        `(${previous}) across this range.` +
        (step === 2
          ? ' Analytics misses visitors who block it or switch device, so the listing steps' +
          ' under-count rather than the installs over-counting.'
          : ' Merchants who installed in an earlier period can reach this step in this one.'),
      );
    }
  }

  return {
    granularity,
    period: window.period,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    timeSeriesInterval: window.interval,
    appIds,
    steps: FUNNEL_STEPS,
    buckets,
    totals: { periodStart: window.start.toISOString(), periodEnd: window.end.toISOString(), counts: totalCounts, ...derive(totalCounts) },
    meta: {
      bigqueryConnected: connection !== null,
      appsWithListingTraffic: instrumented.length,
      appsInScope: coverage.length,
      appsWithoutListingTraffic: uninstrumented.map((row) => row.app_name ?? row.app_id),
      directToPaid,
      reopenedNotCounted: reopened,
      appsWithReviewCrawl: crawled.length,
      appsWithoutReviewCrawl: uncrawled.map((row) => row.app_name ?? row.app_id),
      reviewsCrawledFrom,
      notes,
      warnings,
    },
  };
}

/** Read-through cached, on the same table and TTL every other report uses. */
export function funnelReport(query: RawFunnelQuery, options: { now?: Date } = {}): FunnelResponse {
  const db = getDb();
  const key = cacheKey('funnel', {
    ...query,
    nocache: undefined,
    scope: resolveScopedAppIds(db).join(','),
  });

  const bypass = query.nocache === '1' || query.nocache === 'true';
  if (!bypass) {
    const cached = readCache<FunnelResponse>(db, key);
    if (cached) return cached;
  }

  const response = buildFunnel(query, options.now);
  if (!bypass) writeCache(db, key, response);
  return response;
}

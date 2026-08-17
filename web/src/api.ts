export type MetricFormat = 'money' | 'percent' | 'count' | 'number';

export interface TimeSeriesPoint {
  value: number;
  change: number | null;
  periodStart: string;
  periodEnd: string;
  provisional?: boolean;
}

export interface NamedSeries {
  key: string;
  name: string;
  data: Array<{ date: string; value: number }>;
}

/** The same metric over the equal-length span immediately before this one. */
export interface MetricComparison {
  previousValue: number;
  change: number;
  /** Null when the previous period was zero — no finite percentage exists. */
  changePercent: number | null;
  periodStart: string;
  periodEnd: string;
}

export interface MetricResponse {
  metric: string;
  value: number;
  format: MetricFormat;
  currency: string | null;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeSeriesInterval: string;
  timeSeries: TimeSeriesPoint[];
  series?: NamedSeries[];
  comparison?: MetricComparison;
  meta?: Record<string, unknown>;
}

export type Overview = Record<string, MetricResponse>;

export interface AppSummary {
  id: string;
  name: string;
  /** The Partner organization the app was synced from. Labelling only. */
  orgId?: string;
}

/** The background sync loop's own account of itself. */
export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  nextRunAt: string | null;
  /** The phase in flight, and since when. Null between runs. */
  phase: string | null;
  phaseOrg: string | null;
  phaseStartedAt: string | null;
  /** The newest detail line the run has produced. */
  lastMessage: string | null;
  lastMessageAt: string | null;
  /** Where the last failure happened, which `lastError` alone never said. */
  lastErrorPhase: string | null;
  lastErrorOrg: string | null;
  lastErrorAt: string | null;
  lastDurationMs: number | null;
}

export interface Status {
  /*
   * The row counts, present only when `?counts=1` was asked for. Optional in the
   * type because they are optional on the wire — declaring them required is how
   * a reader ends up treating an absent count as a zero.
   */
  apps?: number;
  shops?: number;
  events?: number;
  transactions?: number;
  subscriptions?: number;
  customerEvents?: number;
  lastSyncAt: string | null;
  /** Whether the store holds anything. Always sent, and cheap. */
  hasData: boolean;
  sync: SyncStatus;
}

export interface QueryState {
  period: string;
  appId: string;
  /**
   * The organization every figure is scoped to. Empty means all of them, which
   * is the default and the behaviour of every dashboard that predates this
   * selector.
   */
  orgId: string;
  includeUsage: boolean;
  includeTrials: boolean;
  /** A single star rating for the review reports; 0 means every rating. */
  rating: number;
  /**
   * Funnel column width. Deliberately not sent to `/api/overview`: the metric
   * pages derive their interval from the range ladder, and letting a filter
   * override it there would put the axis at odds with the figures beside it.
   */
  granularity: Granularity;
}

/**
 * Note the absence of `interval`. Granularity is not a filter any more: the
 * server's one range-to-interval ladder decides it, so a reader cannot put the
 * axis into a state that disagrees with the figures beside it.
 */
export function toSearchParams(query: QueryState): URLSearchParams {
  const params = new URLSearchParams({
    period: query.period,
    includeUsage: String(query.includeUsage),
    includeTrials: String(query.includeTrials),
  });
  // No `end` either: the dashboard always reads as of now. The server still
  // honours the parameter, so an as-of reconstruction stays available to
  // anything calling the API directly.
  //
  // The app and the organization are both sent when both are set. The server
  // resolves the organization to a set of app ids and then checks the named app
  // against it, so an app that is not in the selected organization is a 403
  // rather than a silently empty chart.
  if (query.orgId) params.set('orgId', query.orgId);
  if (query.appId) params.set('appIds', query.appId);
  if (query.rating) params.set('rating', String(query.rating));
  return params;
}

/**
 * Fired when the server says a request was not authenticated, so the shell can
 * fall back to the login form from wherever the reader happened to be. A
 * session expires on its own clock, which means any request can be the one that
 * discovers it — polling status at 3am included.
 */
export const SIGNED_OUT_EVENT = 'partnerdex:signed-out';

/**
 * A failed request that still remembers what the server said.
 *
 * The status matters to exactly one caller — the affiliate pages, which are
 * built against endpoints that may not be deployed yet and have to tell "this
 * route does not exist" apart from "this route is broken". Everywhere else it
 * is an ordinary Error and reads as one.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // The login endpoint answers 401 for a wrong password; that is an answer to a
  // question the reader just asked, not a session that lapsed underneath them.
  if (response.status === 401 && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new HttpError(message, response.status);
  }
  // 204 on delete: there is no body to parse.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const getJson = <T,>(url: string): Promise<T> => request<T>(url);

const sendJson = <T,>(method: string, url: string, body?: unknown): Promise<T> =>
  request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * One request per page. Each metric costs the server two reconstructions — its
 * own window and the previous one — so a page asks only for the cards it shows.
 */
export const fetchOverview = (query: QueryState, metrics: string[]): Promise<Overview> => {
  const params = toSearchParams(query);
  params.set('metrics', metrics.join(','));
  return getJson<Overview>(`/api/overview?${params.toString()}`);
};

export const fetchApps = (orgId = ''): Promise<{ apps: AppSummary[] }> =>
  getJson<{ apps: AppSummary[] }>(`/api/apps${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`);

export const fetchStatus = (): Promise<Status> => getJson<Status>('/api/status');

/* ------------------------------------------------------------------ auth */

export interface Session {
  /** False when no DASHBOARD_PASSWORD is set — the dashboard is open. */
  required: boolean;
  authenticated: boolean;
}

export const fetchSession = (): Promise<Session> => getJson<Session>('/api/auth/session');

export const login = (password: string, remember: boolean): Promise<{ ok: boolean }> =>
  sendJson<{ ok: boolean }>('POST', '/api/auth/login', { password, remember });

export const logout = (): Promise<{ ok: boolean }> =>
  sendJson<{ ok: boolean }>('POST', '/api/auth/logout');

/* ------------------------------------------------------------- customers */

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
  /** Every app this merchant has ever had, paying or not. */
  apps: CustomerApp[];
}

/** The whole relationship with one app, on one line. */
export interface CustomerApp {
  appId: string;
  appName: string | null;
  /** The listing, when one is mapped — the write-a-review link is built on it. */
  listingUrl: string | null;
  planName: string | null;
  /** The price as billed: 299 on an annual plan, not the normalized 24.92. */
  amount: number | null;
  billingInterval: string | null;
  currency: string | null;
  /** Normalized monthly, and zero unless a subscription is live right now. */
  mrr: number;
  status: CustomerStatus;
  since: string | null;
  paymentCount: number;
  paidGross: number;
  review: ReviewSummary | null;
}

export const fetchCustomers = (options: {
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  appId?: string;
  orgId?: string;
}): Promise<CustomerListResult> => {
  const params = new URLSearchParams();
  if (options.orgId) params.set('orgId', options.orgId);
  if (options.search) params.set('q', options.search);
  if (options.sort) params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  if (options.appId) params.set('appIds', options.appId);
  return getJson<CustomerListResult>(`/api/customers?${params.toString()}`);
};

export const fetchCustomer = (
  shopId: string,
  appId = '',
  orgId = '',
): Promise<CustomerDetail> => {
  const params = new URLSearchParams();
  if (orgId) params.set('orgId', orgId);
  if (appId) params.set('appIds', appId);
  const query = params.toString();
  return getJson<CustomerDetail>(
    `/api/customers/${encodeURIComponent(shopId)}${query ? `?${query}` : ''}`,
  );
};

/* --------------------------------------------------------------- reviews */

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
  shopId: string | null;
  shopName: string | null;
  shopDomain: string | null;
  matchMethod: ReviewMatchMethod;
  priorRating: number | null;
  editedAt: string | null;
  /**
   * When a sweep first found the review gone. Who removed it is not knowable —
   * a Shopify purge, the merchant deleting it, and a closed store all present
   * the same way — so the UI says "Removed" and nothing more.
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
  totals: {
    live: number;
    removed: number;
    unmatched: number;
    averageRating: number | null;
  };
}

export interface ReviewCandidate {
  shopId: string;
  name: string | null;
  domain: string | null;
  installedThisApp: boolean;
}

export const fetchReviews = (options: {
  search?: string;
  appId?: string;
  orgId?: string;
  rating?: number | null;
  status?: string;
  linked?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<ReviewListResult> => {
  const params = new URLSearchParams();
  if (options.orgId) params.set('orgId', options.orgId);
  if (options.search) params.set('q', options.search);
  if (options.appId) params.set('appIds', options.appId);
  if (options.rating) params.set('rating', String(options.rating));
  if (options.status && options.status !== 'all') params.set('status', options.status);
  if (options.linked && options.linked !== 'all') params.set('linked', options.linked);
  if (options.sort) params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  return getJson<ReviewListResult>(`/api/reviews?${params.toString()}`);
};

export const fetchReviewCandidates = (
  reviewId: string,
  search: string,
): Promise<{ candidates: ReviewCandidate[] }> => {
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  return getJson<{ candidates: ReviewCandidate[] }>(
    `/api/reviews/${encodeURIComponent(reviewId)}/candidates?${params.toString()}`,
  );
};

/** Passing null unlinks, handing the review back to the automatic matcher. */
export const linkReviewToShop = (
  reviewId: string,
  shopId: string | null,
): Promise<{ ok: boolean; shopId: string | null; matchMethod: ReviewMatchMethod }> =>
  sendJson('PUT', `/api/reviews/${encodeURIComponent(reviewId)}/shop`, { shopId });

/* -------------------------------------------------------- app listings */

export interface AppListing {
  appId: string;
  appName: string | null;
  handle: string;
  url: string;
  /** 'config' means it came from APP_STORE_HANDLES rather than from this page. */
  source: 'manual' | 'config';
  /** The listing's own title, from the last check. */
  listingName: string | null;
  checkedAt: string | null;
  lastError: string | null;
  reviewCount: number;
}

export interface ListingSettings {
  listings: AppListing[];
  /** Apps in reporting scope, for the "which app is this?" picker. */
  apps: Array<{ id: string; name: string }>;
}

export const fetchListings = (): Promise<ListingSettings> =>
  getJson<ListingSettings>('/api/listings');

export const saveListing = (appId: string, url: string): Promise<AppListing> =>
  sendJson('PUT', `/api/listings/${encodeURIComponent(appId)}`, { url });

export const deleteListing = (appId: string): Promise<void> =>
  sendJson('DELETE', `/api/listings/${encodeURIComponent(appId)}`);

/** Fetches the listing and reports what is actually at that URL. */
export const checkListing = (appId: string): Promise<AppListing> =>
  sendJson('POST', `/api/listings/${encodeURIComponent(appId)}/check`);

/* ---------------------------------------------------------------- funnel */

export type Granularity = 'day' | 'week' | 'month' | 'previous_7_days';

export interface FunnelStep {
  key: string;
  label: string;
  description: string;
  /** Which store the figure comes from. Rendered as a pill beside each step. */
  source: 'bigquery' | 'partner';
  unit: 'visitor' | 'shop';
}

/**
 * Note that every figure is nullable. Null is not zero: it means the step could
 * not be measured — no BigQuery connection, or no listing traffic collected —
 * and rendering it as 0 would claim nobody visited the listing.
 */
export interface FunnelBucket {
  periodStart: string;
  periodEnd: string;
  counts: Array<number | null>;
  /** Percentage of the step above. Null at step 1. */
  conversion: Array<number | null>;
  conversionFromStart: Array<number | null>;
  dropOff: Array<number | null>;
  provisional?: boolean;
}

export interface FunnelResponse {
  granularity: Granularity;
  period: string;
  periodStart: string;
  periodEnd: string;
  timeSeriesInterval: string;
  appIds: string[];
  steps: FunnelStep[];
  buckets: FunnelBucket[];
  totals: Omit<FunnelBucket, 'provisional'>;
  meta: {
    bigqueryConnected: boolean;
    appsWithListingTraffic: number;
    appsInScope: number;
    appsWithoutListingTraffic: string[];
    directToPaid: number;
    /** Shops that reopened in the window, held off step 3 and said in the notes. */
    reopenedNotCounted: number;
    notes: string[];
    warnings: string[];
  };
}

/**
 * An app the funnel can be read for: one with a GA4 dataset configured.
 *
 * A separate list from `/api/apps` on purpose — an app with no dataset has no
 * top to its funnel, and there is no "all apps" entry because summing across
 * apps puts one app's visitors above several apps' installs.
 */
export interface FunnelApp {
  id: string;
  name: string;
  /** Configured but never synced is a real state, shown differently. */
  hasTraffic: boolean;
}

export const fetchFunnelApps = (orgId = ''): Promise<{ apps: FunnelApp[] }> =>
  getJson<{ apps: FunnelApp[] }>(
    `/api/funnel/apps${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`,
  );

export const fetchFunnel = (options: {
  appId?: string;
  orgId?: string;
  period: string;
  granularity: Granularity;
}): Promise<FunnelResponse> => {
  const params = new URLSearchParams({ granularity: options.granularity });
  if (options.orgId) params.set('orgId', options.orgId);
  // The range is the granularity's own when the columns are a fixed span; the
  // server ignores a period there, and sending one would imply otherwise.
  if (options.granularity !== 'previous_7_days') params.set('period', options.period);
  if (options.appId) params.set('appIds', options.appId);
  return getJson<FunnelResponse>(`/api/funnel?${params.toString()}`);
};

/* -------------------------------------------------------------- bigquery */

/**
 * The account: one project, one key, shared by every app.
 *
 * Note the absence of a dataset — that is per app — and of the service-account
 * key, which is posted once and never sent back, so a stored connection is
 * identified by the account's email and the tail of its key id.
 */
export interface BigQueryConnection {
  projectId: string;
  /** Default processing location; an app whose dataset sits elsewhere overrides it. */
  location: string;
  clientEmail: string;
  keyHint: string;
  checkedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Where one app's listing traffic lives. `dataset` null means "not set up yet". */
export interface BigQueryAppSource {
  appId: string;
  appName: string | null;
  dataset: string | null;
  location: string;
  locationOverridden: boolean;
  handle: string | null;
  apiKey: string | null;
  eventCount: number;
  lastEventAt: string | null;
}

/**
 * The manual ingest's own account of itself.
 *
 * The server forks the ingest into a child process rather than running it on
 * the request thread — it used to block the event loop for minutes and fail the
 * platform health check — so `POST /sync` returns before there is a result and
 * this is where the result eventually appears.
 */
export interface BigQuerySyncJob {
  running: boolean;
  full: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  result: ListingSyncResult | null;
  error: string | null;
}

export interface BigQuerySettings {
  connection: BigQueryConnection | null;
  sources: BigQueryAppSource[];
  stats: { events: number; earliest: string | null; latest: string | null };
  job: BigQuerySyncJob;
}

/** The account check: does the key work, and what datasets can it see. */
export interface BigQueryCheck {
  ok: boolean;
  error: string | null;
  datasets: string[];
}

/** The per-app check: is that dataset really a GA4 export, and how far back. */
export interface BigQueryAppCheck {
  ok: boolean;
  error: string | null;
  tables: number;
  earliest: string | null;
  latest: string | null;
  /** Set when the GA4 property's day starts elsewhere than the reports' does. */
  timezoneWarning: string | null;
}

export interface ListingSyncResult {
  apps: string[];
  rows: number;
  skipped: Array<{ appId: string; reason: string }>;
}

const BQ = '/api/bigquery';

export const fetchBigQuery = (): Promise<BigQuerySettings> => getJson<BigQuerySettings>(BQ);

export const saveBigQuery = (input: {
  projectId: string;
  location: string;
  /** Omitted on an edit that keeps the stored key. */
  credentials?: string;
}): Promise<BigQuerySettings> => sendJson<BigQuerySettings>('PUT', BQ, input);

export const disconnectBigQuery = (): Promise<void> => sendJson<void>('DELETE', BQ);

export const checkBigQuery = (): Promise<BigQuerySettings & { check: BigQueryCheck }> =>
  sendJson('POST', `${BQ}/check`);

export const checkBigQueryApp = (
  appId: string,
): Promise<BigQuerySettings & { check: BigQueryAppCheck }> =>
  sendJson('POST', `${BQ}/apps/${encodeURIComponent(appId)}/check`);

export const saveBigQueryAppSource = (
  appId: string,
  patch: { dataset?: string; location?: string; handle?: string; apiKey?: string },
): Promise<BigQueryAppSource> =>
  sendJson('PUT', `${BQ}/apps/${encodeURIComponent(appId)}`, patch);

/**
 * Starts an ingest. Resolves as soon as the job is accepted (HTTP 202), not
 * when it has finished — read `job` from `fetchBigQuery()` for that. A 409
 * (a run is already going) arrives here as a thrown error with the server's
 * message, which is the right thing to show.
 */
export const syncBigQuery = (
  full = false,
): Promise<BigQuerySettings & { accepted: boolean }> =>
  sendJson('POST', `${BQ}/sync${full ? '?full=1' : ''}`);

/* --------------------------------------------------------- notifications */

export interface NotificationTopic {
  key: string;
  label: string;
  description: string;
  eventTypes: string[];
  /** What the toggle promises, in the reader's words. */
  covers: string[];
}

/**
 * Note the absence of a webhook URL. It goes to the server once and is never
 * sent back, so a channel is identified here by its name and a masked hint.
 */
export interface NotificationChannel {
  id: string;
  name: string;
  webhookHint: string;
  createdAt: string;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  topics: string[];
}

export interface NotificationSettings {
  topics: NotificationTopic[];
  channels: NotificationChannel[];
}

const CHANNELS = '/api/notifications/channels';

export const fetchNotifications = (): Promise<NotificationSettings> =>
  getJson<NotificationSettings>('/api/notifications');

export const createChannel = (input: {
  name: string;
  webhookUrl: string;
}): Promise<NotificationChannel> => sendJson<NotificationChannel>('POST', CHANNELS, input);

export const updateChannel = (
  id: string,
  patch: { name?: string; webhookUrl?: string },
): Promise<NotificationChannel> =>
  sendJson<NotificationChannel>('PATCH', `${CHANNELS}/${encodeURIComponent(id)}`, patch);

export const deleteChannel = (id: string): Promise<void> =>
  sendJson<void>('DELETE', `${CHANNELS}/${encodeURIComponent(id)}`);

export const setChannelTopic = (
  id: string,
  topic: string,
  enabled: boolean,
): Promise<NotificationChannel> =>
  sendJson<NotificationChannel>(
    'PUT',
    `${CHANNELS}/${encodeURIComponent(id)}/topics/${encodeURIComponent(topic)}`,
    { enabled },
  );

export const testChannel = (
  id: string,
): Promise<{ ok: boolean; error: string | null; channel: NotificationChannel }> =>
  sendJson('POST', `${CHANNELS}/${encodeURIComponent(id)}/test`);

/* ------------------------------------------------------------ affiliates
 *
 * The admin side of the affiliate program. Everything below reads
 * `/api/affiliates/*`, which sits behind the same password gate as the rest of
 * the dashboard — it can reassign a merchant, and reassigning a merchant moves
 * money between two people.
 *
 * Two of these endpoints may not exist on the server the browser is talking to:
 * payouts are being added alongside this UI, and there is no cross-affiliate
 * referral feed at all. Both are typed here as they are contracted, and both
 * have a `probe` variant that answers `null` on a 404 so a page can show an
 * empty state instead of an error the operator can do nothing about.
 */

const AFFILIATES = '/api/affiliates';

/** Null on 404 — the route is not deployed — and throws on anything else. */
async function probe<T>(url: string): Promise<T | null> {
  try {
    return await getJson<T>(url);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export type AffiliateSort = 'outstanding' | 'earned' | 'paid' | 'referrals' | 'name' | 'newest';

export interface AffiliateSummary {
  id: string;
  name: string;
  email: string;
  /** 'active' | 'disabled'. */
  status: string;
  payoutHold: boolean;
  createdAt: string;
  /** Every handle they hold, across programs — the code a merchant followed. */
  handles: string[];
  memberships: number;
  pendingMemberships: number;
  referrals: number;
  earned: number;
  paid: number;
  /** Earned less paid. May be negative; that is a finding, not an error. */
  outstanding: number;
}

export interface AffiliateListResult {
  affiliates: AffiliateSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AffiliateMembership {
  id: string;
  programId: string;
  programName: string;
  appId: string;
  handle: string;
  /** 'enrolled' | 'pending' | 'rejected'. */
  status: string;
  joinedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  requiresApproval: boolean;
}

/* ------------------------------------------------------------- merchants
 *
 * The merchant as the admin API describes them, from the shared read model in
 * `src/merchants`. One shape wherever a store appears — the referral feed, an
 * affiliate's referrals, the claim queue, a payout's itemisation — so the same
 * merchant is rendered the same way on all four rather than as a name here and
 * a bare domain there.
 *
 * `unknown` is a value on both standings and it is the common one today:
 * `subscriptions` and `install_intervals` are rebuilt after the transaction
 * backfill, which has not finished, so they are currently empty. The UI renders
 * unknown as unknown. It must never become "Free", "None", "$0" or
 * "Uninstalled" — those are claims about a merchant's business that we cannot
 * currently support, and the operator would have no way to tell them from real
 * answers.
 */

/** `unknown` means "not synced yet", never "not paying". */
export type PlanStanding = 'paying' | 'free' | 'unknown';
/** `unknown` means "no install history synced", never "they left". */
export type InstallStanding = 'installed' | 'uninstalled' | 'unknown';

export interface Merchant {
  /** Null when this merchant is not in `shops` at all. */
  shopId: string | null;
  myshopifyDomain: string | null;
  name: string | null;
  /** False when there is no `shops` row, which makes everything else unknown. */
  known: boolean;
  install: InstallStanding;
  plan: PlanStanding;
  /** Null unless `plan` is 'paying'. */
  planName: string | null;
  monthlyAmount: number | null;
  currency: string | null;
}

/** How the claim arose. Only `ga4` is automated. */
export type ReferralSource = 'ga4' | 'manual' | 'imported' | string;

export interface AffiliateReferral {
  id: string;
  programId: string;
  programName: string;
  shopId: string;
  myshopifyDomain: string;
  shopName: string | null;
  /**
   * The store behind the referral. Optional only so a page rendered against an
   * older server degrades to the domain rather than crashing.
   */
  merchant?: Merchant;
  referredAt: string;
  source: ReferralSource;
  handle: string;
  /** Set once the referral has been unassigned. Soft: past earnings stand. */
  unassignedAt: string | null;
  commissions: number;
  earned: number;
}

export interface AffiliateCommission {
  id: string;
  attributionId: string;
  myshopifyDomain: string;
  amount: number;
  currency: string;
  basisAmount: number | null;
  earnedAt: string;
  paidAt: string | null;
  paidAmount: number | null;
  paymentReference: string | null;
  cancelledAt: string | null;
  /** 'computed' | 'imported'. */
  source: string;
}

export interface AffiliateDetail {
  affiliate: AffiliateSummary & { paypalEmail: string | null; source: string };
  memberships: AffiliateMembership[];
  referrals: AffiliateReferral[];
  commissions: AffiliateCommission[];
}

export interface AffiliateProgram {
  id: string;
  name: string;
  appId: string;
  /** A fraction: 0.2 is twenty percent. */
  commissionRate: number;
  /** Null means lifetime. */
  durationMonths: number | null;
  requiresApproval: boolean;
  status: string;
  /** Enrolled memberships only — pending and rejected are not counted. */
  affiliates: number;
  /*
   * Stored on the program but not returned by the current endpoint. Typed as
   * optional so the page fills them in the day the server starts sending them,
   * and says "not reported" until then rather than inventing terms.
   */
  revenueComponents?: string[];
  unassignAfterUninstallDays?: number | null;
}

export interface PendingMembership {
  id: string;
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  programId: string;
  programName: string;
  handle: string;
  status: string;
  joinedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
}

export interface ReconciliationRow {
  affiliateId: string;
  name: string;
  email: string;
  payoutHold: boolean;
  commissions: number;
  earned: number;
  paid: number;
  outstanding: number;
}

export interface Reconciliation {
  totals: {
    affiliates: number;
    owed: number;
    commissions: number;
    earned: number;
    paid: number;
    outstanding: number;
    cancelled: number;
    cancelledAmount: number;
    /** More than one entry means the totals add unlike units. Say so. */
    currencies: string[];
  };
  affiliates: ReconciliationRow[];
}

/** A live credential. Twenty-four hours, one click to own the account. */
export interface SetPasswordLink {
  affiliateId: string;
  name: string;
  email: string;
  url: string;
  expiresAt: string;
}

export const fetchAffiliates = (options: {
  search?: string;
  sort?: AffiliateSort;
  limit?: number;
  offset?: number;
}): Promise<AffiliateListResult> => {
  const params = new URLSearchParams();
  if (options.search) params.set('q', options.search);
  if (options.sort) params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  const query = params.toString();
  return getJson<AffiliateListResult>(`${AFFILIATES}${query ? `?${query}` : ''}`);
};

export const fetchAffiliate = (affiliateId: string): Promise<AffiliateDetail> =>
  getJson<AffiliateDetail>(`${AFFILIATES}/${encodeURIComponent(affiliateId)}`);

export const fetchAffiliatePrograms = (): Promise<{ programs: AffiliateProgram[] }> =>
  getJson<{ programs: AffiliateProgram[] }>(`${AFFILIATES}/programs`);

/** One version of a programme's money terms. */
export interface ProgramTermsVersion {
  id: string;
  effectiveFrom: string;
  note: string;
  createdAt: string;
  payoutBasis: 'percent_of_gross' | 'flat_per_referral';
  commissionRate: number;
  flatAmount: number;
  flatCurrency: string;
  revenueComponents: string[];
  recurrence: 'recurring' | 'first_charge_only';
  durationMonths: number | null;
  unassignAfterUninstallDays: number | null;
  enforceUnassignAfterUninstall: boolean;
  minimumPayout: number;
  termsUrl: string;
}

/** A programme as the edit screen needs it: current terms plus their history. */
export interface ProgramDetail {
  id: string;
  name: string;
  appId: string;
  listingUrl: string;
  commissionRate: number;
  revenueComponents: string[];
  durationMonths: number | null;
  unassignAfterUninstallDays: number | null;
  requireApproval: boolean;
  status: 'active' | 'closed';
  payoutBasis: 'percent_of_gross' | 'flat_per_referral';
  flatAmount: number;
  flatCurrency: string;
  recurrence: 'recurring' | 'first_charge_only';
  enforceUnassignAfterUninstall: boolean;
  minimumPayout: number;
  termsUrl: string;
  affiliates: number;
  createdAt: string;
  versions: ProgramTermsVersion[];
}

export type ProgramTermsInput = Partial<
  Pick<
    ProgramDetail,
    | 'name'
    | 'appId'
    | 'listingUrl'
    | 'commissionRate'
    | 'revenueComponents'
    | 'durationMonths'
    | 'unassignAfterUninstallDays'
    | 'requireApproval'
    | 'status'
    | 'payoutBasis'
    | 'flatAmount'
    | 'flatCurrency'
    | 'recurrence'
    | 'enforceUnassignAfterUninstall'
    | 'minimumPayout'
    | 'termsUrl'
  >
> & {
  /** Backdates a change. Refused when it would re-price a paid commission. */
  effectiveFrom?: string;
  note?: string;
};

export const fetchProgram = (programId: string): Promise<{ program: ProgramDetail }> =>
  getJson<{ program: ProgramDetail }>(`${AFFILIATES}/programs/${encodeURIComponent(programId)}`);

export const createProgram = (input: ProgramTermsInput): Promise<{ program: ProgramDetail }> =>
  sendJson('POST', `${AFFILIATES}/programs`, input);

export const updateProgram = (
  programId: string,
  input: ProgramTermsInput,
): Promise<{ program: ProgramDetail; commissions: { written: number; amount: number } }> =>
  sendJson('PATCH', `${AFFILIATES}/programs/${encodeURIComponent(programId)}`, input);

/** What state the affiliate section is in. Figures, read fresh. */
export interface AffiliateSetup {
  programs: number;
  activePrograms: number;
  programsWithListing: number;
  affiliates: number;
  enrolledAffiliates: number;
  attribution: 'ga4' | 'manual';
  attributionApps: number;
  portalBaseUrl: string;
  emailEnabled: boolean;
  incomplete: boolean;
}

export const fetchAffiliateSetup = (): Promise<{ setup: AffiliateSetup }> =>
  getJson<{ setup: AffiliateSetup }>(`${AFFILIATES}/setup`);

export interface CreatedAffiliate {
  affiliate: { id: string; name: string; email: string };
  membership: { programId: string; handle: string; status: string } | null;
  /**
   * A 24-hour account-takeover credential. Shown once, to the operator, because
   * they are the only one who can deliver it when no mail relay is configured.
   * Never logged, never persisted client-side.
   */
  setPasswordUrl: string | null;
  setPasswordExpiresAt: string | null;
}

export const createAffiliate = (input: {
  name: string;
  email: string;
  paypalEmail?: string;
  programId?: string;
  handle?: string;
}): Promise<CreatedAffiliate> => sendJson('POST', AFFILIATES, input);

export const fetchReconciliation = (): Promise<Reconciliation> =>
  getJson<Reconciliation>(`${AFFILIATES}/reconciliation`);

export const fetchPendingMemberships = (): Promise<{ memberships: PendingMembership[] }> =>
  getJson<{ memberships: PendingMembership[] }>(`${AFFILIATES}/memberships/pending`);

export const decideMembership = (
  membershipId: string,
  decision: 'approve' | 'reject',
): Promise<{ id: string; status: string }> =>
  sendJson('POST', `${AFFILIATES}/memberships/${encodeURIComponent(membershipId)}/${decision}`);

/** Assign a merchant to an affiliate by hand. Recomputes commissions inline. */
export const assignAttribution = (
  affiliateId: string,
  input: { programId: string; myshopifyDomain?: string; shopId?: string; referredAt?: string },
): Promise<{ attribution: { id: string; replaced: { id: string } | null } }> =>
  sendJson('POST', `${AFFILIATES}/${encodeURIComponent(affiliateId)}/attributions`, input);

/** Soft. Earnings already booked under the referral stand. */
export const unassignAttribution = (
  attributionId: string,
): Promise<{ attribution: { id: string; unassignedAt: string } }> =>
  sendJson('DELETE', `${AFFILIATES}/attributions/${encodeURIComponent(attributionId)}`);

export const mintSetPasswordLink = (affiliateId: string): Promise<{ link: SetPasswordLink }> =>
  sendJson('POST', `${AFFILIATES}/${encodeURIComponent(affiliateId)}/set-password-link`);

/* ----------------------------------------------------------------- claims */

/**
 * An attribution claim: an affiliate asserting a merchant was theirs.
 *
 * The queue this types is a decision list, not a report. A pending share of the
 * imported claims is undecided on purpose — they were imported as-is so a
 * person could work through them — and every field here exists to make one of
 * those decisions possible.
 *
 * The `attributed*` fields are the reason the queue is workable at all. They say
 * who holds the claimed merchant **right now**, which is a different question
 * from `attributionId` (the referral this claim itself produced, once approved).
 * Approving a claim on a merchant somebody else holds displaces that person's
 * referral, so the queue has to say so before the button is pressed.
 *
 * What is deliberately absent, and must stay absent: any score, confidence,
 * risk flag or "suspicious" marker. These are facts about the state of the
 * ledger. The judgement is the operator's.
 */
export interface Claim {
  id: string;
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  programId: string;
  programName: string;
  shopId: string;
  myshopifyDomain: string;
  /** `shops.name` where the merchant has synced, else what the claimant typed. */
  merchant: string;
  /**
   * The same store through the shared merchant read model — domain, install
   * standing and current plan, each of which may honestly be `unknown`.
   *
   * Admin only, and never sent to the portal: with the commission rate
   * published, a merchant's plan beside a commission amount is that merchant's
   * revenue. Optional so a page rendered against an older server degrades to
   * the domain rather than crashing.
   */
  merchantRecord?: Merchant;
  claimedAt: string;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  decidedBy: string;
  decisionNotes: string | null;
  /** The referral this claim produced. Null until approved, and after a rejection. */
  attributionId: string | null;
  createdAt: string;
  /** Who the merchant is credited to today. Null when nobody holds them. */
  attributedAffiliateId: string | null;
  attributedAffiliateName: string | null;
  attributedAt: string | null;
  attributedSource: string | null;
}

export interface ClaimPage {
  claims: Claim[];
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export const fetchClaims = (options: {
  status?: string;
  affiliateId?: string;
  programId?: string;
  /** Store name or myshopify domain, matched server-side beside the paging. */
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<ClaimPage> => {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.affiliateId) params.set('affiliateId', options.affiliateId);
  if (options.programId) params.set('programId', options.programId);
  if (options.search) params.set('q', options.search);
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return getJson<ClaimPage>(`${AFFILIATES}/claims${query ? `?${query}` : ''}`);
};

/**
 * Approve or reject one claim.
 *
 * Approving writes a referral through `assignAttribution` — the same function
 * the manual-assignment endpoint calls — and recomputes commissions inline, so
 * the response carries the recompute. Rejecting records the decision and
 * creates nothing.
 */
export const decideClaim = (
  claimId: string,
  decision: 'approve' | 'reject',
  body: { decidedBy?: string; notes?: string } = {},
): Promise<{
  claim: {
    id: string;
    status: 'approved' | 'rejected';
    decidedAt: string;
    attributionId: string | null;
    /** The live referral an approval displaced. Soft-deleted, not gone. */
    replaced: { id: string; affiliateId: string; source: string } | null;
  };
}> => sendJson('POST', `${AFFILIATES}/claims/${encodeURIComponent(claimId)}/${decision}`, body);

/* ---------------------------------------------------------------- payouts */

export interface Payout {
  id: string;
  number: string | number | null;
  affiliateId: string;
  affiliateName: string | null;
  affiliateEmail: string | null;
  programId: string | null;
  programName: string | null;
  status: string;
  amount: number;
  amountPaid: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  commissionCount: number | null;
}

export interface PayoutListResult {
  payouts: Payout[];
  total: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
}

/**
 * A commission as the payout detail returns it.
 *
 * Not the same shape as `AffiliateCommission`: this one carries the merchant
 * and no `basisAmount`, because the question a payout page answers is "what did
 * this payment settle, and for which stores".
 */
export interface PayoutCommission {
  id: string;
  amount: number;
  currency: string;
  earnedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  shop: string;
  myshopifyDomain: string;
  merchant?: Merchant;
  /** Present on the affiliate detail page's ledger, absent here. */
  basisAmount?: number | null;
  paymentReference?: string | null;
}

export interface PayoutDetailResult {
  payout: Payout;
  commissions: PayoutCommission[];
}

/** Null while the payouts endpoint is not deployed; the page shows that state. */
export const fetchPayouts = (options: {
  affiliateId?: string;
  programId?: string;
  status?: string;
  page?: number;
  limit?: number;
  sort?: string;
  sortDirection?: string;
}): Promise<PayoutListResult | null> => {
  const params = new URLSearchParams();
  if (options.affiliateId) params.set('affiliateId', options.affiliateId);
  if (options.programId) params.set('programId', options.programId);
  if (options.status && options.status !== 'all') params.set('status', options.status);
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  if (options.sort) params.set('sort', options.sort);
  if (options.sortDirection) params.set('sortDirection', options.sortDirection);
  const query = params.toString();
  return probe<PayoutListResult>(`${AFFILIATES}/payouts${query ? `?${query}` : ''}`);
};

export const fetchPayout = (id: string): Promise<PayoutDetailResult | null> =>
  probe<PayoutDetailResult>(`${AFFILIATES}/payouts/${encodeURIComponent(id)}`);

/* -------------------------------------------------------- referral feed */

/** One referral, carrying the affiliate it belongs to. */
export interface ReferralFeedRow extends AffiliateReferral {
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
}

export interface ReferralFeedResult {
  referrals: ReferralFeedRow[];
  total: number;
  /**
   * Figures over the whole filtered set, not over the page. Optional because an
   * older server does not send them; a page that has them shows them and a page
   * that does not shows nothing rather than a page-local sum under a total's
   * label.
   */
  counts?: {
    total: number;
    live: number;
    unassigned: number;
    earned: number;
    bySource: Array<{ source: string; n: number }>;
  };
  page?: number;
  limit?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
}

/**
 * Every referral across every affiliate.
 *
 * There is no such endpoint today — `/api/affiliates/:id` is the only place a
 * referral is returned — so this asks for one and answers null when the server
 * has never heard of it. `assembleReferralFeed` in `AffiliateData.ts` is the
 * fallback, and it is the path in use until this route exists.
 */
export const fetchReferralFeed = (): Promise<ReferralFeedResult | null> =>
  probe<ReferralFeedResult>(`${AFFILIATES}/referrals?limit=2000`);

/**
 * One page of the referral feed, filtered and searched on the server.
 *
 * The paged sibling of `fetchReferralFeed`. Search matches the store name or
 * the myshopify domain — the operator has one of the two and does not know
 * which — and it runs in SQL beside the paging, because a filter applied after
 * paging filters the fifty rows on screen rather than every row in the table.
 */
export const fetchReferrals = (options: {
  programId?: string;
  affiliateId?: string;
  source?: string;
  standing?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<ReferralFeedResult | null> => {
  const params = new URLSearchParams();
  if (options.programId) params.set('programId', options.programId);
  if (options.affiliateId) params.set('affiliateId', options.affiliateId);
  if (options.source) params.set('source', options.source);
  if (options.standing && options.standing !== 'all') params.set('standing', options.standing);
  if (options.search) params.set('q', options.search);
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return probe<ReferralFeedResult>(`${AFFILIATES}/referrals${query ? `?${query}` : ''}`);
};


/* --------------------------------------------------------- organizations */

/**
 * A Shopify Partner organization as the admin API describes it.
 *
 * Note the absence of a token. It is posted once and never sent back, so a
 * stored credential is identified here by four characters of hint — the same
 * bargain the BigQuery key and the Slack webhook already make. A token that is
 * set can be replaced without ever being shown.
 */
export interface Organization {
  id: string;
  label: string;
  /** Last four characters, or '' when no token is stored. */
  tokenHint: string;
  hasToken: boolean;
  /** 'env' means it was seeded from PARTNER_ORG_<n>_*; editing takes it over. */
  source: 'env' | 'manual';
  /** Set when the organization was removed. Its data is kept regardless. */
  disabledAt: string | null;
  checkedAt: string | null;
  checkNote: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /* ------------------------------------------------------ sync health */
  apps: number;
  lastSyncAt: string | null;
  phase: string | null;
  phaseStartedAt: string | null;
  syncError: string | null;
  syncErrorPhase: string | null;
  syncErrorAt: string | null;
  inEnvironment: boolean;
  /** The environment names a different token for this one. Reported, not resolved. */
  envDiffers: boolean;
}

/** What the Partner API said when the credential was tried. */
export interface OrganizationCheck {
  ok: boolean;
  organizationId: string;
  apps: Array<{ id: string; name: string }>;
  transactions: number;
  error: string | null;
  note: string | null;
}

export interface OrganizationList {
  organizations: Organization[];
}

const ORGS = '/api/organizations';

export const fetchOrganizations = (): Promise<OrganizationList> =>
  getJson<OrganizationList>(ORGS);

/** Verifies against the Partner API first; a refusal is a 400 carrying `check`. */
export const createOrganization = (input: {
  organizationId: string;
  label: string;
  token: string;
  force?: boolean;
}): Promise<OrganizationList & { check: OrganizationCheck }> => sendJson('POST', ORGS, input);

/** Omit `token` to keep the stored one — that is how a rename works. */
export const updateOrganization = (
  id: string,
  patch: { label?: string; token?: string; force?: boolean },
): Promise<OrganizationList & { check?: OrganizationCheck }> =>
  sendJson('PATCH', `${ORGS}/${encodeURIComponent(id)}`, patch);

/** Soft. The response says what was kept. */
export const removeOrganization = (
  id: string,
): Promise<OrganizationList & { kept: { apps: number; history: string } }> =>
  sendJson('DELETE', `${ORGS}/${encodeURIComponent(id)}`);

export const checkOrganization = (
  id: string,
): Promise<OrganizationList & { check: OrganizationCheck }> =>
  sendJson('POST', `${ORGS}/${encodeURIComponent(id)}/check`);

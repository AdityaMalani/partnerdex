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
  apps: number;
  shops: number;
  events: number;
  transactions: number;
  subscriptions: number;
  customerEvents: number;
  lastSyncAt: string | null;
  sync: SyncStatus;
}

export interface QueryState {
  period: string;
  appId: string;
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
    throw new Error(message);
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

export const fetchApps = (): Promise<{ apps: AppSummary[] }> =>
  getJson<{ apps: AppSummary[] }>('/api/apps');

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
}): Promise<CustomerListResult> => {
  const params = new URLSearchParams();
  if (options.search) params.set('q', options.search);
  if (options.sort) params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  if (options.appId) params.set('appIds', options.appId);
  return getJson<CustomerListResult>(`/api/customers?${params.toString()}`);
};

export const fetchCustomer = (shopId: string, appId = ''): Promise<CustomerDetail> => {
  const params = new URLSearchParams();
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
  rating?: number | null;
  status?: string;
  linked?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<ReviewListResult> => {
  const params = new URLSearchParams();
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

export const fetchFunnelApps = (): Promise<{ apps: FunnelApp[] }> =>
  getJson<{ apps: FunnelApp[] }>('/api/funnel/apps');

export const fetchFunnel = (options: {
  appId?: string;
  period: string;
  granularity: Granularity;
}): Promise<FunnelResponse> => {
  const params = new URLSearchParams({ granularity: options.granularity });
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

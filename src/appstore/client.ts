/**
 * Fetching listing pages from the public App Store.
 *
 * Deliberately not part of `partner/`. That module speaks one authenticated
 * GraphQL endpoint with a documented throttle and a `THROTTLED` error code; this
 * one reads unauthenticated HTML from a different host with no contract at all,
 * and folding the two together would mean either module's failures being
 * described in the other's vocabulary.
 *
 * What we owe the host, since nothing here is rate-limited on their side and
 * a full sweep of a large listing is hundreds of requests:
 *
 *   - one request at a time, never concurrent
 *   - a floor on the gap between them, enforced here rather than by callers
 *   - a User-Agent that says what this is, so it is identifiable in their logs
 *   - `Retry-After` obeyed when offered
 *
 * `apps.shopify.com/robots.txt` excludes `/internal/`, `/services/`, `*q=*` and
 * the auth query params. Listing and review paths are not excluded, and the
 * pages are public and unauthenticated — but the politeness above is what makes
 * that fact stay true for everyone else too.
 */

const HOST = 'https://apps.shopify.com';

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;

/** Minimum gap between two requests to the App Store, in milliseconds. */
const MIN_SPACING_MS = 1000;

/**
 * How long one listing page may take before it is treated as a hang.
 *
 * This host has no contract with us at all, so a request that is accepted and
 * never answered is entirely possible and nothing above would notice: the retry
 * loop below handles errors and bad statuses, and a request that never settles
 * is neither. The review sweep sits in the middle of the sync, before the
 * rebuild, so one dead socket here parks everything after it.
 *
 * A minute is far more than an HTML page needs and is not a latency budget.
 */
function requestTimeoutMs(): number {
  const raw = Number(process.env.APPSTORE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * A ceiling on `Retry-After`, for the same reason the Partner client has one:
 * the header is a request, not an instruction to park a sync indefinitely.
 */
const MAX_RETRY_AFTER_MS = 60_000;

const USER_AGENT =
  'PartnerDex/0.1 (+https://github.com/AdityaMalani/partnerdex; self-hosted partner analytics reading its own app listing)';

export class AppStoreError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'AppStoreError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The instant the next request is allowed to leave.
 *
 * Module-level because the budget belongs to the host, not to any one crawl:
 * two apps being swept in the same run are still one stream of requests as far
 * as Shopify is concerned.
 */
let nextAllowedAt = 0;

async function waitForTurn(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowedAt = Date.now() + MIN_SPACING_MS;
}

/** The reviews page URL for a listing. Page numbers are 1-based. */
export function reviewsPageUrl(handle: string, page: number): string {
  return `${HOST}/${handle}/reviews?sort_by=newest&page=${page}`;
}

/**
 * One reviews page as raw HTML.
 *
 * A 404 is called out separately because it has exactly one cause worth acting
 * on — a handle that does not exist — and it is the mistake a partner is most
 * likely to make when filling in `APP_STORE_HANDLES` by hand.
 */
export async function fetchReviewsPage(handle: string, page: number): Promise<string> {
  const url = reviewsPageUrl(handle, page);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await waitForTurn();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(requestTimeoutMs()),
      });
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) {
        throw new AppStoreError(`Network error fetching ${url}: ${String(cause)}`, null);
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new AppStoreError(
          `App Store returned ${response.status} for ${url} after ${MAX_ATTEMPTS} attempts.`,
          response.status,
        );
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
          : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    if (response.status === 404) {
      throw new AppStoreError(
        `No App Store listing at https://${new URL(url).host}/${handle}. Check the URL on the ` +
          `App listings page — it is the address of your app's own page on the App Store.`,
        404,
      );
    }

    if (!response.ok) {
      throw new AppStoreError(`App Store returned ${response.status} for ${url}.`, response.status);
    }

    return await response.text();
  }

  throw new AppStoreError(`Exhausted retries fetching ${url}.`, null);
}

/** Test seam: forget the spacing budget so a fake fetch does not wait on it. */
export function resetRequestSpacing(): void {
  nextAllowedAt = 0;
}

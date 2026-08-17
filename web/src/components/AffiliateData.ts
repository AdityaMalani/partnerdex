import {
  fetchAffiliate,
  fetchAffiliates,
  fetchReferralFeed,
  type ReferralFeedRow,
  type ReferralSource,
} from '../api';

/**
 * The cross-affiliate referral feed, and how it is obtained when the server
 * cannot answer for it.
 *
 * The admin API returns referrals one affiliate at a time. Every other affiliate
 * page is a straight read of an endpoint; this one is not, because "every
 * referral, filterable by source" has no route behind it. Rather than drop the
 * view — the source split is the point, a large minority of the imported
 * referrals were manual assignments and telling them apart is why an operator
 * opens it — the feed is assembled in the browser out of the per-affiliate records.
 *
 * Three things keep that honest rather than merely clever:
 *
 *   - **It is bounded and complete.** Every affiliate is read once — hundreds of
 *     requests against an indexed local store, answered in well under a second
 *     — rather than only the ones the list says currently hold a referral,
 *     which would silently drop every referral that has been unassigned.
 *   - **It is cached for the session**, so moving between Referrals and
 *     Programs — which needs the same figures per program — costs nothing the
 *     second time. Assigning or unassigning a merchant clears it.
 *   - **It says so.** The page shows how it was built and how many records it
 *     read, so nobody mistakes a client-side assembly for a server-side report.
 *
 * The moment `GET /api/affiliates/referrals` exists, `fetchReferralFeed` answers
 * and the fallback is never reached.
 */

export interface ReferralFeed {
  rows: ReferralFeedRow[];
  /** How the feed was obtained, which the page states rather than hides. */
  origin: 'server' | 'assembled';
  /** Affiliate records read to build it. Zero when the server answered. */
  affiliatesRead: number;
  loadedAt: string;
}

/** How many affiliate records are in flight at once during an assembly. */
const CONCURRENCY = 8;

/** The affiliate list's own ceiling, so the sweep is two requests, not thirteen. */
const LIST_PAGE = 500;

let cache: ReferralFeed | null = null;
let inFlight: Promise<ReferralFeed> | null = null;

/** Drop the cached feed. Called after anything that moves a referral. */
export function invalidateReferralFeed(): void {
  cache = null;
  inFlight = null;
}

/** Runs `worker` over `items`, at most `CONCURRENCY` at a time, in order. */
async function mapLimit<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
      done += 1;
      onProgress?.(done, items.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

/**
 * Every referral, from the server if it will answer and from the affiliates if
 * it will not.
 *
 * `onProgress` is called during an assembly so the page can show what it is
 * doing; a session that already has the feed resolves immediately and never
 * calls it.
 */
export function loadReferralFeed(
  onProgress?: (done: number, total: number) => void,
): Promise<ReferralFeed> {
  if (cache) return Promise.resolve(cache);
  // A second view mounting mid-assembly joins the first one rather than
  // starting a second sweep of its own.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<ReferralFeed> => {
    const served = await fetchReferralFeed();
    if (served) {
      const feed: ReferralFeed = {
        rows: served.referrals,
        origin: 'server',
        affiliatesRead: 0,
        loadedAt: new Date().toISOString(),
      };
      cache = feed;
      return feed;
    }

    /*
     * Every affiliate, not only the ones the list says have referrals.
     *
     * Tempting shortcut, and wrong: the list's `referrals` figure counts live
     * claims only, so an affiliate whose referrals have all been unassigned
     * reports zero and would be skipped — losing a handful of the rows here,
     * and losing exactly the rows somebody asking "why did my earnings drop"
     * is looking for. The sweep reads every affiliate rather than only the
     * ones the list reports as holding a referral, and still answers in a
     * fraction of a second on a local store; correctness is worth the five-fold
     * cost of a read that happens once a session.
     */
    const everyone: Array<{ id: string }> = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const page = await fetchAffiliates({ sort: 'name', limit: LIST_PAGE, offset });
      everyone.push(...page.affiliates);
      if (page.affiliates.length === 0 || everyone.length >= page.total) break;
    }

    const details = await mapLimit(everyone, (row) => fetchAffiliate(row.id), onProgress);

    const rows: ReferralFeedRow[] = [];
    for (const detail of details) {
      for (const referral of detail.referrals) {
        rows.push({
          ...referral,
          affiliateId: detail.affiliate.id,
          affiliateName: detail.affiliate.name,
          affiliateEmail: detail.affiliate.email,
        });
      }
    }
    rows.sort((a, b) => b.referredAt.localeCompare(a.referredAt));

    const feed: ReferralFeed = {
      rows,
      origin: 'assembled',
      affiliatesRead: everyone.length,
      loadedAt: new Date().toISOString(),
    };
    cache = feed;
    return feed;
  })();

  // A failed assembly must not be cached as the answer, or the page is stuck
  // with it until a reload.
  inFlight.catch(() => {
    inFlight = null;
  });

  return inFlight;
}

/* ----------------------------------------------------------- presentation */

export const SOURCE_LABEL: Record<string, string> = {
  ga4: 'GA4',
  manual: 'Manual',
  imported: 'Imported',
};

/** Unknown sources keep their own name rather than becoming "Other". */
export function sourceLabel(source: ReferralSource): string {
  return SOURCE_LABEL[source] ?? source;
}

/** 0.2 → "20%". Rates are stored as fractions; nobody reads them that way. */
export function formatRate(rate: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate * 100)}%`;
}

/** Null months is not "0 months" — it is the whole of the relationship. */
export function formatDuration(months: number | null): string {
  if (months === null) return 'Lifetime';
  return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * The link an affiliate hands out.
 *
 * Absolute, because this one is going into an email rather than into a click on
 * this page — the server builds it relative for exactly the opposite reason.
 */
export function referralLink(handle: string): string {
  return `${window.location.origin}/r/${encodeURIComponent(handle)}`;
}

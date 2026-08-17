import type { Attribution } from './ga4Attribution.js';

/**
 * Diffing a GA4-only reconstruction of affiliate attribution against Mantle's
 * own history.
 *
 * The point of this module is that **Mantle is not ground truth**. It is the
 * other witness. Mantle attributed forward from the day its integration was
 * switched on, over a GA4 poll that ran every ten minutes and demonstrably had
 * gaps; we now hold the complete daily export and a pipeline that reproduces
 * its rule. Neither side is authoritative, so the only honest output is a
 * four-way split — agreed, ours only, theirs only, and *contradicted* — with
 * the last two examined rather than reconciled away.
 *
 * Nothing here queries anything. Every function takes plain rows and returns
 * plain rows, so the parts that decide who was owed money can be held to
 * fixtures instead of to a BigQuery bill and a 1.8 GB database.
 */

/* --------------------------------------------------------------- merging */

/**
 * A merchant may have installed, uninstalled and installed again.
 *
 * The backfill runs a month at a time, and `selectFirstTouch` picks one
 * attribution per shop *within one run*. A merchant who installed in May 2025
 * and again in Feb 2026 therefore comes back twice, once from each chunk, and
 * the two are not duplicates — they are two genuinely different installs that
 * may carry two genuinely different referrals.
 *
 * The earliest install wins, which is the same first-touch principle one level
 * up: the affiliate who sent the merchant the first time is the one who sent
 * them. A later reinstall claimed by a second affiliate is not a second
 * commission, it is a conflict, and it is kept in `reinstalls` rather than
 * dropped silently — an affiliate whose link produced a reinstall has a case to
 * argue even if this pipeline does not credit them for it.
 *
 * Note what this cannot see. GA4's `shop_id` identifies the shop, but the
 * install event is only recorded when the merchant's browser was reachable, so
 * an uninstall/reinstall pair where only the second install was observed looks
 * exactly like a first install. The count below is a floor on reinstalls, not a
 * census of them.
 */
export interface MergedAttribution extends Attribution {
  /** How many separate installs of this shop the export shows. 1 is the norm. */
  installCount: number;
}

export interface ReinstallConflict {
  appId: string;
  shopId: string;
  shopDomain: string | null;
  keptHandle: string;
  keptInstalledAt: string;
  laterHandle: string;
  laterInstalledAt: string;
}

export interface MergeResult {
  attributions: MergedAttribution[];
  /** Reinstalls whose click credited a *different* affiliate than the first install. */
  reinstalls: ReinstallConflict[];
  /** Shops seen installing more than once, whether or not the handle changed. */
  reinstalledShops: number;
}

/**
 * Merchant identity across both sides: one shop, on one app.
 *
 * Exported because the valuation below takes gross revenue pre-summed by the
 * caller, which means the caller has to build the same key from the same two
 * fields. Two copies of a key format is a silent-wrong-answer bug — an earlier
 * draft of this module separated the parts differently from the script that
 * fed it, and every lookup missed while every count stayed plausible. One
 * function, imported.
 */
export function shopKey(appId: string, shopId: string): string {
  return `${appId} ${shopId}`;
}

export function mergeAttributionChunks(chunks: Attribution[][]): MergeResult {
  const byShop = new Map<string, MergedAttribution>();
  const reinstalls: ReinstallConflict[] = [];
  let reinstalledShops = 0;

  for (const chunk of chunks) {
    for (const row of chunk) {
      const key = shopKey(row.appId, row.shopId);
      const current = byShop.get(key);
      if (!current) {
        byShop.set(key, { ...row, installCount: 1 });
        continue;
      }

      // The same install can legitimately arrive twice: chunks are cut on
      // install date, and the query pads its scan by a day at each end so a
      // GA4 table dated in the property's timezone is not missed. A repeat of
      // the same instant is that padding, not a reinstall.
      if (current.installedAt === row.installedAt) continue;

      reinstalledShops += 1;
      const [earlier, later] =
        current.installedAt <= row.installedAt ? [current, row] : [row, current];
      if (earlier.handle !== later.handle) {
        reinstalls.push({
          appId: row.appId,
          shopId: row.shopId,
          shopDomain: earlier.shopDomain ?? later.shopDomain,
          keptHandle: earlier.handle,
          keptInstalledAt: earlier.installedAt,
          laterHandle: later.handle,
          laterInstalledAt: later.installedAt,
        });
      }
      byShop.set(key, { ...earlier, installCount: current.installCount + 1 });
    }
  }

  const attributions = [...byShop.values()].sort(
    (a, b) => a.installedAt.localeCompare(b.installedAt) || a.shopId.localeCompare(b.shopId),
  );
  return { attributions, reinstalls, reinstalledShops };
}

/* -------------------------------------------------------- Mantle's rows */

export interface MantleReferral {
  attributionId: string;
  affiliateId: string;
  affiliateName: string | null;
  programId: string;
  /** Partner API app id, mapped from the program. Empty when the program is unknown. */
  appId: string;
  handle: string;
  /** Mantle's `platformId` — the Shopify shop id, which is PartnerDex's `shops.id`. */
  shopId: string | null;
  shopDomain: string | null;
  /** The referral's own date — when the merchant was said to have been referred. */
  referredAt: string;
  /** When the row was written. The gap between the two is the whole signal below. */
  createdAt: string;
  hasListingPageView: boolean;
  /** Set on the 35 referrals Mantle soft-deleted after a 30-day uninstall sweep. */
  deletedAt: string | null;
}

/**
 * Where a Mantle referral came from: its own pipeline, or an admin's hands.
 *
 * This matters because it decides what counts as a miss. A referral GA4 does
 * not reproduce is a defect in our pipeline only if Mantle's pipeline produced
 * it; if an admin typed it in, no automated pipeline should ever reproduce it
 * and counting it against ours measures nothing.
 *
 * There are **two independent signals**, and they are not the same signal:
 *
 *  - `appListingPageViewId`. This is a recorded artefact, not an inference: the
 *    row points at the GA4 listing page view its attribution was built from.
 *    most of the imported referrals carry one.
 *  - the lag between the referral's `date` and the record's `createdAt`. An
 *    automated attribution is written *as the referral happens*, because the
 *    referral happening is what writes it. A retroactive assignment is the
 *    opposite: an admin credits an affiliate for a merchant who installed weeks
 *    ago, and the row is stamped today while its date is backdated.
 *
 * Measured over every imported referral (this is EVIDENCE, recomputed on every run by
 * `originEvidence`, not copied from the plan):
 *
 * | lag | with a page view | without |
 * | --- | --- | --- |
 * | ≤ 3.2 days | 304 | 35 |
 * | > 7 days | **0** | 179 |
 * | max / median | 3.2d / 0.004d | 356d / 26d |
 *
 * So the signals agree overwhelmingly and disagree on exactly one population:
 * **35 rows with no page view but a lag too short to be retroactive.** The plan
 * describes the split as bimodal with an empty middle; over the full history it
 * is not — 15 rows sit between 3.2 and 7 days and 9 more between 7 and 10. A
 * single lag threshold would silently sort those into one bucket or the other
 * and report a clean number that is not clean.
 *
 * They are therefore given their own value, `uncertain`, rather than a coin
 * flip. Whether they are Mantle's pipeline writing a row whose page-view link
 * was lost, or an admin working fast, is not decidable from the export — but it
 * is decidable *empirically for our purposes*, and the comparison does decide
 * it: if GA4 independently reproduces one, the click existed and it behaved
 * like an automated attribution.
 *
 * The page view is preferred over the lag wherever they conflict, because one
 * is a stored fact and the other is a reading of timestamps.
 */
export const MANUAL_LAG_THRESHOLD_DAYS = 7;

/** The widest lag observed on any row that carries a page view. */
export const AUTOMATED_LAG_CEILING_DAYS = 3.2;

export type ReferralOrigin = 'automated' | 'manual' | 'uncertain';

export interface ClassifiedReferral extends MantleReferral {
  origin: ReferralOrigin;
  lagDays: number;
}

export function lagDays(referral: Pick<MantleReferral, 'referredAt' | 'createdAt'>): number {
  const referred = Date.parse(referral.referredAt);
  const created = Date.parse(referral.createdAt);
  if (Number.isNaN(referred) || Number.isNaN(created)) return 0;
  return (created - referred) / 86_400_000;
}

export function classifyOrigin(referral: MantleReferral): ClassifiedReferral {
  const lag = lagDays(referral);
  const origin: ReferralOrigin = referral.hasListingPageView
    ? 'automated'
    : lag > MANUAL_LAG_THRESHOLD_DAYS
      ? 'manual'
      : 'uncertain';
  return { ...referral, origin, lagDays: lag };
}

/**
 * The cross-tab that says whether the two signals still agree on this data.
 *
 * Printed on every run precisely so the classification above is never taken on
 * trust. If a future export produces a page-view row with a 40-day lag, the
 * premise has broken and the number to fix is here, not in the conclusion.
 */
export interface OriginEvidence {
  total: number;
  automated: number;
  manual: number;
  uncertain: number;
  medianLagAutomated: number;
  medianLagManual: number;
  medianLagUncertain: number;
  /** The widest lag on a page-view row. Above `AUTOMATED_LAG_CEILING_DAYS`, re-derive. */
  maxLagAutomated: number;
  /** The narrowest lag on a row called manual. */
  minLagManual: number;
  /** Rows in the band where the lag signal alone cannot decide: 3.2 to 7 days. */
  inTheGreyBand: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

export function originEvidence(rows: ClassifiedReferral[]): OriginEvidence {
  const automated = rows.filter((row) => row.origin === 'automated');
  const manual = rows.filter((row) => row.origin === 'manual');
  const uncertain = rows.filter((row) => row.origin === 'uncertain');
  return {
    total: rows.length,
    automated: automated.length,
    manual: manual.length,
    uncertain: uncertain.length,
    medianLagAutomated: median(automated.map((row) => row.lagDays)),
    medianLagManual: median(manual.map((row) => row.lagDays)),
    medianLagUncertain: median(uncertain.map((row) => row.lagDays)),
    maxLagAutomated: automated.reduce((max, row) => Math.max(max, row.lagDays), 0),
    minLagManual: manual.reduce((min, row) => Math.min(min, row.lagDays), Infinity),
    inTheGreyBand: rows.filter(
      (row) =>
        row.lagDays > AUTOMATED_LAG_CEILING_DAYS && row.lagDays <= MANUAL_LAG_THRESHOLD_DAYS,
    ).length,
  };
}

/* ------------------------------------------------------------ the diff */

export interface MatchedPair {
  ga4: MergedAttribution;
  mantle: ClassifiedReferral;
}

export interface Disagreement extends MatchedPair {
  ga4Handle: string;
  mantleHandle: string;
}

export interface ComparisonResult {
  /** Same merchant, same affiliate. The two witnesses agree. */
  matched: MatchedPair[];
  /** Same merchant, *different* affiliate. The finding that matters most. */
  disagreements: Disagreement[];
  /** GA4 found a referral Mantle never recorded. Nobody was credited or paid. */
  ga4Only: MergedAttribution[];
  /** Mantle recorded a referral GA4 does not reproduce, split by origin below. */
  mantleOnly: ClassifiedReferral[];
  /** Mantle rows whose merchant GA4 saw, but on a different app. Not a conflict. */
  crossApp: number;
}

/**
 * How a merchant on one side is recognised on the other.
 *
 * Two keys, tried in order, because each fails in a way the other survives:
 *
 *  - the **Shopify shop id**, which both sides carry (Mantle calls it
 *    `platformId`, GA4's install event calls it `shop_id`) and which is the
 *    platform's own primary key — immune to casing, to a domain rename, and to
 *    the trailing whitespace that shows up in exported strings.
 *  - the **myshopify domain**, kept as a fallback because GA4's install event
 *    occasionally carries `shop_url` and not a usable id.
 *
 * Matching on either alone was measured and reported by the caller; if the two
 * keys ever resolve *different* Mantle rows for one GA4 attribution, that is a
 * data problem worth knowing about, so the id is preferred and the domain only
 * consulted when the id finds nothing.
 */
function domainKey(appId: string, domain: string): string {
  return `${appId} ${domain.trim().toLowerCase()}`;
}

export function compareAttributions(
  ga4: MergedAttribution[],
  mantle: ClassifiedReferral[],
): ComparisonResult {
  const byShopId = new Map<string, ClassifiedReferral>();
  const byDomain = new Map<string, ClassifiedReferral>();
  const anyApp = new Set<string>();
  for (const row of mantle) {
    if (row.shopId) {
      byShopId.set(shopKey(row.appId, row.shopId), row);
      anyApp.add(row.shopId);
    }
    if (row.shopDomain) byDomain.set(domainKey(row.appId, row.shopDomain), row);
  }

  const matched: MatchedPair[] = [];
  const disagreements: Disagreement[] = [];
  const ga4Only: MergedAttribution[] = [];
  const consumed = new Set<string>();
  let crossApp = 0;

  for (const row of ga4) {
    const found =
      byShopId.get(shopKey(row.appId, row.shopId)) ??
      (row.shopDomain ? byDomain.get(domainKey(row.appId, row.shopDomain)) : undefined);

    if (!found) {
      // The merchant exists in Mantle's history but under the other app. Two
      // apps, two programs, two separate referrals — not a contradiction.
      if (anyApp.has(row.shopId)) crossApp += 1;
      ga4Only.push(row);
      continue;
    }

    consumed.add(found.attributionId);
    if (found.handle === row.handle) {
      matched.push({ ga4: row, mantle: found });
    } else {
      disagreements.push({
        ga4: row,
        mantle: found,
        ga4Handle: row.handle,
        mantleHandle: found.handle,
      });
    }
  }

  return {
    matched,
    disagreements,
    ga4Only,
    mantleOnly: mantle.filter((row) => !consumed.has(row.attributionId)),
    crossApp,
  };
}

/* -------------------------------------------------------------- valuing */

/**
 * What an unrecorded referral was worth, under the rule the ledger proves.
 *
 * Every `subscription_sale` row in the imported ledger sums to exactly 20.00% of
 * the gross it was earned on, median ratio exactly
 * 20.000%. So: twenty percent of gross, subscription sales only, and nothing
 * else — no usage charges, no one-time charges, no netting of Shopify's fee.
 *
 * Two limits belong to the number this produces, and both make it a **floor**:
 *
 *  1. It can only see transactions the local database has synced. That sync is
 *     a window, not the whole history, and the caller must state its bounds
 *     next to the total. A merchant referred in 2024 whose charges predate the
 *     window contributes $0 here and did not earn $0.
 *  2. It stops at the transactions themselves. Filemonk's 24-month cap and the
 *     30-day-after-uninstall rule can only reduce a total, never raise it, and
 *     neither is applied — so where they would bite, this over-states. On a
 *     sync window shorter than 24 months the cap cannot bind at all; the
 *     uninstall rule can, and in practice barely does, because uninstalling
 *     cancels the Shopify subscription and the charges stop by themselves.
 */
export const COMMISSION_RATE = 0.2;

export interface GrossByShop {
  /** Keyed `${appId} ${shopId}`, summed over subscription sales only. */
  get(key: string): number | undefined;
}

export interface ValuedAttribution {
  attribution: MergedAttribution;
  grossSubscription: number;
  commission: number;
}

export interface Valuation {
  rows: ValuedAttribution[];
  /** Attributions with at least one subscription charge inside the sync window. */
  earning: number;
  totalGross: number;
  totalCommission: number;
}

/**
 * Values a set of attributions against pre-summed subscription gross.
 *
 * The summing itself is SQL and lives in the script — it is a `WHERE` clause
 * over 1.7 million rows and has no business being reimplemented in JavaScript.
 * What lives here is the rule, so the rule can be tested.
 */
export function valueAttributions(
  attributions: MergedAttribution[],
  grossByShop: GrossByShop,
  rate: number = COMMISSION_RATE,
): Valuation {
  const rows = attributions.map((attribution) => {
    const grossSubscription = grossByShop.get(shopKey(attribution.appId, attribution.shopId)) ?? 0;
    // Rounded to cents at the row, not at the total. A commission is a payable
    // amount, and a few hundred rows of half-cent drift is a reconciliation people argue
    // about later.
    const commission = Math.round(grossSubscription * rate * 100) / 100;
    return { attribution, grossSubscription, commission };
  });

  return {
    rows: rows.sort((a, b) => b.commission - a.commission),
    earning: rows.filter((row) => row.commission > 0).length,
    totalGross: Math.round(rows.reduce((sum, row) => sum + row.grossSubscription, 0) * 100) / 100,
    totalCommission: Math.round(rows.reduce((sum, row) => sum + row.commission, 0) * 100) / 100,
  };
}

/* --------------------------------------------------- benchmark estimate */

/**
 * What the misses were *probably* worth, when the transactions cannot be read.
 *
 * This is necessary because of a hard boundary in the data. Nearly every
 * merchant Mantle missed does not appear in PartnerDex's `shops` table at all —
 * most installed in 2024, and the local sync currently holds transactions from
 * 2026-03-19 onward. `valueAttributions` therefore reports almost exactly zero,
 * and zero is not the answer; it is the absence of one.
 *
 * The substitute is Mantle's own ledger. For every referral Mantle *did*
 * attribute we know the lifetime commission it actually earned, so the mean and
 * median of that, within the same app and the same cohort year, is a defensible
 * price for a referral of the same vintage.
 *
 * **This is an estimate and must always be labelled as one.** Three reasons it
 * can be wrong, and the direction of each:
 *
 *  - The benchmark is built from merchants Mantle attributed. If the ones it
 *    missed were systematically worse — say the misses cluster on one affiliate
 *    running low-intent traffic — the estimate is high. That is checkable per
 *    affiliate and worth checking before anyone is paid.
 *  - Some cohorts are thin. A 2024 Filemonk benchmark drawn from 15 referrals
 *    carries all the variance you would expect from 15 of anything.
 *  - Mean and median disagree by a lot, because commission per referral is
 *    heavily skewed — a handful of merchants pay for years and most churn in
 *    weeks. Both are reported, as a range rather than a point.
 *
 * A range from a stated method beats a single number with no method, and both
 * beat the $0 that a bounded transaction table would otherwise imply.
 */
export interface CohortBenchmark {
  appId: string;
  period: string;
  /** How many attributed referrals the benchmark is drawn from. */
  referrals: number;
  meanCommission: number;
  medianCommission: number;
}

export function cohortBenchmarks(
  referrals: ClassifiedReferral[],
  earnedByAttribution: Map<string, number>,
): CohortBenchmark[] {
  const cohorts = new Map<string, { appId: string; period: string; earned: number[] }>();
  for (const referral of referrals) {
    const period = periodOf(referral.referredAt);
    const key = `${referral.appId} ${period}`;
    let cohort = cohorts.get(key);
    if (!cohort) {
      cohort = { appId: referral.appId, period, earned: [] };
      cohorts.set(key, cohort);
    }
    // A referral that earned nothing counts as a zero, not as missing data.
    // Dropping the zeroes would price every miss as if it were guaranteed to
    // convert, which is the single easiest way to over-state this number.
    cohort.earned.push(earnedByAttribution.get(referral.attributionId) ?? 0);
  }

  return [...cohorts.values()]
    .map((cohort) => ({
      appId: cohort.appId,
      period: cohort.period,
      referrals: cohort.earned.length,
      meanCommission:
        Math.round((cohort.earned.reduce((sum, value) => sum + value, 0) / cohort.earned.length) * 100) /
        100,
      medianCommission: Math.round(median(cohort.earned) * 100) / 100,
    }))
    .sort((a, b) => a.appId.localeCompare(b.appId) || a.period.localeCompare(b.period));
}

export interface BenchmarkEstimate {
  /** Median-based: what a typical referral of that vintage earned. */
  low: number;
  /** Mean-based: pulled up by the long-lived merchants in the same cohort. */
  high: number;
  /** Attributions with no cohort to price them against; excluded from both. */
  unpriced: number;
}

export function estimateByBenchmark(
  attributions: MergedAttribution[],
  benchmarks: CohortBenchmark[],
): BenchmarkEstimate {
  const byCohort = new Map(
    benchmarks.map((benchmark) => [`${benchmark.appId} ${benchmark.period}`, benchmark]),
  );
  let low = 0;
  let high = 0;
  let unpriced = 0;
  for (const attribution of attributions) {
    const benchmark = byCohort.get(`${attribution.appId} ${periodOf(attribution.installedAt)}`);
    if (!benchmark) {
      unpriced += 1;
      continue;
    }
    low += benchmark.medianCommission;
    high += benchmark.meanCommission;
  }
  return { low: Math.round(low * 100) / 100, high: Math.round(high * 100) / 100, unpriced };
}

/* ------------------------------------------------------------- periods */

/**
 * The same diff, cut by year — because the answer is not one number.
 *
 * The GA4 export starts 2024-04-21 and Mantle's first referral is dated
 * 2024-03-11, so the earliest weeks have *no click data at all* and a "miss"
 * there is a missing input, not a missing referral. Quality also degrades
 * backwards for a reason with no clean boundary: cookie lifetimes shortened,
 * consent banners spread, and a `user_pseudo_id` from 2024 is less likely to
 * still bridge a click to an install than one from 2026. Reporting a single
 * figure across all of it would let the weakest period set the tone for the
 * strongest, or the reverse.
 */
export interface PeriodBreakdown {
  period: string;
  matched: number;
  disagreements: number;
  ga4Only: number;
  mantleOnlyAutomated: number;
  mantleOnlyManual: number;
  mantleOnlyUncertain: number;
}

function periodOf(instant: string): string {
  return instant.slice(0, 4);
}

export function breakdownByPeriod(result: ComparisonResult): PeriodBreakdown[] {
  const periods = new Map<string, PeriodBreakdown>();
  const bucket = (key: string): PeriodBreakdown => {
    let entry = periods.get(key);
    if (!entry) {
      entry = {
        period: key,
        matched: 0,
        disagreements: 0,
        ga4Only: 0,
        mantleOnlyAutomated: 0,
        mantleOnlyManual: 0,
        mantleOnlyUncertain: 0,
      };
      periods.set(key, entry);
    }
    return entry;
  };

  // Each side is bucketed by its own clock: a GA4 attribution by the install it
  // observed, a Mantle row by the referral date it recorded. They agree to
  // within seconds on matched rows, and on unmatched ones there is no other
  // date to use.
  for (const pair of result.matched) bucket(periodOf(pair.ga4.installedAt)).matched += 1;
  for (const row of result.disagreements) bucket(periodOf(row.ga4.installedAt)).disagreements += 1;
  for (const row of result.ga4Only) bucket(periodOf(row.installedAt)).ga4Only += 1;
  for (const row of result.mantleOnly) {
    const entry = bucket(periodOf(row.referredAt));
    if (row.origin === 'manual') entry.mantleOnlyManual += 1;
    else if (row.origin === 'uncertain') entry.mantleOnlyUncertain += 1;
    else entry.mantleOnlyAutomated += 1;
  }

  return [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));
}

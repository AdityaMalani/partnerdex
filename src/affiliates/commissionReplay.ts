/**
 * Replaying Mantle's commission history through our own engine.
 *
 * This is the validation gate for workstream D: before any affiliate UI exists,
 * recompute every commission Mantle ever paid and diff it against the ledger.
 * Agreement is what earns the engine trust; disagreement is a finding, not a
 * rounding problem.
 *
 * Two independent passes, because they fail for different reasons and
 * conflating them would let one hide the other:
 *
 *   FORMULA pass  — feeds the engine the transactions embedded in Mantle's own
 *                   export. It tests the arithmetic and the rules against every
 *                   imported commission row with no join and no sync
 *                   dependency, so it is valid even when the local database is
 *                   empty or mid-sync.
 *
 *   PARTNER pass  — feeds the engine transactions from PartnerDex's `transactions`
 *                   table, joined to referrals through `myshopifyDomain`. This is
 *                   the real test, because it is the pipeline we will actually
 *                   run on: it can catch a charge Mantle recorded and we do not
 *                   see, and a charge we see and Mantle never paid on.
 *
 * The Partner pass is bounded by whatever the local sync has reached. It reports
 * that boundary rather than pretending to full coverage.
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  computeCommissions,
  type CommissionAttribution,
  type CommissionTransaction,
  type ProgramRules,
} from './commission.js';
import { diffAgainstLedger, type CommissionDiff, type LedgerCommission } from './commissionValidation.js';
import { PROGRAM_APP_IDS, defaultProgramRules } from './commissionRules.js';

export interface ReplaySources {
  /** Mantle's dashboard export: `exports/dashboard/commissions.json`. */
  commissionsPath: string;
  /** `exports/normalized/reconciliation.json`, for the referral → shop join. */
  reconciliationPath: string;
  /**
   * `exports/dashboard/attributions-recovered.json`.
   *
   * The handful of referrals Mantle soft-deleted. They are missing from
   * `reconciliation.json`, which only carries the live ones, yet they earned
   * commissions that are very much in the ledger. Without this file the Partner
   * pass reports those as unreproducible and blames the engine for a gap in its
   * own input.
   */
  recoveredAttributionsPath?: string;
  /** PartnerDex SQLite file. Opened read-only; the sync may hold it. */
  databasePath: string;
  rules?: Map<string, ProgramRules>;
}

export interface UninstallEvidence {
  /** Referrals whose merchant uninstalled at some point. */
  withUninstall: number;
  /** Of those, how many earned anything dated after the uninstall. */
  earnedAfterUninstall: number;
  /** How many earned anything more than the 30-day grace period after it. */
  earnedBeyondGrace: number;
  /** The longest gap, in days, between an uninstall and a later commission. */
  longestTailDays: number | null;
  /** Referrals Mantle soft-deleted, from the recovered-attributions export. */
  unassignedReferrals: number;
  /** Of those, how many belonged to a merchant who had uninstalled. */
  unassignedAfterUninstall: number;
  /**
   * Of those, how many were unassigned between 30 and 31.5 days after the
   * uninstall. This is the measurement that decides whether the 30-day rule was
   * ever enforced, and it is the reason the engine enforces it.
   */
  unassignedWithinGraceWindow: number;
  /** Distinct UTC times of day the deletions were stamped — a cron shows up here. */
  unassignClockTimes: string[];
}

export interface DurationEvidence {
  programId: string;
  referrals: number;
  /** Longest span from first to last commission, in months. */
  longestSpanMonths: number;
  /** Median lag from referral date to first commission, in days. */
  medianFirstCommissionLagDays: number;
  /** The longest such lag — how much a referral-anchored window would lose. */
  maxFirstCommissionLagDays: number;
}

export interface ReplayReport {
  formula: CommissionDiff;
  partner: CommissionDiff | null;
  partnerWindowStart: string | null;
  /** The export's last commission — past it there is nothing to compare against. */
  partnerWindowEnd: string | null;
  partnerUnavailableReason: string | null;
  /** Referrals we could not join to a shop, so the Partner pass cannot see them. */
  unjoinedReferrals: number;
  joinedReferrals: number;
  /** Ledger rows inside the window, joinable or not. The denominator of coverage. */
  partnerLedgerRowsInWindow: number;
  /** Of those, the ones excluded because their referral has no shop yet. */
  partnerLedgerRowsOutOfCoverage: number;
  uninstall: UninstallEvidence;
  duration: DurationEvidence[];
  /** More than one entry means totals are summing unlike currencies. */
  currencies: string[];
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.436_875;
const UNINSTALL_GRACE_DAYS = 30;

/**
 * Mantle's export is one envelope with an `items` array; only a handful of
 * fields per row matter here. Typed loosely on purpose — the file carries the
 * whole nested object graph including branding HTML, and narrowing it to what
 * we read keeps a change in their unrelated fields from breaking this.
 */
interface MantleCommissionRow {
  id: string;
  affiliateId: string;
  affiliateProgramId: string;
  affiliateAttributionId: string;
  amount: number;
  date: string;
  cancelled?: boolean;
  deletedAt?: string | null;
  transaction?: {
    id: string;
    type: string;
    date: string;
    grossAmount: number;
    grossAmountCurrencyCode: string;
  } | null;
  affiliateAttribution?: MantleAttribution | null;
}

interface MantleAttribution {
  id: string;
  affiliateId?: string;
  affiliateProgramId?: string;
  date: string;
  deletedAt?: string | null;
  appInstallation?: {
    myshopifyDomain?: string | null;
    /** Mantle's name for the Shopify shop id, which is PartnerDex's `shops.id`. */
    platformId?: string | number | null;
    uninstalledAt?: string | null;
  } | null;
}

interface AttributionMapRow {
  attributionId: string;
  affiliateId: string;
  affiliateProgramId: string;
  shopifyShopId: string | number | null;
  myshopifyDomain: string | null;
  referredAt: string;
  uninstalledAt: string | null;
}

/**
 * Mantle spells the revenue component `subscription_sale`; the Partner API says
 * `AppSubscriptionSale` for the same event. Both map to `subscription` before
 * the engine sees them — everything else maps to a component our programs do
 * not pay on, which is the safe direction to be wrong in.
 */
function componentOf(type: string): CommissionTransaction['component'] {
  if (type === 'subscription_sale' || type === 'AppSubscriptionSale') return 'subscription';
  if (type === 'usage_sale' || type === 'AppUsageSale') return 'usage';
  return 'one_time';
}

function loadLedger(commissionsPath: string): MantleCommissionRow[] {
  const parsed = JSON.parse(fs.readFileSync(commissionsPath, 'utf8')) as {
    items?: MantleCommissionRow[];
  };
  const items = parsed.items ?? [];
  // Cancelled and soft-deleted rows were never money owed. Both are empty in
  // the current export, but a filter that only holds by luck is not a filter.
  return items.filter((row) => row.cancelled !== true && !row.deletedAt);
}

function toLedgerCommission(row: MantleCommissionRow): LedgerCommission {
  return {
    id: row.id,
    attributionId: row.affiliateAttributionId,
    affiliateId: row.affiliateId,
    programId: row.affiliateProgramId,
    occurredAt: row.date,
    amount: row.amount,
    grossAmount: row.transaction?.grossAmount ?? 0,
    currency: row.transaction?.grossAmountCurrencyCode ?? 'USD',
  };
}

/**
 * Referrals reconstructed from the ledger itself.
 *
 * Only referrals that earned something appear here, which is exactly right for
 * the formula pass: a referral with no commissions contributes no rows to
 * either side of the diff, and inventing shop ids for them would only add join
 * risk to a pass whose entire value is having no join.
 */
function attributionsFromLedger(rows: MantleCommissionRow[]): CommissionAttribution[] {
  const seen = new Map<string, CommissionAttribution>();
  for (const row of rows) {
    const attribution = row.affiliateAttribution;
    if (!attribution || seen.has(attribution.id)) continue;
    seen.set(attribution.id, {
      id: attribution.id,
      affiliateId: row.affiliateId,
      programId: row.affiliateProgramId,
      // The formula pass never touches the database, so app and shop are only
      // grouping keys. Keying the shop by attribution keeps two referrals of
      // the same merchant on different programs from cross-contaminating.
      appId: PROGRAM_APP_IDS[row.affiliateProgramId] ?? row.affiliateProgramId,
      shopId: attribution.id,
      referredAt: attribution.date,
      uninstalledAt: attribution.appInstallation?.uninstalledAt ?? null,
      unassignedAt: attribution.deletedAt ?? null,
    });
  }
  return [...seen.values()];
}

function transactionsFromLedger(rows: MantleCommissionRow[]): CommissionTransaction[] {
  const seen = new Set<string>();
  const transactions: CommissionTransaction[] = [];
  for (const row of rows) {
    const transaction = row.transaction;
    const attribution = row.affiliateAttribution;
    if (!transaction || !attribution) continue;
    // One transaction can in principle earn for two referrals; the engine keys
    // on (app, shop) so the same transaction id must not be emitted twice for
    // the same synthetic shop.
    const dedupe = `${attribution.id} ${transaction.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    transactions.push({
      id: transaction.id,
      appId: PROGRAM_APP_IDS[row.affiliateProgramId] ?? row.affiliateProgramId,
      shopId: attribution.id,
      component: componentOf(transaction.type),
      occurredAt: transaction.date,
      grossAmount: transaction.grossAmount,
      currency: transaction.grossAmountCurrencyCode,
    });
  }
  return transactions;
}

/**
 * Soft-deleted referrals, which is where the uninstall rule left its footprint.
 * Returns an empty list when the file is absent so the harness still runs on a
 * partial export rather than failing on an optional input.
 */
function loadRecovered(path: string | undefined): MantleAttribution[] {
  if (!path || !fs.existsSync(path)) return [];
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as { items?: MantleAttribution[] };
  return parsed.items ?? [];
}

/** Evidence for whether `removeOnUninstallDays` was ever actually enforced. */
function uninstallEvidence(
  rows: MantleCommissionRow[],
  recovered: MantleAttribution[],
): UninstallEvidence {
  const uninstalledAt = new Map<string, string>();
  const byAttribution = new Map<string, string[]>();
  for (const row of rows) {
    const attribution = row.affiliateAttribution;
    if (!attribution) continue;
    const stamp = attribution.appInstallation?.uninstalledAt;
    if (stamp) uninstalledAt.set(attribution.id, stamp);
    const dates = byAttribution.get(attribution.id);
    if (dates) dates.push(row.date);
    else byAttribution.set(attribution.id, [row.date]);
  }

  let earnedAfterUninstall = 0;
  let earnedBeyondGrace = 0;
  let longestTailDays: number | null = null;
  for (const [attributionId, stamp] of uninstalledAt) {
    const removed = new Date(stamp).getTime();
    const tails = (byAttribution.get(attributionId) ?? [])
      .map((date) => (new Date(date).getTime() - removed) / MS_PER_DAY)
      .filter((days) => days > 0);
    if (tails.length === 0) continue;
    earnedAfterUninstall += 1;
    const longest = Math.max(...tails);
    if (longest > UNINSTALL_GRACE_DAYS) earnedBeyondGrace += 1;
    if (longestTailDays === null || longest > longestTailDays) longestTailDays = longest;
  }

  // The sweep's signature: a gap just over the threshold, never under it,
  // stamped at the same time of day. The upper bound is deliberately loose —
  // a daily job can only act on the next run after the threshold passes, so
  // anything up to a day late is still the job firing on schedule.
  const swept = recovered.filter((row) => row.deletedAt && row.appInstallation?.uninstalledAt);
  const gaps = swept.map(
    (row) =>
      (new Date(row.deletedAt as string).getTime() -
        new Date(row.appInstallation?.uninstalledAt as string).getTime()) /
      MS_PER_DAY,
  );

  return {
    withUninstall: uninstalledAt.size,
    earnedAfterUninstall,
    earnedBeyondGrace,
    longestTailDays: longestTailDays === null ? null : Math.round(longestTailDays * 10) / 10,
    unassignedReferrals: recovered.length,
    unassignedAfterUninstall: swept.length,
    unassignedWithinGraceWindow: gaps.filter(
      (days) => days >= UNINSTALL_GRACE_DAYS && days <= UNINSTALL_GRACE_DAYS + 1.5,
    ).length,
    unassignClockTimes: [
      ...new Set(
        swept.map((row) => (row.deletedAt as string).slice(11, 16)),
      ),
    ].sort(),
  };
}

/** How close any referral ever came to the 24-month cap, and by which clock. */
function durationEvidence(rows: MantleCommissionRow[]): DurationEvidence[] {
  const byProgram = new Map<string, Map<string, { dates: string[]; referredAt: string }>>();
  for (const row of rows) {
    const attribution = row.affiliateAttribution;
    if (!attribution) continue;
    let programMap = byProgram.get(row.affiliateProgramId);
    if (!programMap) {
      programMap = new Map();
      byProgram.set(row.affiliateProgramId, programMap);
    }
    const entry = programMap.get(attribution.id);
    if (entry) entry.dates.push(row.date);
    else programMap.set(attribution.id, { dates: [row.date], referredAt: attribution.date });
  }

  const evidence: DurationEvidence[] = [];
  for (const [programId, programMap] of byProgram) {
    let longestSpanMonths = 0;
    const lags: number[] = [];
    for (const entry of programMap.values()) {
      const sorted = [...entry.dates].sort();
      const first = new Date(sorted[0] as string).getTime();
      const last = new Date(sorted[sorted.length - 1] as string).getTime();
      longestSpanMonths = Math.max(longestSpanMonths, (last - first) / MS_PER_DAY / DAYS_PER_MONTH);
      lags.push((first - new Date(entry.referredAt).getTime()) / MS_PER_DAY);
    }
    lags.sort((a, b) => a - b);
    evidence.push({
      programId,
      referrals: programMap.size,
      longestSpanMonths: Math.round(longestSpanMonths * 10) / 10,
      medianFirstCommissionLagDays: Math.round((lags[Math.floor(lags.length / 2)] ?? 0) * 10) / 10,
      maxFirstCommissionLagDays: Math.round((lags[lags.length - 1] ?? 0) * 10) / 10,
    });
  }
  return evidence.sort((a, b) => b.referrals - a.referrals);
}

interface PartnerPass {
  diff: CommissionDiff;
  windowStart: string;
  windowEnd: string;
  joined: number;
  unjoined: number;
  ledgerRowsInWindow: number;
  ledgerRowsOutOfCoverage: number;
}

/**
 * Recompute from PartnerDex's own transactions.
 *
 * Opened read-only: the historical sync may be running against this file and
 * this is a read model, so there is no circumstance in which validating should
 * be able to write. The comparison is restricted to the window the local sync
 * has actually reached — outside it we would report every Mantle commission as
 * "missing from ours" and call an incomplete download a defect.
 */
function partnerPass(
  sources: ReplaySources,
  ledger: MantleCommissionRow[],
  recovered: MantleAttribution[],
  rules: Map<string, ProgramRules>,
): PartnerPass | { unavailable: string } {
  let db: Database.Database;
  try {
    db = new Database(sources.databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return { unavailable: `database unreadable: ${(error as Error).message}` };
  }

  try {
    const earliest = db
      .prepare("SELECT MIN(created_at) AS at FROM transactions WHERE type = 'AppSubscriptionSale'")
      .get() as { at: string | null };
    if (!earliest?.at) return { unavailable: 'no subscription transactions synced yet' };

    // A day of slack past the first synced row. The sync writes in id order, so
    // the very first minutes of the earliest day can be partial; treating the
    // boundary as exact would manufacture false "missing" rows there.
    const windowStart = new Date(new Date(earliest.at).getTime() + MS_PER_DAY).toISOString();

    // And the export's own last commission closes the window. Mantle stopped
    // recording when the export was taken; charges after that instant are real
    // and ours, but there is nothing on the other side of the diff to compare
    // them to, so counting them as disagreement measures the clock, not us.
    const windowEnd = ledger.reduce(
      (latest, row) => (row.date > latest ? row.date : latest),
      '0000',
    );

    /**
     * Two ways into the same shop.
     *
     * Mantle's `shopifyShopId` (spelled `platformId` on an installation) is
     * PartnerDex's `shops.id` exactly — checked across every referral that
     * carries both, with zero mismatches — so the id is tried first: it is the
     * platform's own key and cannot be broken by casing or a domain rename.
     * The domain is kept as a fallback because it is the only handle the export
     * guarantees, and today the two are interchangeable: both resolve the same
     * live referrals, neither resolves one the other misses.
     */
    const shopIds = new Set<string>();
    const shopByDomain = new Map<string, string>();
    for (const shop of db
      .prepare('SELECT id, myshopify_domain FROM shops')
      .all() as Array<{ id: string; myshopify_domain: string | null }>) {
      shopIds.add(shop.id);
      if (shop.myshopify_domain) shopByDomain.set(shop.myshopify_domain.toLowerCase(), shop.id);
    }
    const resolveShop = (
      shopifyShopId: string | number | null | undefined,
      domain: string | null | undefined,
    ): string | undefined => {
      if (shopifyShopId != null && shopIds.has(String(shopifyShopId))) return String(shopifyShopId);
      return domain ? shopByDomain.get(domain.toLowerCase()) : undefined;
    };

    const map = JSON.parse(fs.readFileSync(sources.reconciliationPath, 'utf8')) as {
      attributionMap?: AttributionMapRow[];
    };
    const referrals: AttributionMapRow[] = [...(map.attributionMap ?? [])];
    // The soft-deleted ones, flattened into the same shape. Their unassignment
    // date rides along on a parallel map rather than in `AttributionMapRow`,
    // which is the reconciliation file's shape and does not have the field.
    const unassignedAt = new Map<string, string>();
    for (const row of recovered) {
      if (!row.affiliateId || !row.affiliateProgramId) continue;
      if (row.deletedAt) unassignedAt.set(row.id, row.deletedAt);
      referrals.push({
        attributionId: row.id,
        affiliateId: row.affiliateId,
        affiliateProgramId: row.affiliateProgramId,
        shopifyShopId: row.appInstallation?.platformId ?? null,
        myshopifyDomain: row.appInstallation?.myshopifyDomain ?? null,
        referredAt: row.date,
        uninstalledAt: row.appInstallation?.uninstalledAt ?? null,
      });
    }

    const attributions: CommissionAttribution[] = [];
    const joinedIds = new Set<string>();
    let unjoined = 0;
    for (const referral of referrals) {
      const appId = PROGRAM_APP_IDS[referral.affiliateProgramId];
      const shopId = resolveShop(referral.shopifyShopId, referral.myshopifyDomain);
      if (!appId || !shopId) {
        unjoined += 1;
        continue;
      }
      joinedIds.add(referral.attributionId);
      attributions.push({
        id: referral.attributionId,
        affiliateId: referral.affiliateId,
        programId: referral.affiliateProgramId,
        appId,
        shopId,
        referredAt: referral.referredAt,
        uninstalledAt: referral.uninstalledAt,
        unassignedAt: unassignedAt.get(referral.attributionId) ?? null,
      });
    }

    // Only the referred shops' charges are pulled. The alternative — every
    // transaction in the window — is millions of rows to answer a question
    // about a few hundred shops, and the engine would discard all but these
    // anyway.
    const query = db.prepare(
      `SELECT id, app_id, shop_id, type, created_at, gross_amount, currency
         FROM transactions
        WHERE app_id = ? AND shop_id = ? AND type = 'AppSubscriptionSale' AND created_at >= ?`,
    );
    const transactions: CommissionTransaction[] = [];
    const seen = new Set<string>();
    for (const attribution of attributions) {
      const rows = query.all(attribution.appId, attribution.shopId, windowStart) as Array<{
        id: string;
        app_id: string;
        shop_id: string;
        type: string;
        created_at: string;
        gross_amount: number;
        currency: string;
      }>;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        if (new Date(row.created_at).toISOString() > windowEnd) continue;
        seen.add(row.id);
        transactions.push({
          id: row.id,
          appId: row.app_id,
          shopId: row.shop_id,
          component: componentOf(row.type),
          occurredAt: new Date(row.created_at).toISOString(),
          grossAmount: row.gross_amount,
          currency: row.currency,
        });
      }
    }

    const run = computeCommissions(transactions, attributions, rules);

    /*
     * The ledger side is narrowed to referrals that actually resolved to a
     * shop, and the ones dropped are counted rather than absorbed.
     *
     * This is the difference between a validation result and a misleading one.
     * The local database is mid-backfill — its `shops` table currently starts
     * around 2026-04-26 — so a referral we cannot resolve has no transactions
     * for the engine to see and every one of its commissions would land in the
     * diff as "missing from ours". That measures how far the sync has got, not
     * whether the rule is right, and averaging the two into one percentage
     * would hide a real disagreement behind an incomplete download.
     */
    const inWindow = ledger.filter((row) => new Date(row.date).toISOString() >= windowStart);
    const comparable = inWindow.filter((row) => joinedIds.has(row.affiliateAttributionId));

    return {
      diff: diffAgainstLedger(run.commissions, comparable.map(toLedgerCommission)),
      windowStart,
      windowEnd,
      joined: attributions.length,
      unjoined,
      ledgerRowsInWindow: inWindow.length,
      ledgerRowsOutOfCoverage: inWindow.length - comparable.length,
    };
  } finally {
    db.close();
  }
}

export function replayCommissions(sources: ReplaySources): ReplayReport {
  const rules = sources.rules ?? defaultProgramRules();
  const ledger = loadLedger(sources.commissionsPath);
  const recovered = loadRecovered(sources.recoveredAttributionsPath);

  const formulaRun = computeCommissions(
    transactionsFromLedger(ledger),
    attributionsFromLedger(ledger),
    rules,
  );
  const formula = diffAgainstLedger(formulaRun.commissions, ledger.map(toLedgerCommission));

  const partner = partnerPass(sources, ledger, recovered, rules);
  const partnerFailed = 'unavailable' in partner;

  return {
    formula,
    partner: partnerFailed ? null : partner.diff,
    partnerWindowStart: partnerFailed ? null : partner.windowStart,
    partnerWindowEnd: partnerFailed ? null : partner.windowEnd,
    partnerUnavailableReason: partnerFailed ? partner.unavailable : null,
    joinedReferrals: partnerFailed ? 0 : partner.joined,
    unjoinedReferrals: partnerFailed ? 0 : partner.unjoined,
    partnerLedgerRowsInWindow: partnerFailed ? 0 : partner.ledgerRowsInWindow,
    partnerLedgerRowsOutOfCoverage: partnerFailed ? 0 : partner.ledgerRowsOutOfCoverage,
    uninstall: uninstallEvidence(ledger, recovered),
    duration: durationEvidence(ledger),
    currencies: [
      ...new Set([...formula.currencies, ...(partnerFailed ? [] : partner.diff.currencies)]),
    ].sort(),
  };
}

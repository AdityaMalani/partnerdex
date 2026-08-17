/**
 * The commission engine.
 *
 * This module is deliberately pure and schema-free: it takes transactions,
 * attributions and program rules as plain values and returns computed
 * commissions. Nothing here reads the database, and nothing here knows the
 * affiliate tables exist. That matters because commission amounts are a
 * *derivation* — they must be recomputable at any time, from scratch, against
 * two years of Mantle history as easily as against next month's charges. A
 * function that reaches for a connection cannot be replayed like that.
 *
 * The rules were not taken from Mantle's settings screen, which was misleading.
 * They were re-derived from every real commission row and its source
 * transactions:
 *
 *     commission = 20% of GROSS, on subscription sales only
 *
 * Every one of those rows is `subscription_sale`, none are usage or one-time, and every
 * single row sits within half a cent of 20% of gross. See
 * `commissionValidation.ts` for the harness that keeps proving that.
 */

/** Which revenue streams a program pays on. Mantle called these components. */
export type RevenueComponent = 'subscription' | 'usage' | 'one_time';

/**
 * The engine's own transaction shape.
 *
 * `type` is the *normalized* component rather than a platform string, because
 * the two sources we reconcile spell the same event differently — the Partner
 * API says `AppSubscriptionSale`, Mantle's ledger says `subscription_sale`.
 * Normalizing at the edge keeps the one rule that matters ("subscription only")
 * from turning into a list of vendor spellings inside the calculation.
 */
export interface CommissionTransaction {
  id: string;
  appId: string;
  shopId: string;
  component: RevenueComponent;
  /** ISO-8601 instant the charge was recorded. */
  occurredAt: string;
  /** Gross, before the platform's cut. Commission is on gross, never net. */
  grossAmount: number;
  currency: string;
}

/**
 * A referral: one affiliate owns one shop's revenue on one app, from a date.
 *
 * Deliberately not the storage row. The engine needs six fields; the durable
 * attribution record has more, and coupling to it would make the engine
 * un-replayable against Mantle's export, which is the only dataset large enough
 * to prove the engine correct.
 */
export interface CommissionAttribution {
  id: string;
  affiliateId: string;
  programId: string;
  appId: string;
  shopId: string;
  /** ISO-8601. Nothing before this instant earns. */
  referredAt: string;
  /** ISO-8601, or null while the merchant still has the app. */
  uninstalledAt?: string | null;
  /**
   * ISO-8601 instant the referral stopped belonging to this affiliate, if it
   * ever did. Mantle expressed this as a soft delete on the attribution row.
   *
   * It is a separate field from `uninstalledAt` because it has two causes: the
   * automatic 30-day sweep after an uninstall, and an admin (or a cross-program
   * reassignment) removing the referral outright. Some unassigned referrals in
   * the export had no uninstall at all, so deriving this from the uninstall
   * alone would keep paying them forever.
   */
  unassignedAt?: string | null;
}

export interface ProgramRules {
  id: string;
  /** 20 means 20%. Percent, not fraction — it is what the Mantle export stores. */
  percentCommission: number;
  revenueComponents: RevenueComponent[];
  /**
   * How long a referral keeps earning, in months. `null` is lifetime.
   *
   * UNVERIFIED AGAINST OUR OWN DATA: the window starts at the date of the FIRST
   * COMMISSION, not the referral date. That is stated as a MUST twice in the
   * previous platform's own specification, and it is implemented here on that
   * authority alone.
   * Our own ledger cannot confirm or refute it: no referral has yet run long
   * enough to reach the 24-month cap. The distinction is not academic — the
   * lag from referral to first commission is routinely weeks and can exceed a
   * year, so starting the clock at the referral instead would silently shorten
   * every window by that lag.
   */
  durationMonths: number | null;
  /**
   * Mantle's `removeOnUninstallDays`, 30 for both our programs.
   *
   * This was expected to be decorative — a schema field with no documented job
   * behind it — and the commission ledger alone cannot tell you either way,
   * since no commission in the whole ledger is dated more than a couple of
   * weeks after its merchant uninstalled. That is not evidence of a rule;
   * uninstalling cancels the Shopify subscription, so the charges stop on their
   * own long before a 30-day grace period could ever bind.
   *
   * The job is real, and the proof is in the *deleted* attributions rather than
   * the commissions. Of the soft-deleted referrals in the export, most belong to
   * a merchant who uninstalled, and almost all of those were deleted just past
   * the 30-day mark — every one of them stamped at the same time of day, which
   * is a daily cron sweeping anything past the threshold. The remainder were
   * deleted long before their merchant uninstalled, so they are manual
   * removals.
   *
   * Enforcement is therefore on by default. Note what the job actually did: it
   * unassigned the referral, it did not cancel commissions already earned.
   */
  unassignAfterUninstallDays: number | null;
  /** Switch for the rule above. Defaults to off when omitted; see the note. */
  enforceUnassignAfterUninstall?: boolean;
}

export interface ComputedCommission {
  attributionId: string;
  affiliateId: string;
  programId: string;
  transactionId: string;
  appId: string;
  shopId: string;
  /** Rounded to cents. Mantle stored raw floats; see `roundToCents`. */
  amount: number;
  /** Carried through so a diff can report what a commission was earned on. */
  grossAmount: number;
  currency: string;
  occurredAt: string;
}

/**
 * Why a transaction earned nothing. Kept as data rather than dropped silently,
 * because "we paid less than Mantle did" is only answerable if the engine can
 * say which gate closed.
 */
export type SkipReason =
  | 'unattributed'
  | 'component_excluded'
  | 'non_positive_gross'
  | 'before_referral'
  | 'after_duration_window'
  | 'after_uninstall_grace'
  | 'after_unassignment';

export interface SkippedTransaction {
  transactionId: string;
  attributionId: string | null;
  reason: SkipReason;
  occurredAt: string;
  grossAmount: number;
}

export interface CommissionRun {
  commissions: ComputedCommission[];
  skipped: SkippedTransaction[];
  /**
   * Every currency seen on an earning transaction. There is no FX conversion
   * anywhere in this system, so more than one entry here means the totals
   * downstream are adding unlike units and must not be trusted.
   */
  currencies: string[];
}

const MS_PER_DAY = 86_400_000;

/**
 * Money is decided in cents and only then expressed as a float.
 *
 * Mantle's export carries values like `251.8000000000001`, which is what
 * happens when a rate is applied in binary floating point and stored raw. We
 * are not going to reproduce that noise, and we are not going to let it count
 * as disagreement either — the validation harness compares with a cent
 * tolerance for exactly this reason.
 */
export function roundToCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Calendar month arithmetic, clamped at the end of the month.
 *
 * 24 months from 29 February must land on 28 February, not spill into March. A
 * naive day count would drift a duration cap by up to two days a year, which on
 * a 24-month window is the difference between paying a final charge and not.
 */
export function addMonths(iso: string, months: number): string {
  const start = new Date(iso);
  const day = start.getUTCDate();
  const shifted = new Date(start.getTime());
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDayOfTarget));
  return shifted.toISOString();
}

/**
 * The commission on a single transaction, once it is known to be eligible.
 * Separated out so the rate can be unit-tested without staging a whole referral.
 */
export function commissionAmount(grossAmount: number, percentCommission: number): number {
  return roundToCents((grossAmount * percentCommission) / 100);
}

function attributionKey(appId: string, shopId: string): string {
  return `${appId} ${shopId}`;
}

/**
 * Compute every commission the given transactions earn.
 *
 * Transactions are grouped by (app, shop) and walked in date order per
 * referral, because two of the rules are path-dependent: the duration window is
 * anchored to the first commission, so it cannot be evaluated until the earlier
 * transactions have been decided. Sorting once here rather than requiring
 * sorted input keeps callers from having to know that.
 *
 * A shop referred on two programs for the same app is not resolved here — that
 * is a de-duplication policy question about which attribution record is live,
 * and it belongs upstream where the records are written. This function trusts
 * the attributions it is handed and will happily pay both.
 */
export function computeCommissions(
  transactions: CommissionTransaction[],
  attributions: CommissionAttribution[],
  rulesByProgram: Map<string, ProgramRules>,
): CommissionRun {
  const byShop = new Map<string, CommissionAttribution[]>();
  for (const attribution of attributions) {
    const key = attributionKey(attribution.appId, attribution.shopId);
    const list = byShop.get(key);
    if (list) list.push(attribution);
    else byShop.set(key, [attribution]);
  }

  const commissions: ComputedCommission[] = [];
  const skipped: SkippedTransaction[] = [];
  const currencies = new Set<string>();

  /** First earning instant per attribution — the duration clock's zero point. */
  const windowStart = new Map<string, string>();

  const ordered = [...transactions].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  for (const transaction of ordered) {
    const candidates = byShop.get(attributionKey(transaction.appId, transaction.shopId)) ?? [];
    if (candidates.length === 0) {
      skipped.push({
        transactionId: transaction.id,
        attributionId: null,
        reason: 'unattributed',
        occurredAt: transaction.occurredAt,
        grossAmount: transaction.grossAmount,
      });
      continue;
    }

    for (const attribution of candidates) {
      const rules = rulesByProgram.get(attribution.programId);
      if (!rules) continue;

      const skip = (reason: SkipReason): void => {
        skipped.push({
          transactionId: transaction.id,
          attributionId: attribution.id,
          reason,
          occurredAt: transaction.occurredAt,
          grossAmount: transaction.grossAmount,
        });
      };

      if (!rules.revenueComponents.includes(transaction.component)) {
        skip('component_excluded');
        continue;
      }

      // Credits and downgrade adjustments arrive as subscription sales with a
      // negative gross. Mantle never wrote a negative commission — the smallest
      // across the whole ledger is $0.38 — so a clawback would be a change in policy, not
      // a fix. We follow the ledger and let them pass without earning.
      if (transaction.grossAmount <= 0) {
        skip('non_positive_gross');
        continue;
      }

      if (transaction.occurredAt < attribution.referredAt) {
        skip('before_referral');
        continue;
      }

      // An explicit unassignment is a fact and outranks any derived rule: the
      // referral stopped being this affiliate's on that date, whatever the
      // reason. Checked before the grace period so a manual removal still bites
      // when the 30-day sweep would never have fired.
      if (attribution.unassignedAt && transaction.occurredAt > attribution.unassignedAt) {
        skip('after_unassignment');
        continue;
      }

      if (
        rules.enforceUnassignAfterUninstall === true &&
        rules.unassignAfterUninstallDays !== null &&
        attribution.uninstalledAt
      ) {
        const cutoff = new Date(
          new Date(attribution.uninstalledAt).getTime() +
            rules.unassignAfterUninstallDays * MS_PER_DAY,
        ).toISOString();
        if (transaction.occurredAt > cutoff) {
          skip('after_uninstall_grace');
          continue;
        }
      }

      // Lifetime programs skip the window entirely; for capped ones the clock
      // starts at the first commission, which is why this is the last gate —
      // a transaction that fails any earlier check must not start the clock.
      if (rules.durationMonths !== null) {
        const anchor = windowStart.get(attribution.id);
        if (anchor !== undefined) {
          const expiry = addMonths(anchor, rules.durationMonths);
          if (transaction.occurredAt > expiry) {
            skip('after_duration_window');
            continue;
          }
        }
      }
      if (!windowStart.has(attribution.id)) {
        windowStart.set(attribution.id, transaction.occurredAt);
      }

      currencies.add(transaction.currency);
      commissions.push({
        attributionId: attribution.id,
        affiliateId: attribution.affiliateId,
        programId: attribution.programId,
        transactionId: transaction.id,
        appId: transaction.appId,
        shopId: transaction.shopId,
        amount: commissionAmount(transaction.grossAmount, rules.percentCommission),
        grossAmount: transaction.grossAmount,
        currency: transaction.currency,
        occurredAt: transaction.occurredAt,
      });
    }
  }

  return { commissions, skipped, currencies: [...currencies].sort() };
}

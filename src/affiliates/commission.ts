/**
 * The commission engine.
 *
 * This module is deliberately pure and schema-free: it takes transactions,
 * attributions and program rules as plain values and returns computed
 * commissions. Nothing here reads the database, and nothing here knows the
 * affiliate tables exist. That matters because commission amounts are a
 * *derivation* — they must be recomputable at any time, from scratch, against
 * years of a previous platform's history as easily as against next month's
 * charges. A function that reaches for a connection cannot be replayed like
 * that.
 *
 * Every rule here is a value on `ProgramRules`, which is a row in
 * `affiliate_program_terms` — one row per *version* of a programme's terms,
 * with `affiliate_programs` holding the programme's identity and a copy of its
 * current version. There are no rates, no component lists and no windows
 * compiled into this file, and there is nowhere in the system a program's terms
 * can be set except those tables.
 *
 * The rules that apply to a charge are the rules in force **when that charge
 * occurred** — see `rulesAt`. That is the difference between an operator
 * changing a rate and an operator restating two years of payments. An operator moving an existing programme onto
 * this code can therefore answer "would this have paid the same people the same
 * money" *before* the first recompute writes anything — see
 * `commissionValidation.ts`, which is the harness for exactly that question.
 */

/**
 * Which revenue streams a program pays on — the whole vocabulary, in one place.
 *
 * This list is the contract. `affiliate_programs.revenue_components` is a JSON
 * array of these strings and nothing else: a write that names anything outside
 * this list is rejected where it is written, and a stored value outside it is
 * reported rather than obeyed. That is deliberate and it is a money decision.
 * An unrecognised component cannot match a transaction, so a program carrying
 * one silently earns nothing on that stream — the worst kind of defect, because
 * the settings screen shows the operator exactly what they typed and the ledger
 * shows zero with no explanation joining the two.
 *
 * Adding a stream means adding it here *and* teaching the ingest to normalise
 * some platform string onto it. A component nothing normalises to is a label,
 * not a rule.
 */
export const REVENUE_COMPONENTS = ['subscription', 'usage', 'one_time'] as const;

/** Which revenue streams a program pays on. */
export type RevenueComponent = (typeof REVENUE_COMPONENTS)[number];

export function isRevenueComponent(value: unknown): value is RevenueComponent {
  return typeof value === 'string' && (REVENUE_COMPONENTS as readonly string[]).includes(value);
}

/**
 * The engine's own transaction shape.
 *
 * `component` is the *normalized* revenue stream rather than a platform string,
 * because two sources spell the same event differently — the Partner API says
 * `AppSubscriptionSale`, an affiliate platform's own ledger might say
 * `subscription_sale`. Normalizing at the edge keeps a program's rule from
 * turning into a list of vendor spellings inside the calculation. See
 * `REVENUE_COMPONENTS` above and the type map in `commissionRun.ts`.
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
 * un-replayable against a previous platform's export — which is the only kind
 * of dataset large enough to prove the engine correct before it is trusted.
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
   * ever did. Stored as a soft delete on the attribution row.
   *
   * It is a separate field from `uninstalledAt` because it has two causes: the
   * automatic sweep after an uninstall, and an admin (or a cross-program
   * reassignment) removing the referral outright. Referrals unassigned by hand
   * have no uninstall at all, so deriving this from the uninstall alone would
   * keep paying them forever.
   */
  unassignedAt?: string | null;
}

/** How a program turns a qualifying charge into money. */
export const PAYOUT_BASES = ['percent_of_gross', 'flat_per_referral'] as const;
export type PayoutBasis = (typeof PAYOUT_BASES)[number];

/** Whether every qualifying charge earns, or only a referral's first. */
export const RECURRENCES = ['recurring', 'first_charge_only'] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export function isPayoutBasis(value: unknown): value is PayoutBasis {
  return typeof value === 'string' && (PAYOUT_BASES as readonly string[]).includes(value);
}

export function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === 'string' && (RECURRENCES as readonly string[]).includes(value);
}

/**
 * Every rule added after the first version of this engine is **optional**, and
 * absent always means the behaviour that existed before it.
 *
 * That is not politeness towards old call sites. These values decide money, and
 * a required field would have been satisfied at each call site by whatever the
 * author guessed, silently, in four places. Optional-with-a-stated-default
 * means there is exactly one place the default lives (`resolved()` below) and
 * one place to read to find out what a programme that says nothing pays.
 */
export interface ProgramRules {
  id: string;
  /**
   * What a qualifying charge earns. Defaults to `percent_of_gross`.
   *
   * `percent_of_gross` is the common case and the only one this system had for
   * its first two years. `flat_per_referral` pays a fixed amount **once**, on a
   * referral's first qualifying charge — a bounty for producing a customer
   * rather than a share of what that customer spends.
   */
  payoutBasis?: PayoutBasis;
  /** 20 means 20%. Percent here; the column stores the fraction. */
  percentCommission: number;
  /**
   * The bounty, when `payoutBasis` is `flat_per_referral`. Ignored otherwise.
   *
   * It carries its own currency because it cannot inherit one: a percentage is
   * a share of a charge and is denominated by that charge, while a flat amount
   * is a number somebody typed and means nothing without saying what of. There
   * is no FX anywhere in this system, so a bounty paid against a charge in
   * another currency is *not* converted — it is written in `flatCurrency` and
   * both currencies land in `CommissionRun.currencies`, which is the existing
   * signal for "these totals are adding unlike units".
   */
  flatAmount?: number;
  flatCurrency?: string;
  /**
   * Whether every qualifying charge earns, or only the first on a referral.
   * Defaults to `recurring`.
   *
   * `flat_per_referral` is once-only by construction, so this is the setting
   * that lets a *percentage* programme pay on the first charge alone.
   */
  recurrence?: Recurrence;
  revenueComponents: RevenueComponent[];
  /**
   * How long a referral keeps earning, in months. `null` is lifetime.
   *
   * The window starts at the date of the FIRST COMMISSION, not the referral
   * date. If a programme promises something else, this is the line to change.
   * A ledger cannot easily confirm or refute which convention produced it,
   * because a capped window only bites once a referral has run the full term.
   * The distinction is not
   * academic even so: the lag from referral to first commission is routinely
   * weeks and can exceed a year, so starting the clock at the referral instead
   * would silently shorten every window by that lag — and shorten it most for
   * the affiliates who referred the slowest-converting merchants.
   */
  durationMonths: number | null;
  /**
   * How long after an uninstall a referral keeps earning. `null` is "never
   * released".
   *
   * The commission ledger alone cannot tell you whether such a rule is live,
   * and this is worth knowing before anybody concludes the column is
   * decorative: uninstalling cancels the merchant's subscription, so the
   * charges stop on their own long before a grace period of any normal length
   * could bind. The evidence for the rule is in *unassignments* rather than in
   * commissions — a daily sweep releasing referrals a fixed number of days
   * after their merchant left is what the column describes.
   *
   * Note what such a sweep does and does not do: it releases the referral, it
   * does not cancel commissions already earned. This implements the same.
   */
  unassignAfterUninstallDays: number | null;
  /** Switch for the rule above. Defaults to off when omitted; see the note. */
  enforceUnassignAfterUninstall?: boolean;
}

/**
 * One programme's terms as they stood from an instant onwards.
 *
 * `effectiveFrom` is an ISO-8601 instant, and a version applies to every charge
 * at or after it until the next version begins.
 */
export interface EffectiveRules extends ProgramRules {
  effectiveFrom: string;
}

/**
 * A programme's terms over time.
 *
 * The engine used to be handed one `ProgramRules` per programme, which encoded
 * an assumption nobody stated: that a programme's terms are a property of *now*
 * rather than of the charge being priced. That was true while terms could only
 * be changed by editing a row by hand, and it stops being true the moment an
 * operator can edit a rate from a dashboard — every historical commission would
 * then re-price itself on the next sync, and the reconciliation report, whose
 * whole job is to surface a handful of real discrepancies, would fill with
 * differences that are not real.
 *
 * So a programme is a *timeline*, and the rule that applies to a charge is the
 * one in force when that charge occurred.
 */
export interface ProgramRuleTimeline {
  id: string;
  /** At least one, ordered oldest first. */
  versions: EffectiveRules[];
}

/**
 * What the engine accepts per programme: a timeline, or a single set of rules.
 *
 * Both, deliberately. A single `ProgramRules` means "these terms, for all
 * time", which is exactly right for the two callers that are replaying history
 * against a fixed rule — `commissionReplay.ts` proving the engine against the
 * migrated ledger, and every unit test that is testing arithmetic rather than
 * versioning. Forcing those to wrap a one-element array would add ceremony to
 * the places that most need to stay readable.
 */
export type ProgramRuleEntry = ProgramRules | ProgramRuleTimeline;

function isTimeline(entry: ProgramRuleEntry): entry is ProgramRuleTimeline {
  return Array.isArray((entry as ProgramRuleTimeline).versions);
}

/**
 * The terms in force at an instant.
 *
 * A charge **earlier than the first version** resolves to that first version
 * rather than to nothing. There is no such thing as an unpriced commission: a
 * charge that fell before any recorded terms is a gap in the *records*, not
 * evidence that the programme paid zero that day, and returning null here would
 * turn it into a silent skip with no reason attached. The migration seeds every
 * existing programme's first version at its `created_at`, so this branch only
 * fires for a charge that predates the programme itself.
 */
export function rulesAt(entry: ProgramRuleEntry, instant: string): ProgramRules {
  if (!isTimeline(entry)) return entry;
  // A timeline with no versions is a construction error, not a data state:
  // `timelinesFromPrograms` synthesises one from the program's own columns
  // rather than emit an empty list, precisely so this cannot happen. Refusing
  // loudly beats pricing a charge at zero and calling it a commission.
  let chosen = entry.versions[0];
  if (!chosen) throw new Error(`Program ${entry.id} has no terms to price against.`);
  for (const version of entry.versions) {
    if (version.effectiveFrom <= instant) chosen = version;
    else break;
  }
  return chosen;
}

/** Every rule a programme could apply, for callers deciding what to load. */
export function allRuleVersions(entry: ProgramRuleEntry): ProgramRules[] {
  return isTimeline(entry) ? entry.versions : [entry];
}

/** The optional rules, with their documented defaults applied exactly once. */
function resolved(rules: ProgramRules): {
  payoutBasis: PayoutBasis;
  recurrence: Recurrence;
  flatAmount: number;
  flatCurrency: string;
} {
  return {
    payoutBasis: rules.payoutBasis ?? 'percent_of_gross',
    recurrence: rules.recurrence ?? 'recurring',
    flatAmount: rules.flatAmount ?? 0,
    flatCurrency: rules.flatCurrency ?? '',
  };
}

export interface ComputedCommission {
  attributionId: string;
  affiliateId: string;
  programId: string;
  transactionId: string;
  appId: string;
  shopId: string;
  /** Rounded to cents. See `roundToCents`. */
  amount: number;
  /** Carried through so a diff can report what a commission was earned on. */
  grossAmount: number;
  /**
   * The currency the commission is *in*, which is the charge's for a percentage
   * and the bounty's for a flat amount. Not always the charge's currency.
   */
  currency: string;
  /**
   * The percentage this was priced at, or null for a flat bounty.
   *
   * Emitted by the engine rather than looked up by the writer. The writer used
   * to read the rate off the programme's *current* rules while the amount came
   * from the engine — harmless while a programme had one set of terms forever,
   * and a row that contradicts itself the moment terms are versioned.
   */
  rate: number | null;
  occurredAt: string;
}

/**
 * Why a transaction earned nothing. Kept as data rather than dropped silently,
 * because "this paid less than the platform it replaced" is only answerable if
 * the engine can say which gate closed.
 */
export type SkipReason =
  | 'unattributed'
  | 'component_excluded'
  | 'non_positive_gross'
  | 'before_referral'
  | 'after_duration_window'
  | 'after_uninstall_grace'
  | 'after_unassignment'
  /**
   * The referral has already earned, and this programme pays once.
   *
   * Distinct from `after_duration_window` on purpose, even though both mean
   * "too late": a duration window is a date somebody can argue about, and this
   * is the programme's shape. An affiliate asking why a second charge earned
   * nothing deserves the second answer, not the first.
   */
  | 'after_first_charge';

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
 * A ledger built by applying a rate in binary floating point and storing the
 * result raw carries values like `251.8000000000001`. That noise is not
 * reproduced here, and it is not allowed to count as disagreement either — the
 * validation harness compares with a cent tolerance for exactly this reason.
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
  rulesByProgram: Map<string, ProgramRuleEntry>,
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
      const entry = rulesByProgram.get(attribution.programId);
      if (!entry) continue;

      // The terms in force when this charge happened, not the terms in force
      // now. This one line is what stops an edited rate restating history.
      const rules = rulesAt(entry, transaction.occurredAt);
      const { payoutBasis, recurrence, flatAmount, flatCurrency } = resolved(rules);

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

      // Credits and downgrade adjustments arrive as sales with a negative
      // gross. A negative commission takes money back from somebody who has
      // usually already been paid it, so a clawback is a change in policy
      // rather than a fix. They pass without earning.
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
      /*
       * A programme that pays once has now been paid, if it ever was.
       *
       * Checked after every other gate for the same reason the duration gate
       * is: a charge that fails an earlier test must not be able to consume a
       * referral's one payment. A usage charge on a subscription-only bounty
       * programme would otherwise spend the bounty and earn nothing with it.
       *
       * `windowStart` already records the first *earning* instant per referral,
       * because the duration cap needs it, so "has this referral earned yet" is
       * a question the engine could already answer.
       */
      const earnsOnlyOnce = payoutBasis === 'flat_per_referral' || recurrence === 'first_charge_only';
      if (earnsOnlyOnce && windowStart.has(attribution.id)) {
        skip('after_first_charge');
        continue;
      }

      if (!windowStart.has(attribution.id)) {
        windowStart.set(attribution.id, transaction.occurredAt);
      }

      // A percentage is denominated by the charge it is a share of; a bounty is
      // denominated by whoever typed it. Both land in `currencies`, so a
      // programme paying a dollar bounty on a euro charge shows up as the
      // two-currency total it is rather than being quietly added together.
      const flat = payoutBasis === 'flat_per_referral';
      const currency = flat ? flatCurrency || transaction.currency : transaction.currency;
      currencies.add(currency);

      commissions.push({
        attributionId: attribution.id,
        affiliateId: attribution.affiliateId,
        programId: attribution.programId,
        transactionId: transaction.id,
        appId: transaction.appId,
        shopId: transaction.shopId,
        amount: flat
          ? roundToCents(flatAmount)
          : commissionAmount(transaction.grossAmount, rules.percentCommission),
        grossAmount: transaction.grossAmount,
        currency,
        rate: flat ? null : rules.percentCommission,
        occurredAt: transaction.occurredAt,
      });
    }
  }

  return { commissions, skipped, currencies: [...currencies].sort() };
}

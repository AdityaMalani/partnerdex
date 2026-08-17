import { getDb, type Db } from '../db/index.js';
import {
  REVENUE_COMPONENTS,
  allRuleVersions,
  computeCommissions,
  isPayoutBasis,
  isRecurrence,
  isRevenueComponent,
  type CommissionAttribution,
  type CommissionTransaction,
  type EffectiveRules,
  type ProgramRuleTimeline,
  type ProgramRules,
  type RevenueComponent,
} from './commission.js';
import { upsertCommission } from './store.js';

/**
 * Running the commission engine against this store, on a schedule.
 *
 * `commission.ts` is pure and knows nothing about the database, which is what
 * makes it replayable against two years of Mantle history. This is the other
 * half: it loads referrals, rules and transactions out of SQLite, hands them to
 * the engine, and writes the answer back.
 *
 * ## The one rule this file exists to protect
 *
 * Commission **amounts** are a derivation. They are recomputed from scratch on
 * every sync and rewritten in place, because a rule change, a corrected
 * referral date or a late transaction all have to be able to change them.
 *
 * Stated precisely, now that a programme's terms are versioned:
 *
 * > **An amount is what the rules in force when the charge occurred say.**
 *
 * That is the same invariant, sharpened rather than weakened. It used to read
 * "what the rules say", which was indistinguishable from this one while a
 * programme's terms could only be changed by editing a row by hand — and stops
 * being so the moment an operator can edit a rate from a dashboard. Under the
 * old reading, every rate edit re-priced every commission the programme had
 * ever earned, including paid ones, and filled the reconciliation report with
 * differences that were not real. Under this one, editing a rate writes a new
 * version effective from now and nothing historical moves, because every
 * historical charge still resolves against the version it was priced under.
 *
 * What still moves a paid commission's amount, and must: a corrected referral
 * date, a late transaction, an unassignment, an approved claim. Those change
 * what was truly earned. The distinction is between changing what the rules
 * were and changing what happened.
 *
 * Commission **payments** are not a derivation and can never become one.
 * `paid_at`, `paid_amount`, `payment_reference` and `payment_note` record that
 * money left the building — an event that happens outside this system entirely
 * and that nothing here can reconstruct if it is lost. This store holds the
 * only copy.
 *
 * So the split is enforced structurally rather than by care:
 *
 *  - Writes go through `upsertCommission`, whose `ON CONFLICT` clause lists the
 *    columns it updates and does not list any payment column. There is no code
 *    path in this file that writes one.
 *  - Nothing is ever deleted. A commission that stops qualifying is soft
 *    cancelled, which is a separate column again.
 *  - A row that has already been paid is not even cancelled. It is counted and
 *    reported as a discrepancy for a person to settle, because "we paid this
 *    and now believe it was not owed" is a conversation, not a database write.
 *
 * The failure being designed against is concrete: a recompute that clears a
 * payment record destroys the only record of who has been paid, and the first
 * symptom is paying hundreds of people twice.
 */

export interface CommissionRecomputeResult {
  /** Referrals the engine was given — those with a resolved shop and an app. */
  attributions: number;
  /** Referrals skipped because their merchant has not synced yet. */
  unresolvedAttributions: number;
  /** Commission rows inserted or updated. */
  written: number;
  /**
   * Imported rows this run recognised as the same commission it just computed,
   * and linked to our transaction id instead of writing a second row. See
   * `adoptImported`.
   */
  adopted: number;
  /** Total of every commission the engine computed this run. */
  amount: number;
  /** Previously computed rows that no longer qualify and were soft cancelled. */
  cancelled: number;
  /**
   * Rows that no longer qualify but carry a payment. Left exactly as they are —
   * see the note above — and surfaced so somebody can look.
   */
  paidButIneligible: number;
  /**
   * Every currency seen. More than one means the totals downstream are adding
   * unlike units: there is no FX conversion anywhere in this system.
   */
  currencies: string[];
}

const EMPTY: CommissionRecomputeResult = {
  attributions: 0,
  unresolvedAttributions: 0,
  written: 0,
  adopted: 0,
  amount: 0,
  cancelled: 0,
  paidButIneligible: 0,
  currencies: [],
};

interface ProgramRow {
  id: string;
  app_id: string;
  commission_rate: number;
  revenue_components: string;
  duration_months: number | null;
  unassign_after_uninstall_days: number | null;
  payout_basis?: string;
  flat_amount?: number;
  flat_currency?: string;
  recurrence?: string;
  enforce_unassign_after_uninstall?: number;
}

/** One row of `affiliate_program_terms`, plus the program it belongs to. */
interface ProgramTermsRow extends ProgramRow {
  program_id: string;
  effective_from: string;
}

interface AttributionRow {
  id: string;
  affiliate_id: string;
  program_id: string;
  shop_id: string;
  app_id: string;
  referred_at: string;
  deleted_at: string | null;
}

/**
 * Which Partner API transaction types carry which revenue stream.
 *
 * The seam between a platform's spelling and this system's vocabulary, and the
 * only place the two are allowed to meet. `revenue_components` was decorative
 * until this map existed: the recompute read subscription sales and nothing
 * else, then labelled every row it read `subscription`, so a program set to
 * `["usage"]` was handed no usage charges to pay on and earned nothing — with
 * no error, no skip reason, and a settings screen still showing `usage`.
 *
 * `AppSaleAdjustment` and `AppSaleCredit` are deliberately absent. They are
 * corrections to an earlier charge rather than a revenue stream anyone can
 * enrol in, they arrive negative, and the engine already declines to write a
 * negative commission — including them would only produce skips.
 */
const TRANSACTION_TYPE_BY_COMPONENT: Record<RevenueComponent, string> = {
  subscription: 'AppSubscriptionSale',
  usage: 'AppUsageSale',
  one_time: 'AppOneTimeSale',
};

const COMPONENT_BY_TRANSACTION_TYPE = new Map<string, RevenueComponent>(
  (Object.entries(TRANSACTION_TYPE_BY_COMPONENT) as Array<[RevenueComponent, string]>).map(
    ([component, type]) => [type, component],
  ),
);

/**
 * A program row's components, checked against the vocabulary.
 *
 * Three failure modes, three different answers, none of them silent:
 * unparseable JSON and an empty list both fall back to subscription-only —
 * which is what a program with a broken settings column was almost certainly
 * paying on — while an entry outside the vocabulary is dropped and logged with
 * the program id, because that one is a live money bug and the operator is the
 * only person who can fix it. Writes go through `programAdmin.ts`, which
 * refuses such a value outright; anything reaching here predates that check.
 */
function componentsOf(row: ProgramRow): RevenueComponent[] {
  let raw: unknown[] = [];
  try {
    const parsed = JSON.parse(row.revenue_components) as unknown;
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    // Handled by the empty-list fallback below.
  }
  if (raw.length === 0) return ['subscription'];

  const known = raw.filter(isRevenueComponent);
  const unknown = raw.filter((entry) => !isRevenueComponent(entry));
  if (unknown.length > 0) {
    console.warn(
      `[partnerdex] program ${row.id} lists revenue component(s) ` +
        `${unknown.map((entry) => JSON.stringify(entry)).join(', ')}, which nothing pays on. ` +
        `Known components: ${REVENUE_COMPONENTS.join(', ')}.`,
    );
  }
  return known.length > 0 ? known : ['subscription'];
}

/**
 * Program rows as engine rules.
 *
 * Two conversions happen here and nowhere else. The schema stores the rate as a
 * fraction (0.2) because multiplying is all anyone does with it; the engine
 * takes a percentage (20) because that is what the Mantle export stores and
 * what the validation harness compares against. And `revenue_components` is
 * JSON in the column, since nothing queries inside it.
 *
 * `enforceUnassignAfterUninstall` is a column now, and it used to be the
 * literal `true` on the line below. A grace period after an uninstall is only a
 * rule if something enforces it, and a program that stores one and never
 * applies it keeps paying on a merchant nobody referred any more — so the
 * behaviour is right and it is kept. What was wrong is that it was not a
 * choice: `ProgramRules` documents the flag as defaulting *off* so that "a
 * program that never says so does not silently acquire the behaviour", and the
 * only production caller then passed `true` for every program ever created. The
 * migration seeds the column to 1 for exactly that reason — from the behaviour,
 * not from the documentation.
 *
 * Unknown components are dropped and reported, never obeyed. See
 * `REVENUE_COMPONENTS` in `commission.ts` for why silence would be the
 * expensive choice here.
 */
export function rulesFromPrograms(rows: ProgramRow[]): Map<string, ProgramRules> {
  const rules = new Map<string, ProgramRules>();
  for (const row of rows) rules.set(row.id, rulesFromRow(row.id, row));
  return rules;
}

/** One row — a program or one of its versions — as engine rules. */
function rulesFromRow(id: string, row: ProgramRow): ProgramRules {
  return {
    id,
    payoutBasis: isPayoutBasis(row.payout_basis) ? row.payout_basis : 'percent_of_gross',
    percentCommission: row.commission_rate * 100,
    flatAmount: row.flat_amount ?? 0,
    flatCurrency: row.flat_currency ?? '',
    recurrence: isRecurrence(row.recurrence) ? row.recurrence : 'recurring',
    revenueComponents: componentsOf(row),
    durationMonths: row.duration_months,
    unassignAfterUninstallDays: row.unassign_after_uninstall_days,
    // Absent means a database whose migration has not run, which can only be
    // one that has always had the behaviour. Defaulting to true here is the
    // same reading of the same evidence as the migration's own default.
    enforceUnassignAfterUninstall: (row.enforce_unassign_after_uninstall ?? 1) !== 0,
  };
}

/**
 * Every program's terms over time, ready for the engine.
 *
 * A program with no versions falls back to its own columns as a single
 * timeless rule. That is not a defensive crouch: the migration gives every
 * existing program a version, but a program created by an importer that has not
 * been taught about versions yet would otherwise price at zero — which is the
 * one failure mode worth spending a branch on, because it is silent and it is
 * money.
 */
export function timelinesFromPrograms(
  programs: ProgramRow[],
  terms: ProgramTermsRow[],
): Map<string, ProgramRuleTimeline> {
  const byProgram = new Map<string, EffectiveRules[]>();
  for (const row of terms) {
    const version: EffectiveRules = {
      ...rulesFromRow(row.program_id, row),
      effectiveFrom: row.effective_from,
    };
    const list = byProgram.get(row.program_id);
    if (list) list.push(version);
    else byProgram.set(row.program_id, [version]);
  }

  const timelines = new Map<string, ProgramRuleTimeline>();
  for (const program of programs) {
    const versions = byProgram.get(program.id);
    if (versions && versions.length > 0) {
      // `rulesAt` walks forwards and stops at the first version past the
      // instant, so the order is load-bearing rather than cosmetic.
      versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      timelines.set(program.id, { id: program.id, versions });
      continue;
    }
    timelines.set(program.id, {
      id: program.id,
      versions: [{ ...rulesFromRow(program.id, program), effectiveFrom: '' }],
    });
  }
  return timelines;
}

/**
 * When the merchant last removed the app, or null if they still have it.
 *
 * Read off `install_intervals`, which the derive step rebuilds every sync from
 * the raw relationship events. The *latest* interval is the one that decides:
 * a merchant who uninstalled and came back has an open interval on top, and
 * treating the older uninstall as current would stop paying an affiliate whose
 * merchant is a live customer again.
 */
function lastUninstall(db: Db, appId: string, shopId: string): string | null {
  const row = db
    .prepare(
      `SELECT ended_at FROM install_intervals
        WHERE app_id = ? AND shop_id = ?
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(appId, shopId) as { ended_at: string | null } | undefined;
  return row?.ended_at ?? null;
}

/**
 * The imported ledger, keyed the only way it can be matched back.
 *
 * Mantle's transaction ids are Mantle's — they are nothing like PartnerDex's
 * `gid://partners/AppSubscriptionSale/...` — so every imported commission
 * carries `transaction_id = ''`. That leaves the recompute unable to tell that
 * a charge it has just commissioned is the *same* charge Mantle already
 * commissioned, and without this it would write a second row beside it. Every
 * historical commission would then be counted twice, and the reconciliation
 * endpoint would report roughly double what is owed.
 *
 * The key is the one the migration established: same referral, same day, same
 * amount to the cent. Ambiguous keys — two imported commissions on one referral
 * on one day for the same amount — are dropped from the map rather than guessed
 * at, because linking the wrong one would attach a payment record to a charge
 * that did not earn it.
 */
function adoptableImports(db: Db, inScope: Set<string>): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT id, attribution_id, earned_at, amount
         FROM affiliate_commissions
        WHERE source = 'imported' AND transaction_id = '' AND cancelled_at IS NULL`,
    )
    .all() as Array<{ id: string; attribution_id: string; earned_at: string; amount: number }>;

  const byKey = new Map<string, string | null>();
  for (const row of rows) {
    if (!inScope.has(row.attribution_id)) continue;
    const key = importKey(row.attribution_id, row.earned_at, row.amount);
    // Second sighting poisons the key: null means "known, but ambiguous".
    byKey.set(key, byKey.has(key) ? null : row.id);
  }

  const adoptable = new Map<string, string>();
  for (const [key, id] of byKey) if (id) adoptable.set(key, id);
  return adoptable;
}

function importKey(attributionId: string, earnedAt: string, amount: number): string {
  return `${attributionId}|${earnedAt.slice(0, 10)}|${Math.round(amount * 100)}`;
}

/**
 * Recompute every commission this ledger's referrals earn.
 *
 * Whole-ledger rather than incremental, deliberately. The engine's duration
 * window is anchored to a referral's *first* commission, so a transaction
 * arriving today can change whether one from eighteen months ago was inside the
 * window — an incremental pass over "new transactions only" cannot see that. At
 * the scale this runs at (a few hundred referrals, a few thousand charges) the whole
 * recompute is a handful of indexed reads, and correctness is worth more than
 * the milliseconds.
 */
export function recomputeCommissions(db: Db = getDb()): CommissionRecomputeResult {
  const programs = db
    .prepare(
      `SELECT id, app_id, commission_rate, revenue_components, duration_months,
              unassign_after_uninstall_days, payout_basis, flat_amount, flat_currency,
              recurrence, enforce_unassign_after_uninstall
         FROM affiliate_programs`,
    )
    .all() as ProgramRow[];
  if (programs.length === 0) return EMPTY;

  const terms = db
    .prepare(
      `SELECT program_id, program_id AS id, '' AS app_id, effective_from, commission_rate,
              revenue_components, duration_months, unassign_after_uninstall_days,
              payout_basis, flat_amount, flat_currency, recurrence,
              enforce_unassign_after_uninstall
         FROM affiliate_program_terms
        ORDER BY program_id, effective_from`,
    )
    .all() as ProgramTermsRow[];

  const rules = timelinesFromPrograms(programs, terms);
  const appOfProgram = new Map(programs.map((row) => [row.id, row.app_id]));

  const rows = db
    .prepare(
      `SELECT id, affiliate_id, program_id, shop_id, app_id, referred_at, deleted_at
         FROM affiliate_attributions`,
    )
    .all() as AttributionRow[];

  const attributions: CommissionAttribution[] = [];
  const inScope = new Set<string>();
  let unresolved = 0;

  for (const row of rows) {
    // The attribution's own app id, then the program's. The first is blank on
    // rows imported before the local app existed; the second is blank until an
    // app has been matched to a program. Either way, no app means no way to
    // find the transactions, so the referral is counted and left alone rather
    // than silently contributing nothing.
    const appId = row.app_id || appOfProgram.get(row.program_id) || '';
    if (!appId || !row.shop_id) {
      unresolved += 1;
      continue;
    }
    inScope.add(row.id);
    attributions.push({
      id: row.id,
      affiliateId: row.affiliate_id,
      programId: row.program_id,
      appId,
      shopId: row.shop_id,
      referredAt: row.referred_at,
      uninstalledAt: lastUninstall(db, appId, row.shop_id),
      // A soft-deleted referral is one that was unassigned, and the engine
      // stops it earning from that instant — it does not erase what it earned
      // before. Dropping these rows instead would recompute those earlier
      // commissions as unattributed and cancel money that was genuinely owed.
      unassignedAt: row.deleted_at,
    });
  }

  if (attributions.length === 0) {
    return { ...EMPTY, unresolvedAttributions: unresolved };
  }

  /*
   * Charges are pulled per referred merchant rather than by scanning the
   * transaction table. There are millions of transactions in a mature install
   * and a few hundred referred shops; the engine would discard everything else
   * anyway.
   *
   * Which *types* are read is decided by the programs, not by this file. The
   * union across every program's `revenue_components` is what gets loaded, so a
   * program that pays on usage is handed usage charges and a deployment where
   * no program pays on usage never reads a usage row. Narrowing here rather
   * than letting the engine skip them matters at this scale: usage sales
   * routinely outnumber subscription sales by an order of magnitude, and
   * loading them to throw them away would be the most expensive thing the
   * recompute does.
   */
  const wanted = new Set<string>();
  for (const timeline of rules.values()) {
    // The union across every *version*, not just the current one. A program
    // that paid on usage last year and does not now still has last year's
    // usage charges to price, and narrowing to today's components would drop
    // them from the load and cancel commissions that were genuinely earned.
    for (const rule of allRuleVersions(timeline)) {
      for (const component of rule.revenueComponents) {
        const type = TRANSACTION_TYPE_BY_COMPONENT[component];
        if (type) wanted.add(type);
      }
    }
  }
  if (wanted.size === 0) {
    return { ...EMPTY, attributions: attributions.length, unresolvedAttributions: unresolved };
  }
  const query = db.prepare(
    `SELECT id, app_id, shop_id, type, created_at, gross_amount, currency
       FROM transactions
      WHERE app_id = ? AND shop_id = ?
        AND type IN (${[...wanted].map(() => '?').join(', ')})`,
  );
  const wantedTypes = [...wanted];
  const transactions: CommissionTransaction[] = [];
  const seenTransaction = new Set<string>();
  const seenShop = new Set<string>();

  for (const attribution of attributions) {
    // Two programs can refer the same merchant on the same app, and both
    // referrals want the same charges. Loading them once keeps the engine from
    // seeing the same transaction id twice for one (app, shop).
    const key = `${attribution.appId} ${attribution.shopId}`;
    if (seenShop.has(key)) continue;
    seenShop.add(key);

    for (const row of query.all(attribution.appId, attribution.shopId, ...wantedTypes) as Array<{
      id: string;
      app_id: string;
      shop_id: string;
      type: string;
      created_at: string;
      gross_amount: number;
      currency: string;
    }>) {
      if (seenTransaction.has(row.id)) continue;
      seenTransaction.add(row.id);
      // The type is only in `wanted` because some program asked for it, so the
      // lookup cannot miss. Skipping rather than defaulting is still the right
      // shape: a default here would be the same silent mislabelling this map
      // was added to remove.
      const component = COMPONENT_BY_TRANSACTION_TYPE.get(row.type);
      if (!component) continue;
      transactions.push({
        id: row.id,
        appId: row.app_id,
        shopId: row.shop_id,
        component,
        occurredAt: new Date(row.created_at).toISOString(),
        grossAmount: row.gross_amount,
        currency: row.currency,
      });
    }
  }

  const run = computeCommissions(transactions, attributions, rules);

  const result: CommissionRecomputeResult = {
    attributions: attributions.length,
    unresolvedAttributions: unresolved,
    written: 0,
    adopted: 0,
    amount: 0,
    cancelled: 0,
    paidButIneligible: 0,
    currencies: run.currencies,
  };

  const write = db.transaction(() => {
    const earned = new Set<string>();
    const adoptable = adoptableImports(db, inScope);
    const link = db.prepare('UPDATE affiliate_commissions SET transaction_id = ? WHERE id = ?');
    const existing = db.prepare(
      'SELECT id FROM affiliate_commissions WHERE attribution_id = ? AND transaction_id = ?',
    );

    /*
     * Refreshing a row this run already knows about.
     *
     * Every column named here is a derivation — the amount, what it was
     * computed from, and when. Read the list and note what is absent: `paid_at`,
     * `paid_amount`, `payment_reference` and `payment_note` cannot be written by
     * this statement because they are not in it, which is a stronger guarantee
     * than remembering not to set them. `markCommissionPaid` is the only writer
     * of those columns in the codebase.
     *
     * `source` is absent too, so an imported row that this engine has since
     * adopted keeps saying it came from Mantle, which is true and is what makes
     * the reconciliation against their export still possible afterwards.
     */
    const refresh = db.prepare(
      `UPDATE affiliate_commissions
          SET amount = @amount, currency = @currency, basis_amount = @basisAmount,
              rate = @rate, earned_at = @earnedAt, computed_at = @now,
              cancelled_at = NULL, cancel_reason = NULL
        WHERE id = @id`,
    );
    const computedAt = new Date().toISOString();

    for (const commission of run.commissions) {
      earned.add(`${commission.attributionId} ${commission.transactionId}`);
      // The rate the engine actually priced this charge at, not the program's
      // current one. Those were the same number until terms became versioned,
      // and reading the current one now would stamp every historical row with
      // today's rate beside an amount computed from a different one.
      const rate = commission.rate;
      let rowId = (
        existing.get(commission.attributionId, commission.transactionId) as
          | { id: string }
          | undefined
      )?.id;

      /*
       * No row for this charge yet — but Mantle may already have paid it, under
       * an id of theirs that means nothing here. Claiming their row and writing
       * our transaction id onto it is what keeps the two ledgers one ledger,
       * instead of every historical commission appearing twice.
       */
      if (!rowId) {
        const key = importKey(commission.attributionId, commission.occurredAt, commission.amount);
        const importedId = adoptable.get(key);
        if (importedId) {
          link.run(commission.transactionId, importedId);
          adoptable.delete(key);
          rowId = importedId;
          result.adopted += 1;
        }
      }

      if (rowId) {
        // In place, through a statement that cannot name a payment column.
        // Clearing `cancelled_at` here is how a commission withdrawn by an
        // earlier run comes back when it qualifies again — a referral
        // reinstated, a rule corrected.
        refresh.run({
          id: rowId,
          amount: commission.amount,
          currency: commission.currency,
          basisAmount: commission.grossAmount,
          rate,
          earnedAt: commission.occurredAt,
          now: computedAt,
        });
      } else {
        upsertCommission(
          {
            attributionId: commission.attributionId,
            affiliateId: commission.affiliateId,
            programId: commission.programId,
            transactionId: commission.transactionId,
            amount: commission.amount,
            currency: commission.currency,
            basisAmount: commission.grossAmount,
            rate,
            earnedAt: commission.occurredAt,
            source: 'computed',
          },
          db,
        );
      }
      result.written += 1;
      result.amount += commission.amount;
    }

    /*
     * Rows this engine wrote before and would not write now.
     *
     * They exist because something changed — a referral was unassigned, a
     * transaction was refunded to a negative gross, a duration window closed.
     * The row is withdrawn rather than removed: an affiliate's statement still
     * has to be able to explain why last month's figure changed, and a deleted
     * row explains nothing.
     *
     * Scoped to referrals actually evaluated this run. A referral whose
     * merchant has not synced yet was never given to the engine, so its
     * commissions are not "no longer earned" — they are simply unexamined, and
     * cancelling them would turn an incomplete sync into a withdrawn payment.
     */
    const previous = db
      .prepare(
        `SELECT id, attribution_id, transaction_id, paid_at
           FROM affiliate_commissions
          WHERE source = 'computed' AND cancelled_at IS NULL AND transaction_id <> ''`,
      )
      .all() as Array<{
      id: string;
      attribution_id: string;
      transaction_id: string;
      paid_at: string | null;
    }>;

    const cancel = db.prepare(
      `UPDATE affiliate_commissions
          SET cancelled_at = ?, cancel_reason = ?
        WHERE id = ? AND paid_at IS NULL`,
    );
    const now = new Date().toISOString();

    for (const row of previous) {
      if (!inScope.has(row.attribution_id)) continue;
      if (earned.has(`${row.attribution_id} ${row.transaction_id}`)) continue;
      if (row.paid_at) {
        // Already paid and no longer owed. Not this function's decision to
        // unwind: the payment is a fact, the recompute is an opinion.
        result.paidButIneligible += 1;
        continue;
      }
      cancel.run(now, 'No longer earns under the current referral and program rules.', row.id);
      result.cancelled += 1;
    }
  });
  write();

  result.amount = Math.round(result.amount * 100) / 100;
  return result;
}

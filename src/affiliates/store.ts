import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '../db/index.js';

/**
 * Reads and writes for the affiliate ledger.
 *
 * Every write in here is an upsert keyed on something stable, because the two
 * callers that exist — the Mantle import and, later, the commission engine —
 * are both expected to run repeatedly over the same facts. Running either twice
 * has to be indistinguishable from running it once; that guarantee lives here
 * rather than in each caller, so there is one place it can be wrong.
 *
 * Ids are ours (`randomUUID`), not the source platform's. An imported row keeps
 * its origin in `external_id`, which is what re-reconciliation joins on, but the
 * primary key stays under our control so that nothing in this system inherits a
 * dependency on a platform that shuts down on 2026-08-14.
 */

export interface AffiliateInput {
  name: string;
  email: string;
  paypalEmail?: string | null;
  status?: 'active' | 'disabled';
  payoutHold?: boolean;
  source?: 'imported' | 'signup';
  externalId?: string;
  createdAt?: string;
}

export interface ProgramInput {
  appId?: string;
  name?: string;
  /** The App Store page this program's referral links point at. */
  listingUrl?: string;
  commissionRate: number;
  revenueComponents?: string[];
  durationMonths?: number | null;
  unassignAfterUninstallDays?: number | null;
  requireApproval?: boolean;
  status?: 'active' | 'closed';
  externalId?: string;
  createdAt?: string;
}

export type MembershipStatus = 'enrolled' | 'pending' | 'rejected';

export interface MembershipInput {
  affiliateId: string;
  programId: string;
  handle: string;
  status: MembershipStatus;
  joinedAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  externalId?: string;
}

export type AttributionSource = 'ga4' | 'manual' | 'imported';

export interface AttributionInput {
  affiliateId: string;
  programId: string;
  /** Blank when the shop has not been synced yet; `myshopifyDomain` recovers it. */
  shopId?: string;
  myshopifyDomain: string;
  appId?: string;
  referredAt: string;
  source: AttributionSource;
  handle?: string;
  externalId?: string;
  externalPageViewId?: string;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface CommissionInput {
  attributionId: string;
  affiliateId: string;
  programId: string;
  /** `transactions.id`. Blank on imported rows — see the schema comment. */
  transactionId?: string;
  amount: number;
  currency?: string;
  basisAmount?: number | null;
  rate?: number | null;
  earnedAt: string;
  source?: 'computed' | 'imported';
  externalId?: string;
  externalTransactionId?: string;
  paidAt?: string | null;
  paidAmount?: number | null;
  paymentReference?: string | null;
  paymentNote?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
}

/**
 * Find the row a write should land on, in the order of decreasing certainty:
 * the source platform's id, then the natural key.
 *
 * Splitting it out is what keeps every upsert below honest about the difference
 * between "the same record" and "a record that happens to look similar".
 *
 * The natural-key fallback refuses to land on a row that already carries a
 * *different* `external_id`, and that guard is not theoretical. Mantle's export
 * contains two merchants with both a soft-deleted referral and a live one on the
 * same program: without it, the second of the pair matches the first on its
 * natural key, and two distinct facts silently become one row. The fallback
 * exists to reconcile an imported record with one created here, which is a row
 * whose `external_id` is blank — not to merge two records from the same source.
 */
function existingId(
  db: Db,
  table: string,
  externalId: string | undefined,
  natural: { sql: string; params: unknown[] } | null,
): string | null {
  if (externalId) {
    const row = db
      .prepare(`SELECT id FROM ${table} WHERE external_id = ?`)
      .get(externalId) as { id: string } | undefined;
    if (row) return row.id;
  }
  if (natural) {
    const row = db
      .prepare(
        `SELECT id FROM ${table}
          WHERE ${natural.sql} AND (external_id = '' OR external_id = ?)`,
      )
      .get(...natural.params, externalId ?? '') as { id: string } | undefined;
    if (row) return row.id;
  }
  return null;
}

export function upsertAffiliate(input: AffiliateInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  // No natural key. Email is the obvious candidate and is not one: the imported
  // data has a single address shared by two affiliates, so matching on it would
  // silently merge two people who are owed money separately.
  const id = existingId(db, 'affiliates', input.externalId, null) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliates (id, name, email, paypal_email, status, payout_hold,
                             source, external_id, created_at, updated_at)
     VALUES (@id, @name, @email, @paypalEmail, @status, @payoutHold,
             @source, @externalId, @createdAt, @now)
     ON CONFLICT(id) DO UPDATE SET
       name         = excluded.name,
       email        = excluded.email,
       paypal_email = excluded.paypal_email,
       status       = excluded.status,
       payout_hold  = excluded.payout_hold,
       updated_at   = excluded.updated_at`,
  ).run({
    id,
    name: input.name,
    email: input.email,
    paypalEmail: input.paypalEmail || null,
    status: input.status ?? 'active',
    payoutHold: input.payoutHold ? 1 : 0,
    source: input.source ?? 'signup',
    externalId: input.externalId ?? '',
    createdAt: input.createdAt ?? now,
    now,
  });

  return id;
}

export function upsertProgram(input: ProgramInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id =
    existingId(
      db,
      'affiliate_programs',
      input.externalId,
      // An app has one program here. Falling back to it means a re-import that
      // lost the external id updates the program rather than standing up a
      // second one that every membership would then have to be moved to.
      input.appId ? { sql: 'app_id = ? AND app_id <> \'\'', params: [input.appId] } : null,
    ) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_programs (id, app_id, name, listing_url, commission_rate,
                                     revenue_components, duration_months,
                                     unassign_after_uninstall_days,
                                     require_approval, status, external_id, created_at, updated_at)
     VALUES (@id, @appId, @name, @listingUrl, @rate, @components, @durationMonths, @unassignDays,
             @requireApproval, @status, @externalId, @createdAt, @now)
     ON CONFLICT(id) DO UPDATE SET
       -- Blank never overwrites a stored listing, for the same reason as the app
       -- id: a caller that does not know the URL must not erase one that does.
       listing_url                   = CASE WHEN excluded.listing_url <> ''
                                            THEN excluded.listing_url
                                            ELSE affiliate_programs.listing_url END,
       -- A blank app id never overwrites a resolved one: an import running
       -- before the first sync finishes must not undo what a later one learned.
       app_id                        = CASE WHEN excluded.app_id <> '' THEN excluded.app_id
                                            ELSE affiliate_programs.app_id END,
       name                          = excluded.name,
       commission_rate               = excluded.commission_rate,
       revenue_components            = excluded.revenue_components,
       duration_months               = excluded.duration_months,
       unassign_after_uninstall_days = excluded.unassign_after_uninstall_days,
       require_approval              = excluded.require_approval,
       status                        = excluded.status,
       updated_at                    = excluded.updated_at`,
  ).run({
    id,
    appId: input.appId ?? '',
    name: input.name ?? '',
    listingUrl: input.listingUrl ?? '',
    rate: input.commissionRate,
    components: JSON.stringify(input.revenueComponents ?? ['subscription']),
    durationMonths: input.durationMonths ?? null,
    unassignDays: input.unassignAfterUninstallDays ?? null,
    requireApproval: input.requireApproval ? 1 : 0,
    status: input.status ?? 'active',
    externalId: input.externalId ?? '',
    createdAt: input.createdAt ?? now,
    now,
  });

  return id;
}

export function upsertMembership(input: MembershipInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id =
    existingId(db, 'affiliate_memberships', input.externalId, {
      sql: 'affiliate_id = ? AND program_id = ?',
      params: [input.affiliateId, input.programId],
    }) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_memberships (id, affiliate_id, program_id, handle, status,
                                        joined_at, approved_at, rejected_at,
                                        external_id, created_at, updated_at)
     VALUES (@id, @affiliateId, @programId, @handle, @status,
             @joinedAt, @approvedAt, @rejectedAt, @externalId, @joinedAt, @now)
     ON CONFLICT(id) DO UPDATE SET
       handle      = excluded.handle,
       status      = excluded.status,
       approved_at = excluded.approved_at,
       rejected_at = excluded.rejected_at,
       updated_at  = excluded.updated_at`,
  ).run({
    id,
    affiliateId: input.affiliateId,
    programId: input.programId,
    handle: input.handle,
    status: input.status,
    joinedAt: input.joinedAt,
    approvedAt: input.approvedAt ?? null,
    rejectedAt: input.rejectedAt ?? null,
    externalId: input.externalId ?? '',
    now,
  });

  return id;
}

/**
 * Record a referral.
 *
 * The natural key is (program, merchant) among the live rows, which is the same
 * thing the unique index enforces. A soft-deleted attribution is matched only by
 * its id, never by that key: it has been unassigned, so it neither owns the
 * merchant nor may it claim a row that currently does. A merchant re-referred
 * later is a new claim over a new period, not an edit to the old one.
 */
export function upsertAttribution(input: AttributionInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id =
    existingId(
      db,
      'affiliate_attributions',
      input.externalId,
      input.deletedAt
        ? null
        : {
            sql: 'program_id = ? AND myshopify_domain = ? AND deleted_at IS NULL',
            params: [input.programId, input.myshopifyDomain],
          },
    ) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_attributions (id, affiliate_id, program_id, shop_id, myshopify_domain,
                                         app_id, referred_at, source, handle, external_id,
                                         external_page_view_id, created_at, deleted_at)
     VALUES (@id, @affiliateId, @programId, @shopId, @domain, @appId, @referredAt, @source,
             @handle, @externalId, @pageViewId, @createdAt, @deletedAt)
     ON CONFLICT(id) DO UPDATE SET
       affiliate_id = excluded.affiliate_id,
       -- Blank never overwrites resolved, for shop and app alike: re-running an
       -- import against a fuller \`shops\` table may resolve a referral, and must
       -- never unresolve one.
       shop_id      = CASE WHEN excluded.shop_id <> '' THEN excluded.shop_id
                           ELSE affiliate_attributions.shop_id END,
       app_id       = CASE WHEN excluded.app_id <> '' THEN excluded.app_id
                           ELSE affiliate_attributions.app_id END,
       referred_at  = excluded.referred_at,
       source       = excluded.source,
       handle       = excluded.handle,
       deleted_at   = excluded.deleted_at`,
  ).run({
    id,
    affiliateId: input.affiliateId,
    programId: input.programId,
    shopId: input.shopId ?? '',
    domain: input.myshopifyDomain,
    appId: input.appId ?? '',
    referredAt: input.referredAt,
    source: input.source,
    handle: input.handle ?? '',
    externalId: input.externalId ?? '',
    pageViewId: input.externalPageViewId ?? '',
    createdAt: input.createdAt ?? now,
    deletedAt: input.deletedAt ?? null,
  });

  return id;
}

/**
 * Write a commission, leaving any record of payment alone.
 *
 * The engine recomputes amounts freely, so this updates in place on the natural
 * key. What it will not touch is `paid_at` and the columns beside it: that a
 * payment happened is a fact from outside this system, and no recomputation of
 * ours is entitled to an opinion about it. A commission that turns out to have
 * been wrong after it was paid shows up as an amount that no longer matches its
 * `paid_amount`, which is a discrepancy someone can see and settle — rather than
 * a row that quietly rewrote its own history.
 */
export function upsertCommission(input: CommissionInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id =
    existingId(
      db,
      'affiliate_commissions',
      input.externalId,
      input.transactionId
        ? {
            sql: 'attribution_id = ? AND transaction_id = ?',
            params: [input.attributionId, input.transactionId],
          }
        : null,
    ) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_commissions (id, attribution_id, affiliate_id, program_id,
                                        transaction_id, amount, currency, basis_amount, rate,
                                        earned_at, computed_at, source, external_id,
                                        external_transaction_id, paid_at, paid_amount,
                                        payment_reference, payment_note, cancelled_at, cancel_reason)
     VALUES (@id, @attributionId, @affiliateId, @programId, @transactionId, @amount, @currency,
             @basisAmount, @rate, @earnedAt, @now, @source, @externalId, @externalTransactionId,
             @paidAt, @paidAmount, @paymentReference, @paymentNote, @cancelledAt, @cancelReason)
     ON CONFLICT(id) DO UPDATE SET
       amount         = excluded.amount,
       currency       = excluded.currency,
       basis_amount   = excluded.basis_amount,
       rate           = excluded.rate,
       earned_at      = excluded.earned_at,
       computed_at    = excluded.computed_at,
       transaction_id = CASE WHEN excluded.transaction_id <> '' THEN excluded.transaction_id
                             ELSE affiliate_commissions.transaction_id END,
       -- The one payment column this will write, and only into a hole. A
       -- reference that is already recorded is never rewritten — that is the
       -- rule above — but a row that has none can be told which payout claims
       -- it, which is what lets a re-import repair commissions written before
       -- payouts were modelled instead of leaving them permanently unlinkable.
       payment_reference = COALESCE(NULLIF(affiliate_commissions.payment_reference, ''),
                                    excluded.payment_reference),
       cancelled_at   = excluded.cancelled_at,
       cancel_reason  = excluded.cancel_reason`,
  ).run({
    id,
    attributionId: input.attributionId,
    affiliateId: input.affiliateId,
    programId: input.programId,
    transactionId: input.transactionId ?? '',
    amount: input.amount,
    currency: input.currency ?? 'USD',
    basisAmount: input.basisAmount ?? null,
    rate: input.rate ?? null,
    earnedAt: input.earnedAt,
    source: input.source ?? 'computed',
    externalId: input.externalId ?? '',
    externalTransactionId: input.externalTransactionId ?? '',
    paidAt: input.paidAt ?? null,
    paidAmount: input.paidAmount ?? null,
    paymentReference: input.paymentReference ?? null,
    paymentNote: input.paymentNote ?? null,
    cancelledAt: input.cancelledAt ?? null,
    cancelReason: input.cancelReason ?? null,
    now,
  });

  return id;
}

export interface PayoutInput {
  affiliateId: string;
  /** Null when the payer never recorded one — see the schema note. */
  programId: string | null;
  /** The payer's human-facing reference. Mantle's `number`, as text. */
  number?: string;
  status: 'paid' | 'requested';
  amount: number;
  /** What was actually sent. Null while the payout is only requested. */
  amountPaid?: number | null;
  currency?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  externalId?: string;
  createdAt?: string;
  deletedAt?: string | null;
}

/**
 * Record a payment that was made outside this system.
 *
 * No natural key, deliberately. A payout is not identified by its affiliate and
 * period — two payouts to one affiliate can cover overlapping windows, and the
 * numbers are an outside system's counter that ours may one day collide with —
 * so a row is matched by the source platform's id or it is a new row. The cost
 * of getting that wrong in the other direction is a duplicated payment record,
 * which reads as money sent twice.
 */
export function upsertPayout(input: PayoutInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id = existingId(db, 'affiliate_payouts', input.externalId, null) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_payouts (id, affiliate_id, program_id, number, status, amount,
                                    amount_paid, currency, period_start, period_end, paid_at,
                                    payment_method, notes, external_id, created_at, updated_at,
                                    deleted_at)
     VALUES (@id, @affiliateId, @programId, @number, @status, @amount, @amountPaid, @currency,
             @periodStart, @periodEnd, @paidAt, @paymentMethod, @notes, @externalId,
             @createdAt, @now, @deletedAt)
     ON CONFLICT(id) DO UPDATE SET
       affiliate_id   = excluded.affiliate_id,
       program_id     = excluded.program_id,
       number         = excluded.number,
       status         = excluded.status,
       amount         = excluded.amount,
       amount_paid    = excluded.amount_paid,
       currency       = excluded.currency,
       period_start   = excluded.period_start,
       period_end     = excluded.period_end,
       paid_at        = excluded.paid_at,
       payment_method = excluded.payment_method,
       notes          = excluded.notes,
       updated_at     = excluded.updated_at,
       deleted_at     = excluded.deleted_at`,
  ).run({
    id,
    affiliateId: input.affiliateId,
    programId: input.programId || null,
    number: input.number ?? '',
    status: input.status,
    amount: input.amount,
    amountPaid: input.amountPaid ?? null,
    currency: input.currency ?? 'USD',
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
    paidAt: input.paidAt ?? null,
    paymentMethod: input.paymentMethod ?? null,
    notes: input.notes ?? null,
    externalId: input.externalId ?? '',
    createdAt: input.createdAt ?? now,
    deletedAt: input.deletedAt ?? null,
    now,
  });

  return id;
}

export interface PayoutLinkReport {
  /** Commissions now pointing at a payout row. */
  linked: number;
  /** Newly linked by this pass, as opposed to already linked. */
  newlyLinked: number;
  /**
   * Commissions marked paid that name no payout we hold. Each one is money
   * somebody was sent with no record of the payment it belonged to.
   */
  paidWithoutPayout: number;
  /** Commissions naming a payout id that does not exist here. */
  danglingReferences: number;
}

/**
 * Resolve `payment_reference` into `payout_id`, and count what did not resolve.
 *
 * The reference is the join, because it is what the import already wrote: the
 * column's own comment says "a payout id on import", and honouring that is
 * cheaper and more truthful than threading a second identifier through the
 * import. A reference that names no payout stays exactly where it is — it is
 * still the payer's own record of the payment, and blanking it to tidy up the
 * join would destroy the only evidence that the payment happened.
 *
 * Both failure directions are counted rather than swallowed, because both are
 * findings: a paid commission with no payout means a payment we cannot itemise,
 * and a payout with no commissions means a payment we cannot explain.
 */
export function linkCommissionsToPayouts(db: Db = getDb()): PayoutLinkReport {
  const newlyLinked = db
    .prepare(
      `UPDATE affiliate_commissions
          SET payout_id = (SELECT p.id FROM affiliate_payouts p
                            WHERE p.external_id = affiliate_commissions.payment_reference)
        WHERE payout_id = ''
          AND payment_reference IS NOT NULL AND payment_reference <> ''
          AND EXISTS (SELECT 1 FROM affiliate_payouts p
                       WHERE p.external_id = affiliate_commissions.payment_reference)`,
    )
    .run().changes;

  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN payout_id <> '' THEN 1 ELSE 0 END), 0) AS linked,
         COALESCE(SUM(CASE WHEN paid_at IS NOT NULL AND payout_id = '' THEN 1 ELSE 0 END), 0)
           AS paidWithoutPayout,
         COALESCE(SUM(CASE WHEN payout_id = ''
                            AND payment_reference IS NOT NULL AND payment_reference <> ''
                           THEN 1 ELSE 0 END), 0) AS danglingReferences
       FROM affiliate_commissions`,
    )
    .get() as { linked: number; paidWithoutPayout: number; danglingReferences: number };

  return { ...counts, newlyLinked };
}

/**
 * Record that a commission was paid somewhere else.
 *
 * Payment is out of scope for this system, which is precisely why marking it is
 * in scope: something has to hold the answer to "has this been settled", and the
 * alternative is a spreadsheet nobody joins to the ledger.
 */
export function markCommissionPaid(
  commissionId: string,
  payment: { paidAt: string; amount?: number | null; reference?: string | null; note?: string | null },
  db: Db = getDb(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE affiliate_commissions
            SET paid_at = @paidAt, paid_amount = COALESCE(@amount, amount),
                payment_reference = @reference, payment_note = @note
          WHERE id = @id`,
      )
      .run({
        id: commissionId,
        paidAt: payment.paidAt,
        amount: payment.amount ?? null,
        reference: payment.reference ?? null,
        note: payment.note ?? null,
      }).changes > 0
  );
}

/**
 * Fill in the shop on referrals whose merchant had not synced yet.
 *
 * The import lands referrals against whatever the shop table holds that day, and
 * a first historical sync takes hours — so on any realistic import day some
 * referrals name a merchant we have not met. This is the second half of that
 * bargain, and it is why the domain is stored: run it after a sync and the
 * unresolved rows resolve themselves, with no re-import and no risk of a
 * duplicate claim.
 */
export function resolveAttributionShops(db: Db = getDb()): number {
  return db
    .prepare(
      `UPDATE affiliate_attributions
          SET shop_id = (SELECT s.id FROM shops s
                          WHERE s.myshopify_domain = affiliate_attributions.myshopify_domain)
        WHERE shop_id = ''
          AND myshopify_domain <> ''
          AND EXISTS (SELECT 1 FROM shops s
                       WHERE s.myshopify_domain = affiliate_attributions.myshopify_domain)`,
    )
    .run().changes;
}

export interface MembershipRow {
  id: string;
  affiliateId: string;
  programId: string;
  handle: string;
  status: MembershipStatus;
}

/**
 * Every membership a `?mref=` handle names — plural, and that is the point.
 *
 * A handle is unique per program, not globally: two affiliates in the imported
 * data hold both programs under one code. So resolving a click needs the handle
 * *and* the program, and a lookup that returned one row would silently pick a
 * program for the caller. Matching is case-insensitive, by the column's
 * collation, because the handle arrives from a URL a person may have retyped.
 */
export function membershipsByHandle(handle: string, db: Db = getDb()): MembershipRow[] {
  return db
    .prepare(
      `SELECT id, affiliate_id AS affiliateId, program_id AS programId, handle, status
         FROM affiliate_memberships WHERE handle = ? ORDER BY joined_at`,
    )
    .all(handle) as MembershipRow[];
}

/* ------------------------------------------------ attribution claims (new) */

export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface AttributionClaimInput {
  affiliateId: string;
  programId: string;
  /** Blank when the shop has not been synced yet; the domain recovers it. */
  shopId?: string;
  myshopifyDomain: string;
  /** The merchant as the claimant named them, not as the installation is. */
  customerName?: string;
  /** When the affiliate says the referral happened. */
  claimedAt: string;
  notes?: string | null;
  status: ClaimStatus;
  decidedAt?: string | null;
  decidedBy?: string;
  decisionNotes?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  attributionId?: string | null;
  externalId?: string;
  externalInstallationId?: string;
  decidedByExternalId?: string;
  createdAt?: string;
  deletedAt?: string | null;
}

/**
 * Mantle had no status column: it had `approvedAt` and `rejectedAt`, both
 * nullable, and a row was whatever the pair implied. Rejection wins, because a
 * claim that was approved and then rejected is rejected — the reverse reading
 * would resurrect a decision somebody reversed.
 *
 * Stated as a function rather than inlined at the one call site because it is
 * the single rule the whole import turns on, and it is the thing a test can
 * point at.
 */
export function claimStatus(timestamps: {
  approvedAt?: string | null;
  rejectedAt?: string | null;
}): ClaimStatus {
  if (timestamps.rejectedAt) return 'rejected';
  if (timestamps.approvedAt) return 'approved';
  return 'pending';
}

/**
 * Record an attribution claim.
 *
 * Matched on the source platform's id alone. There is deliberately no natural
 * key: one affiliate may claim the same merchant twice — a first request that
 * was rejected and a second one arguing the point is a real sequence, and
 * collapsing the pair onto (affiliate, program, merchant) would erase the
 * rejection that explains why the second exists.
 *
 * The update list is what a re-import is allowed to change, and `attribution_id`
 * is not on it in the blanking direction: a link established by
 * `linkClaimsToAttributions()` survives a re-import that knows nothing about it.
 */
export function upsertAttributionClaim(input: AttributionClaimInput, db: Db = getDb()): string {
  const now = new Date().toISOString();
  const id = existingId(db, 'affiliate_attribution_claims', input.externalId, null) ?? randomUUID();

  db.prepare(
    `INSERT INTO affiliate_attribution_claims
       (id, affiliate_id, program_id, shop_id, myshopify_domain, customer_name, claimed_at,
        notes, status, decided_at, decided_by, decision_notes, approved_at, rejected_at,
        attribution_id, external_id, external_installation_id, decided_by_external_id,
        created_at, updated_at, deleted_at)
     VALUES (@id, @affiliateId, @programId, @shopId, @domain, @customerName, @claimedAt,
             @notes, @status, @decidedAt, @decidedBy, @decisionNotes, @approvedAt, @rejectedAt,
             @attributionId, @externalId, @externalInstallationId, @decidedByExternalId,
             @createdAt, @now, @deletedAt)
     ON CONFLICT(id) DO UPDATE SET
       affiliate_id     = excluded.affiliate_id,
       program_id       = excluded.program_id,
       -- Blank never overwrites resolved, exactly as on an attribution: a
       -- re-import against a fuller \`shops\` table may resolve a claim's
       -- merchant and must never unresolve one.
       shop_id          = CASE WHEN excluded.shop_id <> '' THEN excluded.shop_id
                               ELSE affiliate_attribution_claims.shop_id END,
       myshopify_domain = excluded.myshopify_domain,
       customer_name    = excluded.customer_name,
       claimed_at       = excluded.claimed_at,
       notes            = excluded.notes,
       status           = excluded.status,
       decided_at       = excluded.decided_at,
       decided_by       = excluded.decided_by,
       decision_notes   = excluded.decision_notes,
       approved_at      = excluded.approved_at,
       rejected_at      = excluded.rejected_at,
       -- A link the import does not know about is kept. The import supplies one
       -- only when it found a corresponding referral; a run that did not is not
       -- evidence that the link is wrong.
       attribution_id   = COALESCE(excluded.attribution_id,
                                   affiliate_attribution_claims.attribution_id),
       updated_at       = excluded.updated_at,
       deleted_at       = excluded.deleted_at`,
  ).run({
    id,
    affiliateId: input.affiliateId,
    programId: input.programId,
    shopId: input.shopId ?? '',
    domain: input.myshopifyDomain,
    customerName: input.customerName ?? '',
    claimedAt: input.claimedAt,
    notes: input.notes ?? null,
    status: input.status,
    decidedAt: input.decidedAt ?? null,
    decidedBy: input.decidedBy ?? '',
    decisionNotes: input.decisionNotes ?? null,
    approvedAt: input.approvedAt ?? null,
    rejectedAt: input.rejectedAt ?? null,
    attributionId: input.attributionId ?? null,
    externalId: input.externalId ?? '',
    externalInstallationId: input.externalInstallationId ?? '',
    decidedByExternalId: input.decidedByExternalId ?? '',
    createdAt: input.createdAt ?? now,
    deletedAt: input.deletedAt ?? null,
    now,
  });

  return id;
}

export interface ClaimLinkReport {
  /** Approved claims now pointing at a referral. */
  linked: number;
  /** Newly linked by this pass, as opposed to already linked. */
  newlyLinked: number;
  /**
   * Approved claims that correspond to no referral in the ledger. A finding, not
   * a failure — see the note below.
   */
  approvedWithoutAttribution: number;
}

/**
 * Point approved claims at the referral they correspond to.
 *
 * The join is (affiliate, program, merchant), which is the strongest evidence
 * available and is still only evidence: Mantle recorded no link between the two
 * records at all, so this is a reconstruction of one, not a copy of one. It is
 * restricted to *approved* claims on purpose. A pending claim whose merchant is
 * already attributed to the same affiliate through some other path is an
 * interesting fact, and linking it would dress that fact up as a decision
 * nobody has made.
 *
 * The unmatched approvals are counted rather than repaired. Each one is an
 * approval whose referral is not in the ledger — unassigned later, or never
 * created — and writing an attribution to close the gap would be this pass
 * deciding that a merchant belongs to somebody, which is the one thing it must
 * not do.
 */
export function linkClaimsToAttributions(db: Db = getDb()): ClaimLinkReport {
  const newlyLinked = db
    .prepare(
      `UPDATE affiliate_attribution_claims
          SET attribution_id = (
                SELECT a.id FROM affiliate_attributions a
                 WHERE a.affiliate_id = affiliate_attribution_claims.affiliate_id
                   AND a.program_id = affiliate_attribution_claims.program_id
                   AND a.myshopify_domain = affiliate_attribution_claims.myshopify_domain
                 -- A merchant re-referred after an unassignment has two rows on
                 -- the same key. The live one is the claim's counterpart; the
                 -- newest of the soft-deleted ones is the fallback, because an
                 -- approval that was later unassigned still corresponds to the
                 -- referral it produced.
                 ORDER BY CASE WHEN a.deleted_at IS NULL THEN 0 ELSE 1 END, a.created_at DESC
                 LIMIT 1)
        WHERE attribution_id IS NULL
          AND status = 'approved'
          AND myshopify_domain <> ''
          AND EXISTS (SELECT 1 FROM affiliate_attributions a
                       WHERE a.affiliate_id = affiliate_attribution_claims.affiliate_id
                         AND a.program_id = affiliate_attribution_claims.program_id
                         AND a.myshopify_domain = affiliate_attribution_claims.myshopify_domain)`,
    )
    .run().changes;

  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN attribution_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS linked,
         COALESCE(SUM(CASE WHEN attribution_id IS NULL THEN 1 ELSE 0 END), 0)
           AS approvedWithoutAttribution
       FROM affiliate_attribution_claims
      WHERE status = 'approved' AND deleted_at IS NULL`,
    )
    .get() as { linked: number; approvedWithoutAttribution: number };

  return { ...counts, newlyLinked };
}

/**
 * Fill in the shop on claims whose merchant had not synced yet.
 *
 * The twin of `resolveAttributionShops()`, and separate from it only because
 * they write different tables. A claim is imported against whatever `shops`
 * holds that day; this is the pass that catches up afterwards.
 */
export function resolveClaimShops(db: Db = getDb()): number {
  return db
    .prepare(
      `UPDATE affiliate_attribution_claims
          SET shop_id = (SELECT s.id FROM shops s
                          WHERE s.myshopify_domain = affiliate_attribution_claims.myshopify_domain)
        WHERE shop_id = ''
          AND myshopify_domain <> ''
          AND EXISTS (SELECT 1 FROM shops s
                       WHERE s.myshopify_domain = affiliate_attribution_claims.myshopify_domain)`,
    )
    .run().changes;
}

import { getDb, type Db } from '../db/index.js';
import {
  lookupMerchants,
  merchantSearchSql,
  merchantSearchTerm,
  type Merchant,
} from '../merchants/index.js';
import { attributionStateKey, normalizeDomain } from './pipeline.js';
import { parseRevenueComponents } from './signup.js';
import { upsertAttribution } from './store.js';

/**
 * The admin side of the affiliate program: reading balances, working the
 * approval queue, and assigning a merchant to an affiliate by hand.
 *
 * These are read models and small mutations, kept out of the router so the
 * queries can be tested without a socket. Two things about them are worth
 * stating up front.
 *
 * **Balances are derived, never stored.** There is no `balance` column and
 * there should not be one: a total that is written down disagrees with its own
 * ledger the first time a recompute changes an amount, and then two numbers
 * exist with no way to tell which is right. Everything below sums
 * `affiliate_commissions` at read time.
 *
 * **Manual attribution is a first-class path, not an escape hatch.** A large
 * minority of the referrals imported out of Mantle were created this way,
 * because GA4 attribution cannot see a merchant who clicked on their phone and
 * installed on a laptop, or one whose browser blocks analytics. The pipeline is expected to
 * miss those; this is how they get fixed, and `source='manual'` is what makes
 * the automated pipeline leave the fix alone afterwards.
 */

export class AffiliateAdminError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AffiliateAdminError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ money */

/**
 * The balance columns, as one SQL fragment used by every read below.
 *
 * Written once because the definitions have to agree everywhere: a list page
 * whose "outstanding" means something different from the reconciliation
 * endpoint's is worse than having only one of them.
 *
 * - **earned** counts every commission that has not been cancelled. A cancelled
 *   row is one the engine withdrew; it is kept for the audit trail and is not
 *   money owed.
 * - **paid** uses `paid_amount` where the payer recorded one and falls back to
 *   the commission amount, which is what an imported payout row carries.
 * - **outstanding** is the difference, and it is allowed to be negative — that
 *   means someone was paid more than the ledger now says they earned, which is
 *   exactly the kind of thing this endpoint exists to surface rather than clamp.
 */
const BALANCE_SQL = `
  COALESCE((SELECT SUM(c.amount) FROM affiliate_commissions c
             WHERE c.affiliate_id = a.id AND c.cancelled_at IS NULL), 0) AS earned,
  COALESCE((SELECT SUM(COALESCE(c.paid_amount, c.amount)) FROM affiliate_commissions c
             WHERE c.affiliate_id = a.id AND c.cancelled_at IS NULL
               AND c.paid_at IS NOT NULL), 0) AS paid`;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------- list */

export type AffiliateSort = 'outstanding' | 'earned' | 'paid' | 'referrals' | 'name' | 'newest';

export interface AffiliateListOptions {
  search?: string;
  sort?: AffiliateSort;
  limit?: number;
  offset?: number;
}

export interface AffiliateSummary {
  id: string;
  name: string;
  email: string;
  status: string;
  payoutHold: boolean;
  createdAt: string;
  /** Every handle they hold, across programs. The code a merchant followed. */
  handles: string[];
  memberships: number;
  pendingMemberships: number;
  referrals: number;
  earned: number;
  paid: number;
  outstanding: number;
}

export interface AffiliateList {
  affiliates: AffiliateSummary[];
  total: number;
  limit: number;
  offset: number;
}

const SORTS: Record<AffiliateSort, string> = {
  outstanding: '(earned - paid) DESC, a.name ASC',
  earned: 'earned DESC, a.name ASC',
  paid: 'paid DESC, a.name ASC',
  referrals: 'referrals DESC, a.name ASC',
  name: 'a.name COLLATE NOCASE ASC',
  newest: 'a.created_at DESC',
};

export function listAffiliates(
  options: AffiliateListOptions = {},
  db: Db = getDb(),
): AffiliateList {
  const search = (options.search ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  // `??` is not a guard here: `sort=constructor` resolves through
  // Object.prototype to a function, which is not nullish, so the fallback
  // never fired and the function's source text reached the ORDER BY.
  const asked = options.sort ?? 'outstanding';
  const order = Object.prototype.hasOwnProperty.call(SORTS, asked)
    ? SORTS[asked]!
    : SORTS.outstanding;

  // Handle is searchable alongside name and email because it is how an
  // affiliate is identified everywhere outside this tool — a support email
  // says "referred by ab12cd34", not a uuid.
  const where = search
    ? `WHERE LOWER(a.name) LIKE @like OR LOWER(a.email) LIKE @like
         OR EXISTS (SELECT 1 FROM affiliate_memberships m
                     WHERE m.affiliate_id = a.id AND LOWER(m.handle) LIKE @like)`
    : '';
  const params = { like: `%${search}%`, limit, offset };

  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.email, a.status, a.payout_hold AS payoutHold, a.created_at AS createdAt,
              (SELECT COUNT(*) FROM affiliate_memberships m WHERE m.affiliate_id = a.id)
                AS memberships,
              (SELECT COUNT(*) FROM affiliate_memberships m
                WHERE m.affiliate_id = a.id AND m.status = 'pending') AS pendingMemberships,
              (SELECT COUNT(*) FROM affiliate_attributions t
                WHERE t.affiliate_id = a.id AND t.deleted_at IS NULL) AS referrals,
              (SELECT GROUP_CONCAT(m.handle) FROM affiliate_memberships m
                WHERE m.affiliate_id = a.id) AS handles,
              ${BALANCE_SQL}
         FROM affiliates a
         ${where}
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`,
    )
    .all(params) as Array<Record<string, unknown>>;

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM affiliates a ${where}`).get(params) as { n: number }
  ).n;

  return {
    affiliates: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      status: String(row.status),
      payoutHold: Number(row.payoutHold) === 1,
      createdAt: String(row.createdAt),
      handles: row.handles ? String(row.handles).split(',') : [],
      memberships: Number(row.memberships),
      pendingMemberships: Number(row.pendingMemberships),
      referrals: Number(row.referrals),
      earned: round(Number(row.earned)),
      paid: round(Number(row.paid)),
      outstanding: round(Number(row.earned) - Number(row.paid)),
    })),
    total,
    limit,
    offset,
  };
}

/* ----------------------------------------------------------------- detail */

export interface AffiliateDetail {
  affiliate: AffiliateSummary & { paypalEmail: string | null; source: string };
  memberships: Array<{
    id: string;
    programId: string;
    programName: string;
    appId: string;
    handle: string;
    status: string;
    joinedAt: string;
    approvedAt: string | null;
    rejectedAt: string | null;
    requiresApproval: boolean;
  }>;
  referrals: Array<{
    id: string;
    programId: string;
    programName: string;
    shopId: string;
    myshopifyDomain: string;
    shopName: string | null;
    /** The merchant, from the shared read model. See `src/merchants`. */
    merchant: Merchant;
    referredAt: string;
    source: string;
    handle: string;
    unassignedAt: string | null;
    commissions: number;
    earned: number;
  }>;
  commissions: Array<{
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
    source: string;
  }>;
}

/** How many commission rows a detail view returns before it stops. */
const COMMISSION_PAGE = 500;

export function getAffiliate(affiliateId: string, db: Db = getDb()): AffiliateDetail | null {
  const row = db
    .prepare(
      `SELECT a.id, a.name, a.email, a.status, a.payout_hold AS payoutHold,
              a.created_at AS createdAt, a.paypal_email AS paypalEmail, a.source,
              (SELECT COUNT(*) FROM affiliate_memberships m WHERE m.affiliate_id = a.id)
                AS memberships,
              (SELECT COUNT(*) FROM affiliate_memberships m
                WHERE m.affiliate_id = a.id AND m.status = 'pending') AS pendingMemberships,
              (SELECT COUNT(*) FROM affiliate_attributions t
                WHERE t.affiliate_id = a.id AND t.deleted_at IS NULL) AS referrals,
              (SELECT GROUP_CONCAT(m.handle) FROM affiliate_memberships m
                WHERE m.affiliate_id = a.id) AS handles,
              ${BALANCE_SQL}
         FROM affiliates a WHERE a.id = ?`,
    )
    .get(affiliateId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const memberships = db
    .prepare(
      `SELECT m.id, m.program_id AS programId, p.name AS programName, p.app_id AS appId,
              m.handle, m.status, m.joined_at AS joinedAt, m.approved_at AS approvedAt,
              m.rejected_at AS rejectedAt, p.require_approval AS requiresApproval
         FROM affiliate_memberships m
         JOIN affiliate_programs p ON p.id = m.program_id
        WHERE m.affiliate_id = ?
        ORDER BY m.joined_at`,
    )
    .all(affiliateId) as Array<Record<string, unknown>>;

  // Soft-deleted referrals are included rather than filtered out. An affiliate
  // asking "why did my earnings drop" is asking about exactly those rows, and a
  // page that cannot show them cannot answer.
  const referrals = db
    .prepare(
      `SELECT t.id, t.program_id AS programId, p.name AS programName, t.shop_id AS shopId,
              t.myshopify_domain AS myshopifyDomain, s.name AS shopName,
              t.referred_at AS referredAt, t.source, t.handle, t.deleted_at AS unassignedAt,
              (SELECT COUNT(*) FROM affiliate_commissions c
                WHERE c.attribution_id = t.id AND c.cancelled_at IS NULL) AS commissions,
              COALESCE((SELECT SUM(c.amount) FROM affiliate_commissions c
                         WHERE c.attribution_id = t.id AND c.cancelled_at IS NULL), 0) AS earned
         FROM affiliate_attributions t
         JOIN affiliate_programs p ON p.id = t.program_id
         LEFT JOIN shops s ON s.id = t.shop_id
        WHERE t.affiliate_id = ?
        ORDER BY t.referred_at DESC`,
    )
    .all(affiliateId) as Array<Record<string, unknown>>;

  // One batched resolution for the whole table rather than a lookup per row.
  const referralMerchants = lookupMerchants(
    referrals.map((t) => ({
      shopId: String(t.shopId ?? ''),
      myshopifyDomain: String(t.myshopifyDomain ?? ''),
    })),
    db,
  );

  const commissions = db
    .prepare(
      `SELECT c.id, c.attribution_id AS attributionId, t.myshopify_domain AS myshopifyDomain,
              c.amount, c.currency, c.basis_amount AS basisAmount, c.earned_at AS earnedAt,
              c.paid_at AS paidAt, c.paid_amount AS paidAmount,
              c.payment_reference AS paymentReference, c.cancelled_at AS cancelledAt, c.source
         FROM affiliate_commissions c
         LEFT JOIN affiliate_attributions t ON t.id = c.attribution_id
        WHERE c.affiliate_id = ?
        ORDER BY c.earned_at DESC
        LIMIT ${COMMISSION_PAGE}`,
    )
    .all(affiliateId) as Array<Record<string, unknown>>;

  return {
    affiliate: {
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      status: String(row.status),
      payoutHold: Number(row.payoutHold) === 1,
      createdAt: String(row.createdAt),
      paypalEmail: (row.paypalEmail as string | null) ?? null,
      source: String(row.source),
      handles: row.handles ? String(row.handles).split(',') : [],
      memberships: Number(row.memberships),
      pendingMemberships: Number(row.pendingMemberships),
      referrals: Number(row.referrals),
      earned: round(Number(row.earned)),
      paid: round(Number(row.paid)),
      outstanding: round(Number(row.earned) - Number(row.paid)),
    },
    memberships: memberships.map((m) => ({
      id: String(m.id),
      programId: String(m.programId),
      programName: String(m.programName ?? ''),
      appId: String(m.appId ?? ''),
      handle: String(m.handle),
      status: String(m.status),
      joinedAt: String(m.joinedAt),
      approvedAt: (m.approvedAt as string | null) ?? null,
      rejectedAt: (m.rejectedAt as string | null) ?? null,
      requiresApproval: Number(m.requiresApproval) === 1,
    })),
    referrals: referrals.map((t, index) => ({
      id: String(t.id),
      programId: String(t.programId),
      programName: String(t.programName ?? ''),
      shopId: String(t.shopId ?? ''),
      myshopifyDomain: String(t.myshopifyDomain ?? ''),
      shopName: (t.shopName as string | null) ?? null,
      merchant: referralMerchants[index]!,
      referredAt: String(t.referredAt),
      source: String(t.source),
      handle: String(t.handle ?? ''),
      unassignedAt: (t.unassignedAt as string | null) ?? null,
      commissions: Number(t.commissions),
      earned: round(Number(t.earned)),
    })),
    commissions: commissions.map((c) => ({
      id: String(c.id),
      attributionId: String(c.attributionId),
      myshopifyDomain: String(c.myshopifyDomain ?? ''),
      amount: Number(c.amount),
      currency: String(c.currency),
      basisAmount: c.basisAmount === null ? null : Number(c.basisAmount),
      earnedAt: String(c.earnedAt),
      paidAt: (c.paidAt as string | null) ?? null,
      paidAmount: c.paidAmount === null ? null : Number(c.paidAmount),
      paymentReference: (c.paymentReference as string | null) ?? null,
      cancelledAt: (c.cancelledAt as string | null) ?? null,
      source: String(c.source),
    })),
  };
}

/* ------------------------------------------------------- approval queue */

export interface MembershipDecision {
  id: string;
  affiliateId: string;
  programId: string;
  handle: string;
  status: 'enrolled' | 'rejected';
  approvedAt: string | null;
  rejectedAt: string | null;
}

/**
 * Approve or reject an application.
 *
 * A program that requires approval accumulates applicants waiting and others
 * already turned down, so both halves of this are live paths rather than a form
 * of the same one. A rejection is recorded rather than deleted: without the row the same
 * applicant reappears as new next week and the decision has to be made again
 * from nothing.
 *
 * Approving does one thing beyond the row itself — it clears the app's GA4
 * attribution watermark. Until approval this affiliate's handle was not in the
 * list the pipeline queries with, so any click they sent is a click no run has
 * ever looked for. Rewinding the watermark makes the next sync re-derive that
 * window and pick them up, which is the difference between "approved" and
 * "approved and actually credited". The re-read costs a fraction of a gigabyte
 * against a free tier, and nothing is duplicated: `persistAttribution` is an
 * upsert on the merchant.
 */
export function decideMembership(
  membershipId: string,
  decision: 'approve' | 'reject',
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): MembershipDecision {
  const row = db
    .prepare(
      `SELECT m.id, m.affiliate_id AS affiliateId, m.program_id AS programId, m.handle, m.status,
              p.app_id AS appId
         FROM affiliate_memberships m
         JOIN affiliate_programs p ON p.id = m.program_id
        WHERE m.id = ?`,
    )
    .get(membershipId) as
    | { id: string; affiliateId: string; programId: string; handle: string; status: string; appId: string }
    | undefined;
  if (!row) throw new AffiliateAdminError(`No membership with id ${membershipId}.`, 404);

  const status = decision === 'approve' ? 'enrolled' : 'rejected';

  db.transaction(() => {
    db.prepare(
      `UPDATE affiliate_memberships
          SET status = @status,
              approved_at = CASE WHEN @status = 'enrolled' THEN @now ELSE approved_at END,
              rejected_at = CASE WHEN @status = 'rejected' THEN @now ELSE rejected_at END,
              updated_at = @now
        WHERE id = @id`,
    ).run({ id: membershipId, status, now });

    if (status === 'enrolled' && row.appId) {
      db.prepare('DELETE FROM sync_state WHERE key = ?').run(attributionStateKey(row.appId));
    }
  })();

  const after = db
    .prepare(
      `SELECT status, approved_at AS approvedAt, rejected_at AS rejectedAt
         FROM affiliate_memberships WHERE id = ?`,
    )
    .get(membershipId) as { status: string; approvedAt: string | null; rejectedAt: string | null };

  return {
    id: membershipId,
    affiliateId: row.affiliateId,
    programId: row.programId,
    handle: row.handle,
    status: after.status as 'enrolled' | 'rejected',
    approvedAt: after.approvedAt,
    rejectedAt: after.rejectedAt,
  };
}

export interface PendingMembership extends MembershipDecision {
  affiliateName: string;
  affiliateEmail: string;
  programName: string;
  joinedAt: string;
}

/** The approval queue, oldest first — the order it should be worked in. */
export function listPendingMemberships(db: Db = getDb()): PendingMembership[] {
  return db
    .prepare(
      `SELECT m.id, m.affiliate_id AS affiliateId, m.program_id AS programId, m.handle,
              m.status, m.approved_at AS approvedAt, m.rejected_at AS rejectedAt,
              m.joined_at AS joinedAt, a.name AS affiliateName, a.email AS affiliateEmail,
              p.name AS programName
         FROM affiliate_memberships m
         JOIN affiliates a ON a.id = m.affiliate_id
         JOIN affiliate_programs p ON p.id = m.program_id
        WHERE m.status = 'pending'
        ORDER BY m.joined_at`,
    )
    .all() as PendingMembership[];
}

/* ------------------------------------------------- manual attribution */

export interface ManualAttributionInput {
  affiliateId: string;
  programId: string;
  /** Either identifies the merchant; the other is filled in from `shops`. */
  myshopifyDomain?: string;
  shopId?: string;
  /** Defaults to now. Nothing before this instant earns — see the engine. */
  referredAt?: string;
}

export interface ManualAttributionResult {
  id: string;
  affiliateId: string;
  programId: string;
  shopId: string;
  myshopifyDomain: string;
  referredAt: string;
  /** The live claim this one displaced, if any. Soft-deleted, not removed. */
  replaced: { id: string; affiliateId: string; source: string } | null;
}

/**
 * Assign a merchant to an affiliate by hand.
 *
 * The merchant may be named by domain or by shop id, and one is resolved from
 * the other where `shops` knows both. A merchant the sync has never seen is
 * still assignable — the domain is stored, `shop_id` is left blank, and the
 * same `resolveAttributionShops()` pass that drains the import backlog picks it
 * up later. Refusing here would make the tool useless on exactly the merchant a
 * human is most likely to be fixing by hand.
 *
 * Reassignment displaces rather than overwrites: an existing live referral is
 * soft-deleted and a new row is written. That preserves the previous claim as
 * the evidence behind commissions already earned under it — the engine stops
 * paying it from the unassignment instant and does not unwind what came before.
 *
 * Requires a membership in the program, because the referral records the handle
 * that earned it and there is exactly one handle per (affiliate, program). An
 * affiliate who is not in the program has no code a merchant could have
 * followed, and inventing one would put a value in the audit column that never
 * existed.
 */
export function assignAttribution(
  input: ManualAttributionInput,
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): ManualAttributionResult {
  const affiliate = db
    .prepare('SELECT id FROM affiliates WHERE id = ?')
    .get(input.affiliateId) as { id: string } | undefined;
  if (!affiliate) throw new AffiliateAdminError(`No affiliate with id ${input.affiliateId}.`, 404);

  const program = db
    .prepare('SELECT id, app_id AS appId FROM affiliate_programs WHERE id = ?')
    .get(input.programId) as { id: string; appId: string } | undefined;
  if (!program) throw new AffiliateAdminError(`No program with id ${input.programId}.`, 404);

  const membership = db
    .prepare(
      `SELECT handle, status FROM affiliate_memberships
        WHERE affiliate_id = ? AND program_id = ?`,
    )
    .get(input.affiliateId, input.programId) as { handle: string; status: string } | undefined;
  if (!membership) {
    throw new AffiliateAdminError(
      'That affiliate has no membership in that program, so there is no handle to credit. ' +
        'Enrol them first.',
    );
  }

  let domain = normalizeDomain(input.myshopifyDomain);
  let shopId = (input.shopId ?? '').trim();

  if (!domain && shopId) {
    const shop = db
      .prepare('SELECT LOWER(myshopify_domain) AS domain FROM shops WHERE id = ?')
      .get(shopId) as { domain: string | null } | undefined;
    if (!shop?.domain) {
      throw new AffiliateAdminError(`No merchant with shop id ${shopId} and a known domain.`, 404);
    }
    domain = shop.domain;
  } else if (domain && !shopId) {
    const shop = db
      .prepare('SELECT id FROM shops WHERE LOWER(myshopify_domain) = ?')
      .get(domain) as { id: string } | undefined;
    shopId = shop?.id ?? '';
  }

  if (!domain) {
    throw new AffiliateAdminError('Name the merchant with a myshopifyDomain or a shopId.');
  }

  const referredAt = input.referredAt ?? now;

  return db.transaction((): ManualAttributionResult => {
    const live = db
      .prepare(
        `SELECT id, affiliate_id AS affiliateId, source FROM affiliate_attributions
          WHERE program_id = ? AND myshopify_domain = ? AND deleted_at IS NULL`,
      )
      .get(input.programId, domain) as
      | { id: string; affiliateId: string; source: string }
      | undefined;

    if (live && live.affiliateId === input.affiliateId) {
      // Already theirs. Promote the row to a manual one so the GA4 pipeline
      // stops treating it as its own to revise, and leave everything else —
      // including the referral date the commissions were computed from — alone.
      db.prepare(
        `UPDATE affiliate_attributions
            SET source = 'manual', shop_id = CASE WHEN ? <> '' THEN ? ELSE shop_id END
          WHERE id = ?`,
      ).run(shopId, shopId, live.id);
      return {
        id: live.id,
        affiliateId: input.affiliateId,
        programId: input.programId,
        shopId,
        myshopifyDomain: domain,
        referredAt,
        replaced: null,
      };
    }

    if (live) {
      db.prepare('UPDATE affiliate_attributions SET deleted_at = ? WHERE id = ?').run(now, live.id);
    }

    const id = upsertAttribution(
      {
        affiliateId: input.affiliateId,
        programId: input.programId,
        shopId,
        myshopifyDomain: domain,
        appId: program.appId,
        referredAt,
        source: 'manual',
        handle: membership.handle,
        createdAt: now,
      },
      db,
    );

    return {
      id,
      affiliateId: input.affiliateId,
      programId: input.programId,
      shopId,
      myshopifyDomain: domain,
      referredAt,
      replaced: live ? { id: live.id, affiliateId: live.affiliateId, source: live.source } : null,
    };
  })();
}

/**
 * Unassign a referral.
 *
 * Soft, always. The commissions it already earned hang off this row, and the
 * engine reads `deleted_at` as the instant the referral stopped being this
 * affiliate's — it stops future earning and leaves the past alone. Deleting the
 * row would orphan real money instead.
 */
export function unassignAttribution(
  attributionId: string,
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): { id: string; unassignedAt: string } {
  const row = db
    .prepare('SELECT id, deleted_at AS deletedAt FROM affiliate_attributions WHERE id = ?')
    .get(attributionId) as { id: string; deletedAt: string | null } | undefined;
  if (!row) throw new AffiliateAdminError(`No referral with id ${attributionId}.`, 404);
  if (row.deletedAt) return { id: row.id, unassignedAt: row.deletedAt };

  db.prepare('UPDATE affiliate_attributions SET deleted_at = ? WHERE id = ?').run(
    now,
    attributionId,
  );
  return { id: attributionId, unassignedAt: now };
}

/* --------------------------------------------------------- reconciliation */

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
    /** Affiliates with a non-zero outstanding balance. The payout run's size. */
    owed: number;
    commissions: number;
    earned: number;
    paid: number;
    outstanding: number;
    /** Cancelled rows, excluded from every figure above and counted here. */
    cancelled: number;
    cancelledAmount: number;
    /**
     * Currencies present in the ledger. There is no FX anywhere in this system,
     * so anything but a single entry means the totals add unlike units and the
     * reader needs to know before they pay against them.
     */
    currencies: string[];
  };
  affiliates: ReconciliationRow[];
}

/**
 * What is earned, what is paid, and what is outstanding — per affiliate.
 *
 * The whole point of this system is to be reconcilable: payouts happen outside
 * it, so the only way to know whether the two agree is to be able to state the
 * ledger's own position in one call. Affiliates with nothing at all are left
 * out; affiliates who are square are kept, because "paid in full" is an answer.
 */
export function reconciliation(db: Db = getDb()): Reconciliation {
  const rows = db
    .prepare(
      `SELECT a.id AS affiliateId, a.name, a.email, a.payout_hold AS payoutHold,
              (SELECT COUNT(*) FROM affiliate_commissions c
                WHERE c.affiliate_id = a.id AND c.cancelled_at IS NULL) AS commissions,
              ${BALANCE_SQL}
         FROM affiliates a
        ORDER BY (earned - paid) DESC, a.name ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  const affiliates: ReconciliationRow[] = rows
    .filter((row) => Number(row.commissions) > 0)
    .map((row) => ({
      affiliateId: String(row.affiliateId),
      name: String(row.name),
      email: String(row.email),
      payoutHold: Number(row.payoutHold) === 1,
      commissions: Number(row.commissions),
      earned: round(Number(row.earned)),
      paid: round(Number(row.paid)),
      outstanding: round(Number(row.earned) - Number(row.paid)),
    }));

  const cancelled = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
         FROM affiliate_commissions WHERE cancelled_at IS NOT NULL`,
    )
    .get() as { n: number; amount: number };

  const currencies = (
    db
      .prepare(
        `SELECT DISTINCT currency FROM affiliate_commissions
          WHERE cancelled_at IS NULL ORDER BY currency`,
      )
      .all() as Array<{ currency: string }>
  ).map((row) => row.currency);

  return {
    totals: {
      affiliates: affiliates.length,
      owed: affiliates.filter((row) => row.outstanding > 0).length,
      commissions: affiliates.reduce((sum, row) => sum + row.commissions, 0),
      earned: round(affiliates.reduce((sum, row) => sum + row.earned, 0)),
      paid: round(affiliates.reduce((sum, row) => sum + row.paid, 0)),
      outstanding: round(affiliates.reduce((sum, row) => sum + row.outstanding, 0)),
      cancelled: cancelled.n,
      cancelledAmount: round(cancelled.amount),
      currencies,
    },
    affiliates,
  };
}

/**
 * Programs, for the pickers a manual assignment and the queue need.
 *
 * Three columns were missing from this response while being present in the
 * table, and their absence had already been paid for twice: the portal hardcodes
 * the 30-day unassign window in `web/src/portal/terms.ts` because no endpoint
 * returned it, and `listing_url` was invisible to a settings screen that is
 * meant to edit it. A read model that omits a stored field does not make the
 * field go away — it makes the next reader restate it from memory somewhere
 * else, and then the two disagree.
 */
export function listPrograms(db: Db = getDb()): Array<{
  id: string;
  name: string;
  appId: string;
  commissionRate: number;
  /** e.g. `['subscription']`. Stored as JSON; parsed here so callers get a list. */
  revenueComponents: string[];
  durationMonths: number | null;
  /** Days after an uninstall before the referral is released. Null means never. */
  unassignAfterUninstallDays: number | null;
  /** The App Store page the program's links point at, as stored on the program. */
  listingUrl: string;
  requiresApproval: boolean;
  status: string;
  affiliates: number;
}> {
  return db
    .prepare(
      `SELECT p.id, p.name, p.app_id AS appId, p.commission_rate AS commissionRate,
              p.revenue_components AS revenueComponents,
              p.duration_months AS durationMonths,
              p.unassign_after_uninstall_days AS unassignAfterUninstallDays,
              p.listing_url AS listingUrl, p.status,
              p.require_approval AS requiresApprovalRaw,
              (SELECT COUNT(*) FROM affiliate_memberships m
                WHERE m.program_id = p.id AND m.status = 'enrolled') AS affiliates
         FROM affiliate_programs p ORDER BY p.name`,
    )
    .all()
    .map((row) => {
      const source = row as Record<string, unknown>;
      return {
        id: String(source.id),
        name: String(source.name),
        appId: String(source.appId),
        commissionRate: Number(source.commissionRate),
        revenueComponents: parseRevenueComponents(source.revenueComponents),
        durationMonths:
          source.durationMonths === null ? null : Number(source.durationMonths),
        unassignAfterUninstallDays:
          source.unassignAfterUninstallDays === null
            ? null
            : Number(source.unassignAfterUninstallDays),
        // The program's own column, not `app_listings`. The two differ on
        // purpose — see `listingUrlForProgram`, which decides which one a live
        // referral link follows. This says what the program row holds, which is
        // what a screen editing the program has to show.
        listingUrl: String(source.listingUrl ?? ''),
        requiresApproval: Number(source.requiresApprovalRaw) === 1,
        status: String(source.status),
        affiliates: Number(source.affiliates),
      };
    });
}

/* ------------------------------------------------------- the referral feed */

export interface ReferralListOptions {
  programId?: string;
  affiliateId?: string;
  /** 'ga4' | 'manual' | 'imported'. Anything else is ignored, not an error. */
  source?: string;
  /**
   * Store name or myshopify domain, case-insensitive substring, one box for
   * both. See `merchantSearchSql` for why it is one box and why it is here
   * rather than in the browser.
   */
  search?: string;
  /** 'live' | 'unassigned'. Anything else means both, which is the default. */
  standing?: string;
  /** 1-based. Anything below 1, or unparseable, is page 1. */
  page?: number;
  limit?: number;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface ReferralSummary {
  id: string;
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  programId: string;
  programName: string;
  shopId: string;
  myshopifyDomain: string;
  /** `shops.name` when the merchant has synced; null when they have not. */
  shopName: string | null;
  /**
   * The merchant, from the shared read model: name, domain, whether the app is
   * installed and what they pay. Every one of those may be `unknown`, and the
   * type says so rather than answering zero — see `src/merchants`.
   */
  merchant: Merchant;
  referredAt: string;
  source: string;
  handle: string;
  /** Null while the referral is live; the instant it was unassigned otherwise. */
  unassignedAt: string | null;
  /** 'live' | 'unassigned' — the same fact as `unassignedAt`, as a filterable word. */
  standing: 'live' | 'unassigned';
  commissions: number;
  earned: number;
}

/**
 * The sortable columns, as an allowlist.
 *
 * Same shape and same reasoning as `PAYOUT_SORTS`: the value arrives in a query
 * parameter and ends up in an ORDER BY, which is the one place interpolation
 * cannot be avoided. A name that is not a key here never reaches SQL.
 */
const REFERRAL_SORTS: Record<string, string> = {
  referredAt: 't.referred_at',
  createdAt: 't.created_at',
  earned: 'earned',
  commissions: 'commissions',
  affiliateName: 'a.name COLLATE NOCASE',
  programName: 'programName COLLATE NOCASE',
  shop: 't.myshopify_domain COLLATE NOCASE',
  source: 't.source',
  unassignedAt: 't.deleted_at',
};

/** The three values `affiliate_attributions.source` may hold. */
const REFERRAL_SOURCES = new Set(['ga4', 'manual', 'imported']);

/**
 * Every referral, across every affiliate.
 *
 * Built because the admin UI was assembling this in the browser: hundreds of
 * requests to `/api/affiliates/:id`, one per affiliate, to produce one list. That
 * is slow, but the reason it had to change is the second-order one — a list
 * stitched together client-side has no single definition of what is in it, and
 * the page ended up with the paged-total-versus-real-total discrepancy and no way
 * to explain the difference.
 *
 * **So soft-deleted referrals are included here, and labelled.** The gap is
 * exactly them: the per-affiliate referral *count* on the list endpoint excludes
 * `deleted_at IS NOT NULL`, deliberately — an unassigned referral is not a live
 * claim — while the detail endpoint's rows include them, equally deliberately,
 * because "why did my earnings drop" is a question about precisely those rows.
 * Measured against the real import: the imported referrals split into the live
 * subset and a handful unassigned. Both definitions are right and the UI was
 * comparing them. This endpoint returns both populations with `standing` on
 * every row and a `counts` block that states the split, so a page can show
 * either number and say which one it is showing rather than having them
 * disagree silently.
 */
export function listReferrals(
  options: ReferralListOptions = {},
  db: Db = getDb(),
): {
  referrals: ReferralSummary[];
  /** The split behind `total`, so a page never has to infer it from a subtraction. */
  counts: {
    total: number;
    live: number;
    unassigned: number;
    /** Commission earned across the whole filtered set, not just this page. */
    earned: number;
    /** The source split across the whole filtered set. Only 'ga4' is automated. */
    bySource: Array<{ source: string; n: number }>;
  };
  total: number;
  page: number;
  limit: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
} {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 500);
  const page = Math.max(Math.trunc(options.page ?? 1) || 1, 1);
  const offset = (page - 1) * limit;

  const filters: string[] = ['1 = 1'];
  const params: Record<string, unknown> = {};
  if (options.programId) {
    filters.push('t.program_id = @programId');
    params.programId = options.programId;
  }
  if (options.affiliateId) {
    filters.push('t.affiliate_id = @affiliateId');
    params.affiliateId = options.affiliateId;
  }
  // An unrecognised source is ignored rather than refused. The three values are
  // an internal classification, not something a caller should have to keep in
  // step with; a filter nobody can satisfy would return an empty page that reads
  // as "no referrals" rather than as "bad filter".
  if (options.source && REFERRAL_SOURCES.has(options.source)) {
    filters.push('t.source = @source');
    params.source = options.source;
  }
  // Standing was a browser-side filter over a fully downloaded feed. It has to
  // move here with the paging, or "unassigned only" would filter the fifty rows
  // that happen to be on the current page rather than every row in the table.
  if (options.standing === 'live') filters.push('t.deleted_at IS NULL');
  if (options.standing === 'unassigned') filters.push('t.deleted_at IS NOT NULL');

  const search = merchantSearchTerm(options.search);
  if (search) {
    filters.push(
      merchantSearchSql({ shopIdColumn: 't.shop_id', domainColumn: 't.myshopify_domain' }),
    );
    params.merchantSearch = search;
  }
  const where = filters.join(' AND ');

  const column = REFERRAL_SORTS[options.sort ?? ''] ?? REFERRAL_SORTS.referredAt!;
  const direction = options.sortDirection === 'asc' ? 'ASC' : 'DESC';
  // A stable tie-break on the id, because the import lands hundreds of referrals
  // sharing a timestamp and page 2 would otherwise repeat rows from page 1.
  const order = `${column} ${direction}, t.id ASC`;

  const rows = db
    .prepare(
      `SELECT t.id, t.affiliate_id AS affiliateId, a.name AS affiliateName,
              a.email AS affiliateEmail, t.program_id AS programId,
              COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS programName,
              t.shop_id AS shopId, t.myshopify_domain AS myshopifyDomain,
              s.name AS shopName, t.referred_at AS referredAt, t.source, t.handle,
              t.deleted_at AS unassignedAt,
              CASE WHEN t.deleted_at IS NULL THEN 'live' ELSE 'unassigned' END AS standing,
              (SELECT COUNT(*) FROM affiliate_commissions c
                WHERE c.attribution_id = t.id AND c.cancelled_at IS NULL) AS commissions,
              COALESCE((SELECT SUM(c.amount) FROM affiliate_commissions c
                         WHERE c.attribution_id = t.id AND c.cancelled_at IS NULL), 0) AS earned
         FROM affiliate_attributions t
         JOIN affiliates a ON a.id = t.affiliate_id
         JOIN affiliate_programs p ON p.id = t.program_id
         LEFT JOIN apps app ON app.id = p.app_id
         LEFT JOIN shops s ON s.id = t.shop_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Array<Record<string, unknown>>;

  /*
   * The figures above the table, computed over the whole filtered set rather
   * than over the page.
   *
   * `earned` and `bySource` were previously summed in the browser off a fully
   * downloaded feed. With paging and search on the server, a page-local sum
   * would silently start meaning "earned on these fifty rows" while still
   * being labelled "commission earned" — the exact class of quietly-wrong
   * number this codebase keeps out of read models.
   */
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN t.deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS live,
              COALESCE(SUM(CASE WHEN t.deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS unassigned,
              COALESCE(SUM((SELECT SUM(c.amount) FROM affiliate_commissions c
                             WHERE c.attribution_id = t.id AND c.cancelled_at IS NULL)),
                       0) AS earned
         FROM affiliate_attributions t
         JOIN affiliates a ON a.id = t.affiliate_id
        WHERE ${where}`,
    )
    .get(params) as { total: number; live: number; unassigned: number; earned: number };

  const bySource = db
    .prepare(
      `SELECT t.source AS source, COUNT(*) AS n
         FROM affiliate_attributions t
         JOIN affiliates a ON a.id = t.affiliate_id
        WHERE ${where}
        GROUP BY t.source
        ORDER BY n DESC, t.source ASC`,
    )
    .all(params) as Array<{ source: string; n: number }>;

  // One batched merchant resolution for the page. See `src/merchants`.
  const merchants = lookupMerchants(
    rows.map((row) => ({
      shopId: String(row.shopId ?? ''),
      myshopifyDomain: String(row.myshopifyDomain ?? ''),
    })),
    db,
  );

  return {
    referrals: rows.map((row, index) => ({
      id: String(row.id),
      affiliateId: String(row.affiliateId),
      affiliateName: String(row.affiliateName ?? ''),
      affiliateEmail: String(row.affiliateEmail ?? ''),
      programId: String(row.programId),
      programName: String(row.programName ?? ''),
      shopId: String(row.shopId ?? ''),
      myshopifyDomain: String(row.myshopifyDomain ?? ''),
      shopName: (row.shopName as string | null) ?? null,
      merchant: merchants[index]!,
      referredAt: String(row.referredAt),
      source: String(row.source),
      handle: String(row.handle ?? ''),
      unassignedAt: (row.unassignedAt as string | null) ?? null,
      standing: row.unassignedAt ? 'unassigned' : 'live',
      commissions: Number(row.commissions),
      earned: round(Number(row.earned)),
    })),
    counts: { ...counts, earned: round(Number(counts.earned)), bySource },
    total: counts.total,
    page,
    limit,
    hasNextPage: offset + rows.length < counts.total,
    hasPreviousPage: offset > 0,
  };
}

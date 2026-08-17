import { getDb, type Db } from '../db/index.js';
import { lookupMerchants, type Merchant } from '../merchants/index.js';

/**
 * Reading payouts — the record of payments made outside this system.
 *
 * Two audiences read these rows and they are not entitled to the same columns,
 * so both queries live here side by side where the difference is visible. The
 * admin sees whose payout it is; an affiliate sees only their own and is never
 * told that anybody else's exists. The portal query takes its affiliate id as a
 * bound parameter and has no branch that can omit it — that is the whole
 * scoping guarantee, and it is why there is a separate function rather than an
 * optional filter on the admin one.
 *
 * Nothing here writes. A payout is created by the import; this system does not
 * raise, schedule or send one, and no endpoint below implies otherwise.
 */

/** Page shape shared by both lists, and by the UI reading them. */
export interface Page {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PayoutSummary {
  id: string;
  number: string;
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  programId: string;
  programName: string;
  status: string;
  amount: number;
  /** Null while the payout is only requested — nothing was sent. */
  amountPaid: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  /** How many commissions name this payout. Zero is a real and telling answer. */
  commissionCount: number;
}

export interface PayoutListOptions {
  affiliateId?: string;
  programId?: string;
  status?: string;
  /** 1-based. Anything below 1, or unparseable, is page 1. */
  page?: number;
  limit?: number;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
}

/**
 * The sortable columns, as an allowlist.
 *
 * An allowlist rather than a validated string, because the value arrives in a
 * query parameter and ends up in an ORDER BY clause — the one place in this
 * router where interpolation is unavoidable. A name that is not a key here never
 * reaches SQL.
 */
const PAYOUT_SORTS: Record<string, string> = {
  paidAt: 'p.paid_at',
  number: 'CAST(p.number AS INTEGER)',
  amount: 'p.amount',
  amountPaid: 'COALESCE(p.amount_paid, 0)',
  periodStart: 'p.period_start',
  periodEnd: 'p.period_end',
  status: 'p.status',
  affiliateName: 'a.name COLLATE NOCASE',
  createdAt: 'p.created_at',
};

/**
 * The subset an *affiliate* may sort their own payouts by.
 *
 * Split out because the two queries do not select the same columns and the
 * shared allowlist was quietly a list of columns only one of them has.
 * `sort=affiliateName` maps to `a.name`, which exists in the admin query's
 * `JOIN affiliates a` and nowhere in the portal's — so a query parameter any
 * affiliate can type produced `SQLITE_ERROR: no such column` and a 500 (the
 * review measured it). Availability only, never injection: the interpolated
 * text is always one of these literals. But a 500 an unauthenticated-adjacent
 * caller can trigger at will is worth removing, and "sort by which affiliate"
 * is meaningless on a list that is one affiliate's own payments anyway.
 */
export const AFFILIATE_PAYOUT_SORTS = [
  'paidAt',
  'number',
  'amount',
  'amountPaid',
  'periodStart',
  'periodEnd',
  'status',
  'createdAt',
] as const;

/** The same list as SQL, so the portal query names only columns it selects. */
const AFFILIATE_PAYOUT_SORT_SQL: Record<string, string> = Object.fromEntries(
  AFFILIATE_PAYOUT_SORTS.map((key) => [key, PAYOUT_SORTS[key]!]),
);

/**
 * Look a sort key up without inheriting one.
 *
 * `SORTS[key] ?? SORTS.default` looks like an allowlist and is not: object
 * property lookup walks the prototype chain, so `sort=constructor` returns
 * `Object.prototype.constructor`, which is not `undefined`, so the `??` never
 * fires and a *function's source text* is interpolated into the ORDER BY. The
 * review measured 500s on both the admin and the portal payout lists from
 * exactly that. `hasOwnProperty.call` is the guard; the same hole exists
 * anywhere else this pattern appears, and each has been given the same guard.
 */
export function ownSort(table: Record<string, string>, key: string | undefined): string | null {
  if (key === undefined) return null;
  return Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as string) : null;
}

/** The name a program is shown under, falling back to its app's. */
const PROGRAM_NAME_SQL = `COALESCE(NULLIF(p2.name, ''), NULLIF(app.name, ''), 'Program')`;

function paging(options: PayoutListOptions): { limit: number; offset: number; page: number } {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
  const page = Math.max(Math.trunc(options.page ?? 1) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
}

function orderBy(options: PayoutListOptions, allowed: Record<string, string> = PAYOUT_SORTS): string {
  const column = ownSort(allowed, options.sort) ?? PAYOUT_SORTS.paidAt!;
  const direction = options.sortDirection === 'asc' ? 'ASC' : 'DESC';
  // A stable tie-break on the id, so page 2 does not repeat a row from page 1
  // when a dozen payouts share a timestamp — which they do, since a batch is
  // marked paid in one go.
  return `${column} ${direction}, p.id ASC`;
}

/**
 * Every payout, for the admin.
 *
 * Soft-deleted rows are excluded here and nowhere reachable: a deleted payout is
 * a payment record somebody withdrew, and showing it in a list of payments made
 * would overstate what was sent.
 */
export function listPayouts(
  options: PayoutListOptions = {},
  db: Db = getDb(),
): { payouts: PayoutSummary[] } & Page {
  const { limit, offset } = paging(options);

  const filters: string[] = ['p.deleted_at IS NULL'];
  const params: Record<string, unknown> = {};
  if (options.affiliateId) {
    filters.push('p.affiliate_id = @affiliateId');
    params.affiliateId = options.affiliateId;
  }
  if (options.programId) {
    filters.push('p.program_id = @programId');
    params.programId = options.programId;
  }
  if (options.status) {
    filters.push('p.status = @status');
    params.status = options.status;
  }
  const where = filters.join(' AND ');

  const rows = db
    .prepare(
      `SELECT p.id, p.number, p.affiliate_id AS affiliateId,
              a.name AS affiliateName, a.email AS affiliateEmail,
              p.program_id AS programId, ${PROGRAM_NAME_SQL} AS programName,
              p.status, p.amount, p.amount_paid AS amountPaid,
              p.period_start AS periodStart, p.period_end AS periodEnd,
              p.paid_at AS paidAt, p.payment_method AS paymentMethod,
              (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.payout_id = p.id)
                AS commissionCount
         FROM affiliate_payouts p
         JOIN affiliates a ON a.id = p.affiliate_id
         LEFT JOIN affiliate_programs p2 ON p2.id = p.program_id
         LEFT JOIN apps app ON app.id = p2.app_id
        WHERE ${where}
        ORDER BY ${orderBy(options)}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as PayoutSummary[];

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM affiliate_payouts p WHERE ${where}`)
    .get(params) as { total: number };

  return {
    payouts: rows,
    total,
    hasNextPage: offset + rows.length < total,
    hasPreviousPage: offset > 0,
  };
}

export interface PayoutCommission {
  id: string;
  amount: number;
  currency: string;
  earnedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  shop: string;
  myshopifyDomain: string;
  /**
   * The merchant behind the commission, from the shared read model.
   *
   * Admin only. `listPayoutsForAffiliate` below returns no merchant at all, and
   * that separation is deliberate — with the commission rate published, a
   * merchant's plan beside a commission amount is that merchant's revenue.
   */
  merchant: Merchant;
}

/**
 * One payout and the commissions it settled.
 *
 * The commissions are those pointing at this payout, not those falling inside
 * its period. The two are usually the same set and the difference is the point:
 * the link is what the payer actually paid for, and the period is a label on the
 * payment. Where they disagree, the itemisation has to follow the money.
 */
export function getPayout(
  payoutId: string,
  db: Db = getDb(),
): { payout: PayoutSummary; commissions: PayoutCommission[] } | null {
  const payout = db
    .prepare(
      `SELECT p.id, p.number, p.affiliate_id AS affiliateId,
              a.name AS affiliateName, a.email AS affiliateEmail,
              p.program_id AS programId, ${PROGRAM_NAME_SQL} AS programName,
              p.status, p.amount, p.amount_paid AS amountPaid,
              p.period_start AS periodStart, p.period_end AS periodEnd,
              p.paid_at AS paidAt, p.payment_method AS paymentMethod, p.notes,
              (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.payout_id = p.id)
                AS commissionCount
         FROM affiliate_payouts p
         JOIN affiliates a ON a.id = p.affiliate_id
         LEFT JOIN affiliate_programs p2 ON p2.id = p.program_id
         LEFT JOIN apps app ON app.id = p2.app_id
        WHERE p.id = ? AND p.deleted_at IS NULL`,
    )
    .get(payoutId) as PayoutSummary | undefined;
  if (!payout) return null;

  const commissions = db
    .prepare(
      `SELECT c.id, c.amount, c.currency, c.earned_at AS earnedAt, c.paid_at AS paidAt,
              c.cancelled_at AS cancelledAt,
              COALESCE(NULLIF(s.name, ''), 'Merchant') AS shop,
              COALESCE(at.myshopify_domain, '') AS myshopifyDomain,
              COALESCE(at.shop_id, '') AS shopId
         FROM affiliate_commissions c
         LEFT JOIN affiliate_attributions at ON at.id = c.attribution_id
         LEFT JOIN shops s ON s.id = at.shop_id
        WHERE c.payout_id = ?
        ORDER BY c.earned_at, c.id`,
    )
    .all(payoutId) as Array<Omit<PayoutCommission, 'merchant'> & { shopId: string }>;

  const merchants = lookupMerchants(
    commissions.map((row) => ({ shopId: row.shopId, myshopifyDomain: row.myshopifyDomain })),
    db,
  );

  return {
    payout,
    commissions: commissions.map(({ shopId: _shopId, ...row }, index) => ({
      ...row,
      merchant: merchants[index]!,
    })),
  };
}

export interface AffiliatePayout {
  id: string;
  number: string;
  programName: string;
  status: string;
  amount: number;
  amountPaid: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
}

/**
 * One affiliate's own payouts, and nothing that names anybody else.
 *
 * `affiliateId` is the first parameter and is not optional, so there is no call
 * site that can forget it. What the affiliate gets back is their own payment
 * history: no other affiliate's rows, no merchant, and no `basis_amount` — the
 * merchant's gross revenue, which never leaves this system to a partner.
 */
export function listPayoutsForAffiliate(
  affiliateId: string,
  options: PayoutListOptions = {},
  db: Db = getDb(),
): { payouts: AffiliatePayout[] } & Page {
  const { limit, offset } = paging(options);

  const rows = db
    .prepare(
      `SELECT p.id, p.number, ${PROGRAM_NAME_SQL} AS programName, p.status,
              p.amount, p.amount_paid AS amountPaid,
              p.period_start AS periodStart, p.period_end AS periodEnd,
              p.paid_at AS paidAt, p.payment_method AS paymentMethod
         FROM affiliate_payouts p
         LEFT JOIN affiliate_programs p2 ON p2.id = p.program_id
         LEFT JOIN apps app ON app.id = p2.app_id
        WHERE p.affiliate_id = @affiliateId AND p.deleted_at IS NULL
        ORDER BY ${orderBy(options, AFFILIATE_PAYOUT_SORT_SQL)}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ affiliateId, limit, offset }) as AffiliatePayout[];

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM affiliate_payouts p
        WHERE p.affiliate_id = ? AND p.deleted_at IS NULL`,
    )
    .get(affiliateId) as { total: number };

  return {
    payouts: rows,
    total,
    hasNextPage: offset + rows.length < total,
    hasPreviousPage: offset > 0,
  };
}

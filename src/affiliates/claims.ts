import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import {
  lookupMerchant,
  lookupMerchants,
  merchantSearchSql,
  merchantSearchTerm,
  type Merchant,
} from '../merchants/index.js';
import { AffiliateAdminError, assignAttribution } from './admin.js';
import { normalizeDomain } from './pipeline.js';
import type { ClaimStatus } from './store.js';

/**
 * Attribution claims: an affiliate asking for a merchant to be credited to them,
 * and an operator deciding.
 *
 * The table this reads is a queue, not a ledger. Nothing in it is money until
 * somebody approves it, and approval does not itself write money either — it
 * calls `assignAttribution`, the same function the manual-assignment endpoint
 * calls, so there is one code path that creates an attribution rather than two
 * that have to be kept agreeing with each other. That matters more than it
 * looks: attribution creation displaces a live claim on the same merchant,
 * records the handle, and refuses an affiliate with no membership, and a second
 * implementation would sooner or later do one of those differently.
 *
 * Rejection creates nothing, by design. It records that a person said no, which
 * is a fact worth keeping — without the row the same claim reappears next month
 * as new and the decision is made again from nothing.
 *
 * Two audiences read these rows. The admin sees every claim and who filed it;
 * an affiliate sees their own and is never told anybody else's exists. That is
 * why `listClaimsForAffiliate` is a separate function taking the affiliate id as
 * its first, non-optional parameter rather than an optional filter on the admin
 * query — the same arrangement, and for the same reason, as the payout reads.
 */

/* -------------------------------------------------------------------- read */

export interface ClaimSummary {
  id: string;
  affiliateId: string;
  affiliateName: string;
  affiliateEmail: string;
  programId: string;
  programName: string;
  shopId: string;
  myshopifyDomain: string;
  /** `shops.name` where the merchant has synced, else what was claimed. */
  merchant: string;
  /**
   * The same merchant through the shared read model — domain, install standing
   * and current plan, each of which may honestly be `unknown`. Admin only: this
   * type is never returned to an affiliate. See `AffiliateClaim` at the foot of
   * this file, and `src/merchants` for what `unknown` means and why it is not
   * rendered as "Free".
   */
  merchantRecord: Merchant;
  claimedAt: string;
  notes: string | null;
  status: ClaimStatus;
  decidedAt: string | null;
  decidedBy: string;
  decisionNotes: string | null;
  /** The referral this claim corresponds to. Null when none does. */
  attributionId: string | null;
  createdAt: string;
  /**
   * Who the claimed merchant is credited to *right now*, if anybody.
   *
   * Not the same question as `attributionId`, which is the referral this claim
   * itself produced. This is the state of the world the operator is deciding
   * against: approving a claim on a merchant already credited elsewhere
   * displaces that credit, and the queue has to say so before the button is
   * pressed rather than after.
   *
   * Null when the merchant is credited to nobody, when the claim names no
   * domain, or when the claim's program differs from the live referral's — a
   * merchant can be credited on one program and unclaimed on another, and those
   * are separate facts.
   */
  attributedAffiliateId: string | null;
  attributedAffiliateName: string | null;
  attributedAt: string | null;
  attributedSource: string | null;
}

export interface ClaimListOptions {
  status?: string;
  affiliateId?: string;
  programId?: string;
  /**
   * Store name or myshopify domain, case-insensitive substring, one box for
   * both — the operator working this queue has one of the two and does not know
   * which. On a claim the search also covers `customer_name`, the name the
   * affiliate typed, because for a merchant who has not synced that is the only
   * name on the screen.
   */
  search?: string;
  /** 1-based. Anything below 1, or unparseable, is page 1. */
  page?: number;
  limit?: number;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
}

/** Page shape, matching the payout lists and the UI that reads them. */
export interface ClaimPage {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * The sortable columns, as an allowlist — the value arrives in a query
 * parameter and ends up in an ORDER BY, which is the one place interpolation is
 * unavoidable. A name that is not a key here never reaches SQL.
 */
const CLAIM_SORTS: Record<string, string> = {
  claimedAt: 'c.claimed_at',
  createdAt: 'c.created_at',
  decidedAt: 'c.decided_at',
  status: 'c.status',
  affiliateName: 'a.name COLLATE NOCASE',
  merchant: 'c.myshopify_domain COLLATE NOCASE',
};

const PROGRAM_NAME_SQL = `COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program')`;

/**
 * How the merchant is named on a claim.
 *
 * `shops.name` once the sync has met them; otherwise the name the affiliate
 * typed when they filed it, which is the only other thing anybody has. Neither
 * is authoritative and the domain travels beside it in the admin response, so
 * the operator can check rather than take this label's word for it.
 */
const MERCHANT_SQL = `COALESCE(NULLIF(s.name, ''), NULLIF(c.customer_name, ''), 'Merchant')`;

/**
 * Who the claimed merchant is currently credited to, as scalar subqueries.
 *
 * Correlated subqueries rather than a `LEFT JOIN`, deliberately. A join on
 * (program, domain) multiplies the claim row once per matching attribution, and
 * while `assignAttribution` keeps at most one *live* referral per pair, nothing
 * in the schema enforces it — a second row arriving from any other path would
 * silently double a claim in the queue and, worse, double `total`. A subquery
 * cannot do that whatever the data does.
 *
 * `c.myshopify_domain <> ''` guards the whole thing: a claim filed under a store
 * name we could not turn into a domain has nothing to match on, and matching the
 * empty string against every unresolved attribution would credit it to whoever
 * happened to be first.
 *
 * This is context, not a verdict. It says who holds the merchant today; it does
 * not say whether the claimant is right, and nothing here ranks, scores or
 * flags. See `listClaims`.
 */
const ATTRIBUTED_SQL = `
  (SELECT att.affiliate_id FROM affiliate_attributions att
    WHERE c.myshopify_domain <> '' AND att.program_id = c.program_id
      AND att.myshopify_domain = c.myshopify_domain AND att.deleted_at IS NULL
    ORDER BY att.referred_at DESC LIMIT 1)`;

function paging(options: ClaimListOptions): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
  const page = Math.max(Math.trunc(options.page ?? 1) || 1, 1);
  return { limit, offset: (page - 1) * limit };
}

function orderBy(options: ClaimListOptions): string {
  const column = CLAIM_SORTS[options.sort ?? ''] ?? CLAIM_SORTS.claimedAt!;
  const direction = options.sortDirection === 'asc' ? 'ASC' : 'DESC';
  // A stable tie-break, because many claims can share a filing day and page 2
  // must not repeat a row from page 1.
  return `${column} ${direction}, c.id ASC`;
}

/**
 * Every claim, for the admin.
 *
 * Default sort is newest first rather than oldest first, unlike the membership
 * queue. The queue is worked front to back; this list is opened to see what has
 * arrived, and with a pending queue that deep the oldest is not the interesting
 * end.
 *
 * Each row carries who the claimed merchant is credited to today
 * (`attributedAffiliateId` and friends). That is the one piece of context a
 * decision cannot be made without, and it is deliberately the *only* thing
 * added: no score, no confidence, no "likely" or "suspicious" column. The
 * pending claims have been left undecided on purpose because the operator
 * wants to judge them, and a heuristic printed beside a row is an opinion that
 * gets read as an answer.
 */
export function listClaims(
  options: ClaimListOptions = {},
  db: Db = getDb(),
): { claims: ClaimSummary[] } & ClaimPage {
  const { limit, offset } = paging(options);

  const filters: string[] = ['c.deleted_at IS NULL'];
  const params: Record<string, unknown> = {};
  if (options.status) {
    filters.push('c.status = @status');
    params.status = options.status;
  }
  if (options.affiliateId) {
    filters.push('c.affiliate_id = @affiliateId');
    params.affiliateId = options.affiliateId;
  }
  if (options.programId) {
    filters.push('c.program_id = @programId');
    params.programId = options.programId;
  }
  const search = merchantSearchTerm(options.search);
  if (search) {
    filters.push(
      merchantSearchSql({
        shopIdColumn: 'c.shop_id',
        domainColumn: 'c.myshopify_domain',
        extraNameColumns: ['c.customer_name'],
      }),
    );
    params.merchantSearch = search;
  }
  const where = filters.join(' AND ');

  const claims = db
    .prepare(
      `SELECT c.id, c.affiliate_id AS affiliateId, a.name AS affiliateName,
              a.email AS affiliateEmail, c.program_id AS programId,
              ${PROGRAM_NAME_SQL} AS programName,
              c.shop_id AS shopId, c.myshopify_domain AS myshopifyDomain,
              ${MERCHANT_SQL} AS merchant,
              c.claimed_at AS claimedAt, c.notes, c.status,
              c.decided_at AS decidedAt, c.decided_by AS decidedBy,
              c.decision_notes AS decisionNotes, c.attribution_id AS attributionId,
              c.created_at AS createdAt,
              ${ATTRIBUTED_SQL} AS attributedAffiliateId,
              (SELECT a2.name FROM affiliates a2
                WHERE a2.id = ${ATTRIBUTED_SQL}) AS attributedAffiliateName,
              (SELECT att.referred_at FROM affiliate_attributions att
                WHERE c.myshopify_domain <> '' AND att.program_id = c.program_id
                  AND att.myshopify_domain = c.myshopify_domain AND att.deleted_at IS NULL
                ORDER BY att.referred_at DESC LIMIT 1) AS attributedAt,
              (SELECT att.source FROM affiliate_attributions att
                WHERE c.myshopify_domain <> '' AND att.program_id = c.program_id
                  AND att.myshopify_domain = c.myshopify_domain AND att.deleted_at IS NULL
                ORDER BY att.referred_at DESC LIMIT 1) AS attributedSource
         FROM affiliate_attribution_claims c
         JOIN affiliates a ON a.id = c.affiliate_id
         LEFT JOIN affiliate_programs p ON p.id = c.program_id
         LEFT JOIN apps app ON app.id = p.app_id
         LEFT JOIN shops s ON s.id = c.shop_id
        WHERE ${where}
        ORDER BY ${orderBy(options)}
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as Array<Omit<ClaimSummary, 'merchantRecord'> & {
    customerName?: string;
  }>;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM affiliate_attribution_claims c WHERE ${where}`)
    .get(params) as { total: number };

  // One batched resolution for the page rather than a lookup per claim.
  const merchants = lookupMerchants(
    claims.map((claim) => ({
      shopId: claim.shopId,
      myshopifyDomain: claim.myshopifyDomain,
      fallbackName: claim.merchant,
    })),
    db,
  );

  return {
    claims: claims.map((claim, index) => ({ ...claim, merchantRecord: merchants[index]! })),
    total,
    hasNextPage: offset + claims.length < total,
    hasPreviousPage: offset > 0,
  };
}

export interface ClaimDetail {
  claim: ClaimSummary & {
    customerName: string;
    externalId: string;
    externalInstallationId: string;
  };
  /**
   * The referral this claim points at, if it points at one. Read fresh rather
   * than trusted from the link: an attribution that has since been unassigned
   * is exactly what the operator needs to see before deciding anything.
   */
  attribution: {
    id: string;
    affiliateId: string;
    myshopifyDomain: string;
    referredAt: string;
    source: string;
    unassignedAt: string | null;
  } | null;
  /**
   * Other live claims on the same merchant, for the same program.
   *
   * Two affiliates claiming one merchant is the case where a decision actually
   * costs something, and it is invisible from a single row. Stated as a fact —
   * who else asked, and when — with no ranking and no suggestion.
   */
  competing: Array<{
    id: string;
    affiliateId: string;
    affiliateName: string;
    status: ClaimStatus;
    claimedAt: string;
  }>;
}

export function getClaim(claimId: string, db: Db = getDb()): ClaimDetail | null {
  const claim = db
    .prepare(
      `SELECT c.id, c.affiliate_id AS affiliateId, a.name AS affiliateName,
              a.email AS affiliateEmail, c.program_id AS programId,
              ${PROGRAM_NAME_SQL} AS programName,
              c.shop_id AS shopId, c.myshopify_domain AS myshopifyDomain,
              ${MERCHANT_SQL} AS merchant,
              c.claimed_at AS claimedAt, c.notes, c.status,
              c.decided_at AS decidedAt, c.decided_by AS decidedBy,
              c.decision_notes AS decisionNotes, c.attribution_id AS attributionId,
              c.created_at AS createdAt, c.customer_name AS customerName,
              c.external_id AS externalId,
              c.external_installation_id AS externalInstallationId
         FROM affiliate_attribution_claims c
         JOIN affiliates a ON a.id = c.affiliate_id
         LEFT JOIN affiliate_programs p ON p.id = c.program_id
         LEFT JOIN apps app ON app.id = p.app_id
         LEFT JOIN shops s ON s.id = c.shop_id
        WHERE c.id = ? AND c.deleted_at IS NULL`,
    )
    .get(claimId) as Omit<ClaimDetail['claim'], 'merchantRecord'> | undefined;
  if (!claim) return null;

  const merchantRecord = lookupMerchant(
    {
      shopId: claim.shopId,
      myshopifyDomain: claim.myshopifyDomain,
      fallbackName: claim.merchant,
    },
    db,
  );

  const attribution = claim.attributionId
    ? ((db
        .prepare(
          `SELECT id, affiliate_id AS affiliateId, myshopify_domain AS myshopifyDomain,
                  referred_at AS referredAt, source, deleted_at AS unassignedAt
             FROM affiliate_attributions WHERE id = ?`,
        )
        .get(claim.attributionId) as ClaimDetail['attribution']) ?? null)
    : null;

  const competing = db
    .prepare(
      `SELECT c.id, c.affiliate_id AS affiliateId, a.name AS affiliateName, c.status,
              c.claimed_at AS claimedAt
         FROM affiliate_attribution_claims c
         JOIN affiliates a ON a.id = c.affiliate_id
        WHERE c.program_id = ? AND c.myshopify_domain = ? AND c.id <> ?
          AND c.deleted_at IS NULL
        ORDER BY c.claimed_at`,
    )
    .all(claim.programId, claim.myshopifyDomain, claim.id) as ClaimDetail['competing'];

  return { claim: { ...claim, merchantRecord }, attribution, competing };
}

/* ---------------------------------------------------------------- decision */

export interface ClaimDecisionInput {
  /**
   * Who decided. Free text and optional, because the dashboard authenticates
   * with one shared password and has no user table to resolve an identity
   * against — recording "the operator" would be inventing one.
   */
  decidedBy?: string;
  notes?: string;
}

export interface ClaimDecisionResult {
  id: string;
  status: 'approved' | 'rejected';
  decidedAt: string;
  decidedBy: string;
  /** The referral an approval created or promoted. Null on a rejection. */
  attributionId: string | null;
  /** The live referral an approval displaced, if any. Soft-deleted, not gone. */
  replaced: { id: string; affiliateId: string; source: string } | null;
}

/**
 * Approve or reject a claim.
 *
 * Approving writes a `source='manual'` attribution through `assignAttribution`,
 * which is the manual-assignment endpoint's own path: the merchant is credited
 * exactly as if an operator had typed the domain in by hand, because that is
 * what an approval is. The referral date is the date the affiliate claimed, not
 * today — a claim filed in June about an install in March is a claim about
 * March, and dating it now would silently discard three months of commission.
 *
 * A claim that has already been decided is refused rather than re-decided.
 * Reversing a decision is a real thing an operator may need to do, but it is
 * unassigning a referral and saying why, not flipping a status behind a verb
 * that reads as a first decision.
 */
export function decideClaim(
  claimId: string,
  decision: 'approve' | 'reject',
  input: ClaimDecisionInput = {},
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): ClaimDecisionResult {
  const claim = db
    .prepare(
      `SELECT id, affiliate_id AS affiliateId, program_id AS programId, shop_id AS shopId,
              myshopify_domain AS myshopifyDomain, claimed_at AS claimedAt, status
         FROM affiliate_attribution_claims WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(claimId) as
    | {
        id: string;
        affiliateId: string;
        programId: string;
        shopId: string;
        myshopifyDomain: string;
        claimedAt: string;
        status: ClaimStatus;
      }
    | undefined;
  if (!claim) throw new AffiliateAdminError(`No claim with id ${claimId}.`, 404);

  if (claim.status !== 'pending') {
    throw new AffiliateAdminError(
      `That claim was already ${claim.status}. Unassign the referral instead of deciding again.`,
    );
  }

  const status = decision === 'approve' ? 'approved' : 'rejected';
  const decidedBy = (input.decidedBy ?? '').trim();
  const notes = input.notes?.trim() ? input.notes.trim() : null;

  return db.transaction((): ClaimDecisionResult => {
    let attributionId: string | null = null;
    let replaced: ClaimDecisionResult['replaced'] = null;

    if (decision === 'approve') {
      const assignment = assignAttribution(
        {
          affiliateId: claim.affiliateId,
          programId: claim.programId,
          myshopifyDomain: claim.myshopifyDomain || undefined,
          shopId: claim.myshopifyDomain ? undefined : claim.shopId || undefined,
          referredAt: claim.claimedAt,
        },
        db,
        now,
      );
      attributionId = assignment.id;
      replaced = assignment.replaced;
    }

    db.prepare(
      `UPDATE affiliate_attribution_claims
          SET status = @status,
              decided_at = @now,
              decided_by = @decidedBy,
              decision_notes = @notes,
              approved_at = CASE WHEN @status = 'approved' THEN @now ELSE approved_at END,
              rejected_at = CASE WHEN @status = 'rejected' THEN @now ELSE rejected_at END,
              attribution_id = COALESCE(@attributionId, attribution_id),
              updated_at = @now
        WHERE id = @id`,
    ).run({ id: claimId, status, now, decidedBy, notes, attributionId });

    return { id: claimId, status, decidedAt: now, decidedBy, attributionId, replaced };
  })();
}

/* --------------------------------------------------------- portal: filing */

/**
 * A refusal an affiliate is allowed to read.
 *
 * Separate from `AffiliateAdminError` because the two have opposite audiences
 * and therefore opposite rules about what a message may contain. An admin error
 * names ids and rows freely — the reader already has the whole database. Every
 * message raised here is going to one of hundreds of external people, so each
 * one is about *the caller's own account or their own input* and never about a
 * merchant. There is deliberately no error in this file that a caller can
 * provoke by naming a merchant, because a distinguishable refusal is exactly the
 * oracle `submitClaim` exists to avoid.
 */
export class ClaimSubmissionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * How much attacker-controlled text this endpoint will hold.
 *
 * Express already caps a body at 64kb, so these are not the defence against a
 * huge request — they are the defence against a *plausible* one. Everything
 * here is written to a durable row an operator reads in a table, and a 60kb
 * "store name" is a row nobody can work and a queue nobody can scroll.
 *
 * 120 for the merchant is comfortably past the longest myshopify domain that
 * can exist (a 60-character store handle plus `.myshopify.com` is 74) and past
 * any real store name. 1,000 for notes is a few paragraphs of explanation,
 * which is what a claim actually needs: "I ran their Shopify setup in March and
 * they installed from my link on my laptop" is one sentence.
 */
const MAX_MERCHANT_LENGTH = 120;
const MAX_NOTES_LENGTH = 1_000;

/**
 * The longest input this will even look at before rejecting it.
 *
 * Trimming to a bound before running any pattern over the string, rather than
 * after: the regexes below are linear, but "the current ones are safe" is not a
 * property that survives editing, and a cheap length gate in front of them is.
 */
const MAX_RAW_LENGTH = 4_000;

/** A hostname, conservatively: labels of letters, digits and inner hyphens. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A bare Shopify store handle — what somebody types when they omit the suffix. */
const STORE_HANDLE = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;

export interface NamedMerchant {
  /** Normalised, or blank when the input was a name rather than a domain. */
  domain: string;
  /** What the affiliate typed, trimmed and bounded. Never blank. */
  name: string;
}

/**
 * Turn whatever the affiliate typed into a domain, a name, or both.
 *
 * The input is a text field on a public-facing form, so it arrives as anything:
 * `https://acme.myshopify.com/admin/orders?x=1`, `ACME.myshopify.com`,
 * `www.acme.com`, a bare `acme`, or `Acme Coffee Roasters` — a shop name the
 * affiliate knows and a domain they do not. All five are legitimate and all five
 * have to be workable by an operator, so none of them is an error.
 *
 * A bare handle is expanded to `<handle>.myshopify.com` because that expansion
 * is exact: Shopify's admin domain is derived from the handle with no ambiguity,
 * so nothing is being guessed. A free-text name is *not* expanded — there is no
 * rule that turns "Acme Coffee Roasters" into a domain, and inventing one would
 * file a claim against a store the affiliate never named.
 *
 * Exported for the tests, which pin the normalisation table directly rather than
 * inferring it from what got written to a row.
 */
export function nameMerchant(raw: unknown): NamedMerchant {
  const typed = typeof raw === 'string' ? raw.slice(0, MAX_RAW_LENGTH).trim() : '';
  if (!typed) {
    throw new ClaimSubmissionError('Name the merchant you are claiming.');
  }
  if (typed.length > MAX_MERCHANT_LENGTH) {
    throw new ClaimSubmissionError(
      `Keep the merchant under ${MAX_MERCHANT_LENGTH} characters — the store's domain or its name.`,
    );
  }

  // `normalizeDomain` is the sync's own function: lowercase, drop the scheme,
  // drop everything from the first slash. Shared rather than reimplemented so a
  // claim's domain is spelled the same way as an attribution's, which is what
  // makes the two joinable at all.
  const domain = normalizeDomain(typed)
    // Things a pasted admin URL carries that `normalizeDomain` leaves behind,
    // because it has never been handed a URL a person typed. A query string or
    // fragment with no slash in front of it survives it; so does a port, and so
    // does the `www.` that a browser's address bar hides and a copy restores.
    .replace(/[?#].*$/, '')
    .replace(/:.*$/, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');

  if (HOSTNAME.test(domain) && domain.length <= MAX_MERCHANT_LENGTH) {
    return { domain, name: typed };
  }
  if (STORE_HANDLE.test(domain)) {
    return { domain: `${domain}.myshopify.com`, name: typed };
  }
  // Neither. Kept as a name with no domain: the operator can still work it, and
  // it is the affiliate's own words rather than our guess at what they meant.
  if (typed.length < 2) {
    throw new ClaimSubmissionError('Name the merchant you are claiming.');
  }
  return { domain: '', name: typed };
}

function boundedNotes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const notes = raw.slice(0, MAX_RAW_LENGTH).trim();
  if (!notes) return null;
  if (notes.length > MAX_NOTES_LENGTH) {
    throw new ClaimSubmissionError(`Keep your note under ${MAX_NOTES_LENGTH} characters.`);
  }
  return notes;
}

export interface ClaimSubmission {
  /** From the session. Never from the request body — see `submitClaim`. */
  affiliateId: string;
  programId: unknown;
  merchant: unknown;
  notes?: unknown;
}

export interface SubmittedClaim {
  id: string;
  status: 'pending';
  programId: string;
  programName: string;
  /** Echoed back as typed. Nothing about the merchant is added to it. */
  merchant: string;
  claimedAt: string;
  notes: string | null;
  /**
   * True when this returned a claim the affiliate had already filed instead of
   * writing a second one. Safe to disclose: it is a fact about their own claims,
   * which they can already list, and it says nothing about the merchant.
   */
  duplicate: boolean;
}

/**
 * File a claim. It is pending, it is inert, and it tells the filer nothing.
 *
 * ## The security property, first, because it shapes everything else
 *
 * **This endpoint must not be usable to find out whether a store is one of our
 * merchants, or who a merchant belongs to.** An affiliate can call it with any
 * domain they like — a competitor's customer list, a scraped set of Shopify
 * stores, the whole `.myshopify.com` namespace — and the answer must be the same
 * every time. Three cases have to be indistinguishable:
 *
 *   1. a merchant we have never heard of,
 *   2. a merchant in `shops` that nobody has been credited with,
 *   3. a merchant already attributed to a *different* affiliate.
 *
 * If case 3 answered differently from case 1, this becomes a lookup service for
 * "which of these stores runs this app, and which partner owns them" —
 * competitive intelligence about the operator's merchants and partners,
 * extractable at one request per store by anybody approved as an affiliate.
 *
 * How that is guaranteed, structurally rather than by care:
 *
 * - **No query in this function asks about attribution.** Not "is this merchant
 *   taken", not "does a claim exist by somebody else". The only cross-affiliate
 *   read that could exist here does not exist. There is no branch to leak
 *   through because there is no fact to branch on.
 * - **`shops` is read once, unconditionally, and the result changes only
 *   `shop_id` on the stored row.** A hit and a miss run the same statement, take
 *   the same path, and produce the same response. `shop_id` is not returned,
 *   not implied by any field that is, and an unresolved one is filled in later
 *   by `resolveClaimShops()` anyway — so the column is a convenience for the
 *   operator, never a signal to the caller.
 * - **The response is a function of the input alone**: the id we minted, the
 *   status (always `pending`), the program's name, and the merchant echoed back
 *   as typed. Nothing in it is derived from anything we know about the merchant.
 * - **Every refusal is about the caller**, not the merchant: bad input, or a
 *   membership they do not hold. `nameMerchant` throws on unparseable text
 *   *before* anything is looked up, so even the error surface is merchant-blind.
 *
 * The one deliberate exception is `duplicate`, and it is one because it is a
 * fact about the caller's own claim list — which `/portal/api/claims` already
 * returns to them in full — and not about the merchant. `false` means "you had
 * not claimed this"; it never means "nobody had".
 *
 * ## What it creates
 *
 * A pending row, and nothing else. No attribution, no commission, no link. Only
 * `decideClaim` creates a referral and it does so through `assignAttribution`,
 * the same path the manual-assignment endpoint uses. That is the second property
 * worth stating: this endpoint cannot move money, and an affiliate who files a
 * thousand claims has moved exactly nothing until a person decides them.
 *
 * ## Who may file
 *
 * Only against a program they are enrolled in. A pending applicant has a handle
 * in the table — the import gave every membership one — and a rejected one keeps
 * theirs, so neither absence-of-handle nor presence-of-row can be relied on;
 * the status is checked explicitly. Approving a claim calls `assignAttribution`,
 * which refuses an affiliate with no membership, so letting a non-member file
 * would only manufacture claims that can never be approved: a queue full of rows
 * an operator has to read and cannot action.
 *
 * ## One consequence worth knowing before it surprises somebody
 *
 * `claimed_at` is set to now, because the form asks for a merchant and a program
 * and nothing else. `decideClaim` dates the attribution it creates at
 * `claimed_at`, so approving a self-filed claim credits the referral from the
 * day it was filed, not from the day the merchant installed. That is the honest
 * reading of the only date we have — an affiliate-supplied "they installed in
 * March" would be an unverified number that directly sets how much commission is
 * owed, which is not a field to accept from the person being paid. If back-dating
 * is ever wanted, it belongs on the operator's side of the decision, where
 * `assignAttribution` already takes a `referredAt`.
 */
export function submitClaim(
  input: ClaimSubmission,
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): SubmittedClaim {
  const programId = typeof input.programId === 'string' ? input.programId.trim() : '';
  if (!programId) {
    throw new ClaimSubmissionError('Choose which program you are claiming under.');
  }

  // Input is validated before any lookup, so an unparseable merchant is refused
  // without this function having touched a single row about a store.
  const merchant = nameMerchant(input.merchant);
  const notes = boundedNotes(input.notes);

  /*
   * The membership, by (affiliate, program). One statement, and note what it is
   * *not*: it is not a lookup of the program followed by a lookup of the
   * membership. A program that does not exist and a program the caller is not in
   * are the same answer here, which keeps this from being a program enumerator
   * as well — a much smaller leak than the merchant one, and free to close.
   */
  const membership = db
    .prepare(
      `SELECT status FROM affiliate_memberships
        WHERE affiliate_id = ? AND program_id = ?`,
    )
    .get(input.affiliateId, programId) as { status: string } | undefined;

  if (!membership) {
    throw new ClaimSubmissionError('You are not in that program.');
  }
  if (membership.status !== 'enrolled') {
    // Said plainly, because it is about their own account and they are entitled
    // to know why. A pending applicant who could file claims would be building a
    // queue against a program they may yet be refused.
    throw new ClaimSubmissionError(
      membership.status === 'pending'
        ? 'Your application to that program is still being reviewed. You can claim merchants once you are approved.'
        : 'You are not enrolled in that program.',
    );
  }

  const program = db
    .prepare(
      `SELECT COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS name
         FROM affiliate_programs p
         LEFT JOIN apps app ON app.id = p.app_id
        WHERE p.id = ?`,
    )
    .get(programId) as { name: string } | undefined;

  return db.transaction((): SubmittedClaim => {
    /*
     * Already filed? Return that one.
     *
     * Scoped to this affiliate's own rows, which is why it is not an oracle: it
     * can only ever tell the caller about a claim the caller made. Matched on
     * the domain when there is one and on the typed name when there is not, so
     * `acme`, `ACME.myshopify.com` and `https://acme.myshopify.com/admin` are
     * one claim rather than three.
     *
     * Any status counts, not just pending, and that is a real trade: re-filing
     * after a rejection returns the rejection instead of opening a fresh claim.
     * The alternative — letting a decided claim be re-filed — makes the queue
     * re-litigable by whoever is most persistent, and the largest single
     * claimant in the imported data filed over a hundred. An affiliate who
     * genuinely has new evidence needs a person, not another row.
     */
    const existing = db
      .prepare(
        `SELECT id, status, claimed_at AS claimedAt, notes, customer_name AS merchant
           FROM affiliate_attribution_claims
          WHERE affiliate_id = @affiliateId AND program_id = @programId
            AND deleted_at IS NULL
            AND CASE WHEN @domain <> '' THEN myshopify_domain = @domain
                     ELSE myshopify_domain = '' AND LOWER(customer_name) = LOWER(@name) END
          ORDER BY claimed_at LIMIT 1`,
      )
      .get({
        affiliateId: input.affiliateId,
        programId,
        domain: merchant.domain,
        name: merchant.name,
      }) as
      | { id: string; status: ClaimStatus; claimedAt: string; notes: string | null; merchant: string }
      | undefined;

    if (existing) {
      return {
        id: existing.id,
        // Always `pending` in the type because that is what filing produces.
        // A re-file against a decided claim reports the claim's real status via
        // the affiliate's own list; this field describes the *action*, and the
        // action created nothing.
        status: 'pending',
        programId,
        programName: program?.name ?? 'Program',
        merchant: existing.merchant || merchant.name,
        claimedAt: existing.claimedAt,
        notes: existing.notes,
        duplicate: true,
      };
    }

    /*
     * The one read about the merchant, and it is deliberately unconditional and
     * deliberately inconsequential: it runs whether or not the store is ours, it
     * cannot fail, and its only effect is which value lands in a column the
     * caller never sees. A blank `shop_id` is the normal state for a claim about
     * a merchant the Partner API sync has not reached — `resolveClaimShops()`
     * fills it in later, exactly as it does for the imported claims.
     */
    const shop = merchant.domain
      ? (db
          .prepare('SELECT id FROM shops WHERE LOWER(myshopify_domain) = ?')
          .get(merchant.domain) as { id: string } | undefined)
      : undefined;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO affiliate_attribution_claims
         (id, affiliate_id, program_id, shop_id, myshopify_domain, customer_name, claimed_at,
          notes, status, decided_at, decided_by, decision_notes, approved_at, rejected_at,
          attribution_id, external_id, external_installation_id, decided_by_external_id,
          created_at, updated_at, deleted_at)
       VALUES (@id, @affiliateId, @programId, @shopId, @domain, @name, @now,
               @notes, 'pending', NULL, '', NULL, NULL, NULL,
               NULL, '', '', '',
               @now, @now, NULL)`,
    ).run({
      id,
      affiliateId: input.affiliateId,
      programId,
      shopId: shop?.id ?? '',
      domain: merchant.domain,
      name: merchant.name,
      now,
      notes,
    });

    return {
      id,
      status: 'pending',
      programId,
      programName: program?.name ?? 'Program',
      merchant: merchant.name,
      claimedAt: now,
      notes,
      duplicate: false,
    };
  })();
}

/* ------------------------------------------------------------------ portal */

export interface AffiliateClaim {
  id: string;
  programName: string;
  /** The merchant, as the affiliate themselves named them when they filed. */
  merchant: string;
  claimedAt: string;
  notes: string | null;
  status: ClaimStatus;
  decidedAt: string | null;
  /**
   * Whether the claim resulted in a referral. Deliberately a boolean and not an
   * id: the affiliate's own referral list is where the referral is shown, and
   * an internal row id on this page is a key to nothing they can use.
   */
  attributed: boolean;
}

/**
 * One affiliate's own claims, and nothing that names anybody else.
 *
 * `affiliateId` is the first parameter and is not optional, so no call site can
 * forget it and there is no branch that omits the predicate. What comes back is
 * what they told us plus what we decided: no other affiliate's claims, no
 * competing claim on the same merchant — which would leak that somebody else
 * asked for that store — no merchant email or domain, and no decision notes,
 * which are an internal record of why rather than an answer owed to the
 * claimant. The merchant is echoed back as the name they typed, so nothing
 * about a store leaves here that they did not themselves send.
 */
export function listClaimsForAffiliate(
  affiliateId: string,
  options: { page?: number; limit?: number } = {},
  db: Db = getDb(),
): { claims: AffiliateClaim[] } & ClaimPage {
  const { limit, offset } = paging(options);

  const claims = db
    .prepare(
      `SELECT c.id, ${PROGRAM_NAME_SQL} AS programName,
              COALESCE(NULLIF(c.customer_name, ''), 'Merchant') AS merchant,
              c.claimed_at AS claimedAt, c.notes, c.status, c.decided_at AS decidedAt,
              CASE WHEN c.attribution_id IS NULL THEN 0 ELSE 1 END AS attributedRaw
         FROM affiliate_attribution_claims c
         LEFT JOIN affiliate_programs p ON p.id = c.program_id
         LEFT JOIN apps app ON app.id = p.app_id
        WHERE c.affiliate_id = @affiliateId AND c.deleted_at IS NULL
        ORDER BY c.claimed_at DESC, c.id ASC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ affiliateId, limit, offset }) as Array<
    Omit<AffiliateClaim, 'attributed'> & { attributedRaw: number }
  >;

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM affiliate_attribution_claims
        WHERE affiliate_id = ? AND deleted_at IS NULL`,
    )
    .get(affiliateId) as { total: number };

  return {
    claims: claims.map(({ attributedRaw, ...claim }) => ({
      ...claim,
      attributed: attributedRaw === 1,
    })),
    total,
    hasNextPage: offset + claims.length < total,
    hasPreviousPage: offset > 0,
  };
}

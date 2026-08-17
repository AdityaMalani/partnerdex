import { getDb, type Db } from '../db/index.js';
import type {
  MantleAttribution,
  MantleCommission,
  MantleExport,
  MantleProgram,
} from './mantle.js';
import { knownListingUrl } from './listings.js';
import {
  claimStatus,
  linkClaimsToAttributions,
  linkCommissionsToPayouts,
  upsertAffiliate,
  upsertAttribution,
  upsertAttributionClaim,
  upsertCommission,
  upsertMembership,
  upsertPayout,
  upsertProgram,
  type ClaimLinkReport,
  type MembershipStatus,
  type PayoutLinkReport,
} from './store.js';

/**
 * The one-way import out of Mantle.
 *
 * Three properties are worth more than everything else this file does:
 *
 * 1. **It is idempotent.** Every write goes through an upsert keyed on Mantle's
 *    own id, so the import can be run today against a half-synced shop table and
 *    again next week against a complete one. That is not a convenience — a first
 *    historical Partner API sync takes hours, and the platform being imported
 *    from shuts down on 2026-08-14. The two clocks do not line up, so the import
 *    has to be safe to repeat.
 *
 * 2. **Nothing is dropped silently.** A referral whose merchant is not in
 *    `shops` is still imported, with the domain kept and the shop left blank,
 *    and it is named in the report. The failure mode being designed against is
 *    an affiliate who is quietly owed nothing because a row went missing between
 *    two systems, which nobody would notice until they asked.
 *
 * 3. **Mantle's ids survive as `external_id`.** Every table here can be joined
 *    back to the export for as long as the export exists, which is what makes
 *    "did we import this correctly" a question with an answer.
 *
 * Commission *amounts* are imported as facts rather than recomputed. The engine
 * that recomputes them is a separate piece of work, and its whole validation
 * gate is a diff against every imported commission row — which requires having
 * them.
 */

export interface ProgramReport {
  externalId: string;
  /** Mantle's name for the app the program belongs to. */
  appName: string;
  /** `apps.id`, or blank when no local app answered to that name. */
  appId: string;
  programId: string;
  commissionRate: number;
  durationMonths: number | null;
}

export interface AttributionMiss {
  externalId: string;
  myshopifyDomain: string;
  shopifyShopId: string;
  appName: string;
  referredAt: string;
  /** Soft-deleted in Mantle. Recovered rows still carry commissions. */
  deleted: boolean;
}

export interface ImportReport {
  affiliates: number;
  memberships: { total: number; byStatus: Record<string, number> };
  programs: ProgramReport[];
  attributions: {
    total: number;
    matched: number;
    unmatched: number;
    live: number;
    deleted: number;
    misses: AttributionMiss[];
  };
  commissions: {
    total: number;
    imported: number;
    /** Rows whose attribution could not be resolved; each one is money. */
    orphaned: string[];
    totalAmount: number;
    paid: number;
    paidAmount: number;
  };
  payouts: {
    total: number;
    imported: number;
    /** Payouts whose affiliate or program is not in this export. Each is money. */
    orphaned: string[];
    byStatus: Record<string, number>;
    /** Sum of `amount_paid` over the payouts marked paid. */
    paidAmount: number;
    /** Sum of `amount` over everything else — raised but not settled. */
    outstandingAmount: number;
    /** How the commissions attached themselves to the payouts. */
    link: PayoutLinkReport;
    /**
     * Payouts whose amount disagrees with the commissions attached to them.
     *
     * Not an import failure — both figures are imported facts and this reports
     * that the source disagreed with itself. A payout that paid more than its
     * commissions add up to is the one worth looking at.
     */
    amountMismatches: PayoutMismatch[];
  };
  claims: {
    total: number;
    imported: number;
    /** Claims whose affiliate or program is not in this export. */
    orphaned: string[];
    /** 'pending' | 'approved' | 'rejected' → count, as imported. */
    byStatus: Record<string, number>;
    /** Claims naming a merchant no local shop answers to yet. */
    unresolvedMerchants: number;
    /** How the approved claims attached themselves to referrals. */
    link: ClaimLinkReport;
  };
}

export interface PayoutMismatch {
  externalId: string;
  number: string;
  /** What the payout says it was for. */
  amount: number;
  /** What the commissions pointing at it add up to. */
  commissionAmount: number;
  commissionCount: number;
}

/** Mantle status strings → ours. Anything unrecognised is treated as pending. */
function membershipStatus(status: string): MembershipStatus {
  if (status === 'enrolled' || status === 'rejected') return status;
  return 'pending';
}

/**
 * Which local app a Mantle program belongs to.
 *
 * Mantle identifies apps by its own UUID, which means nothing here, so the only
 * bridge is the name — matched case-insensitively against both of Mantle's
 * spellings, because it stores "Stoq" as the name and "STOQ" as the display name
 * while the Partner API says "STOQ".
 *
 * An unresolved app is reported, not fatal. The program's rules, its
 * memberships and its referrals are all still worth importing; only the join to
 * local revenue waits, and `--app` exists for setting it by hand.
 */
function resolveAppId(db: Db, program: MantleProgram, overrides: Record<string, string>): string {
  const external = program.appId ?? '';
  if (overrides[external]) return overrides[external];

  const names = [program.app?.displayName, program.app?.name].filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );

  for (const name of names) {
    const row = db
      .prepare('SELECT id FROM apps WHERE LOWER(name) = LOWER(?)')
      .get(name) as { id: string } | undefined;
    if (row) return row.id;
  }
  return '';
}

/**
 * Collect the programs out of wherever they happen to be embedded.
 *
 * Mantle's export has no programs endpoint. Each program arrives repeatedly, as
 * a nested copy inside every membership and every attribution that belongs to
 * it, so the definitive list is whatever those agree on — hundreds of copies of
 * one of two objects.
 */
function collectPrograms(data: MantleExport): Map<string, MantleProgram> {
  const programs = new Map<string, MantleProgram>();
  const remember = (program: MantleProgram | null | undefined): void => {
    if (program?.id && !programs.has(program.id)) programs.set(program.id, program);
  };

  for (const affiliate of data.affiliates) {
    for (const membership of affiliate.memberships ?? []) remember(membership.affiliateProgram);
  }
  for (const attribution of data.attributions) remember(attribution.affiliateProgram);

  return programs;
}

/**
 * What a commission's payout says about it.
 *
 * Two different facts, and separating them is the point. `reference` is the
 * payout that claims this commission and is recorded whenever one exists —
 * including for the single 'requested' payout, whose commissions are part of
 * a payment that was raised and never sent. `paidAt` is set only when that
 * payout actually paid; a requested payout leaves the commission unpaid, because
 * recording it as paid would be this import inventing a payment.
 */
function paymentFor(
  commission: MantleCommission,
  payouts: Map<string, { paidAt?: string | null; status?: string }>,
): { paidAt: string | null; reference: string } | null {
  if (!commission.payoutId) return null;
  const payout = commission.payout ?? payouts.get(commission.payoutId);
  return { paidAt: payout?.paidAt ?? null, reference: commission.payoutId };
}

/** Mantle status strings → ours. Only 'paid' means money moved. */
function payoutStatus(status: string | undefined): 'paid' | 'requested' {
  return status === 'paid' ? 'paid' : 'requested';
}

function attributionDomain(attribution: MantleAttribution): string {
  return attribution.appInstallation?.myshopifyDomain?.trim().toLowerCase() ?? '';
}

export interface ImportOptions {
  db?: Db;
  /** Mantle app UUID → local `apps.id`, for a program whose app cannot be named. */
  appIds?: Record<string, string>;
}

export function importMantleExport(data: MantleExport, options: ImportOptions = {}): ImportReport {
  const db = options.db ?? getDb();
  const overrides = options.appIds ?? {};

  const shopByDomain = new Map<string, string>();
  for (const row of db
    .prepare(`SELECT id, LOWER(myshopify_domain) AS domain FROM shops WHERE myshopify_domain <> ''`)
    .iterate() as Iterable<{ id: string; domain: string }>) {
    shopByDomain.set(row.domain, row.id);
  }

  const payouts = new Map(data.payouts.map((payout) => [payout.id, payout]));

  const report: ImportReport = {
    affiliates: 0,
    memberships: { total: 0, byStatus: {} },
    programs: [],
    attributions: { total: 0, matched: 0, unmatched: 0, live: 0, deleted: 0, misses: [] },
    commissions: { total: 0, imported: 0, orphaned: [], totalAmount: 0, paid: 0, paidAmount: 0 },
    payouts: {
      total: 0,
      imported: 0,
      orphaned: [],
      byStatus: {},
      paidAmount: 0,
      outstandingAmount: 0,
      link: { linked: 0, newlyLinked: 0, paidWithoutPayout: 0, danglingReferences: 0 },
      amountMismatches: [],
    },
    claims: {
      total: 0,
      imported: 0,
      orphaned: [],
      byStatus: {},
      unresolvedMerchants: 0,
      link: { linked: 0, newlyLinked: 0, approvedWithoutAttribution: 0 },
    },
  };

  // Mantle id → our id, for each of the four tables. Built as we go and used by
  // everything downstream, which is also what makes an orphan detectable: a
  // commission whose attribution is not in this map has nothing to hang off.
  const programIds = new Map<string, string>();
  const programAppIds = new Map<string, string>();
  const affiliateIds = new Map<string, string>();
  const attributionIds = new Map<string, string>();

  // One transaction for the whole import. A half-applied affiliate ledger is
  // worse than none: commissions would exist against affiliates who do not.
  const run = db.transaction(() => {
    for (const [externalId, program] of collectPrograms(data)) {
      const appId = resolveAppId(db, program, overrides);
      const rate = (program.rules?.percentCommission ?? 0) / 100;
      const durationMonths = program.rules?.durationMonths ?? null;

      const name = program.app?.displayName || program.app?.name || program.name || '';

      const id = upsertProgram(
        {
          appId,
          name,
          // Stored on the program so a referral link works before the app has
          // synced and `app_listings` has anything to say. Mantle carries no App
          // Store URL of its own — see `knownListingUrl` for why its `slug` is
          // not one — so this is resolved from the app's name.
          listingUrl: knownListingUrl(name),
          commissionRate: rate,
          revenueComponents: program.rules?.revenueComponents ?? ['subscription'],
          durationMonths,
          unassignAfterUninstallDays: program.removeOnUninstallDays ?? null,
          requireApproval: program.requireApprovalToJoin ?? false,
          status: program.deletedAt ? 'closed' : 'active',
          externalId,
        },
        db,
      );

      programIds.set(externalId, id);
      programAppIds.set(externalId, appId);
      report.programs.push({
        externalId,
        appName: name,
        appId,
        programId: id,
        commissionRate: rate,
        durationMonths,
      });
    }

    for (const affiliate of data.affiliates) {
      const id = upsertAffiliate(
        {
          name: affiliate.name ?? '',
          email: affiliate.email ?? '',
          paypalEmail: affiliate.paypalEmail,
          // Mantle soft-deletes affiliates; none of ours are, but a deleted one
          // must not come back as active and start collecting commissions.
          status: affiliate.deletedAt ? 'disabled' : 'active',
          payoutHold: affiliate.payoutHold ?? false,
          source: 'imported',
          externalId: affiliate.id,
          createdAt: affiliate.createdAt,
        },
        db,
      );
      affiliateIds.set(affiliate.id, id);
      report.affiliates += 1;

      for (const membership of affiliate.memberships ?? []) {
        const programId = programIds.get(membership.affiliateProgramId);
        if (!programId) continue;

        const status = membershipStatus(membership.status);
        upsertMembership(
          {
            affiliateId: id,
            programId,
            handle: membership.handle,
            status,
            joinedAt: membership.createdAt,
            approvedAt: membership.approvedAt,
            rejectedAt: membership.rejectedAt,
            externalId: membership.id,
          },
          db,
        );

        report.memberships.total += 1;
        report.memberships.byStatus[status] = (report.memberships.byStatus[status] ?? 0) + 1;
      }
    }

    // Handles by (affiliate, program), so a referral can record the code that
    // earned it. Mantle does not store one on the attribution, and there is
    // exactly one handle per pair, so it is recoverable rather than invented.
    const handles = new Map<string, string>();
    for (const affiliate of data.affiliates) {
      for (const membership of affiliate.memberships ?? []) {
        handles.set(`${affiliate.id} ${membership.affiliateProgramId}`, membership.handle);
      }
    }

    for (const attribution of data.attributions) {
      const programId = programIds.get(attribution.affiliateProgramId);
      const affiliateId = affiliateIds.get(attribution.affiliateId);
      const domain = attributionDomain(attribution);
      report.attributions.total += 1;
      if (attribution.deletedAt) report.attributions.deleted += 1;
      else report.attributions.live += 1;

      if (!programId || !affiliateId) {
        // Neither can happen in the data as exported; if it ever does, the row
        // is named rather than dropped on the floor.
        report.attributions.misses.push({
          externalId: attribution.id,
          myshopifyDomain: domain,
          shopifyShopId: attribution.appInstallation?.platformId ?? '',
          appName: '',
          referredAt: attribution.date,
          deleted: Boolean(attribution.deletedAt),
        });
        report.attributions.unmatched += 1;
        continue;
      }

      const shopId = shopByDomain.get(domain) ?? '';
      if (shopId) report.attributions.matched += 1;
      else {
        report.attributions.unmatched += 1;
        report.attributions.misses.push({
          externalId: attribution.id,
          myshopifyDomain: domain,
          shopifyShopId: attribution.appInstallation?.platformId ?? '',
          appName:
            report.programs.find((p) => p.externalId === attribution.affiliateProgramId)?.appName ??
            '',
          referredAt: attribution.date,
          deleted: Boolean(attribution.deletedAt),
        });
      }

      const id = upsertAttribution(
        {
          affiliateId,
          programId,
          shopId,
          myshopifyDomain: domain,
          appId: programAppIds.get(attribution.affiliateProgramId) ?? '',
          referredAt: attribution.date,
          // 'imported', flatly, for all of them — not 'ga4' for the ones carrying a
          // page view id. Mantle's evidence is kept in `external_page_view_id`,
          // but claiming our GA4 pipeline produced these would make the one
          // measurement that matters — how much of Mantle's attribution our own
          // pipeline reproduces — impossible to take honestly.
          source: 'imported',
          handle: handles.get(`${attribution.affiliateId} ${attribution.affiliateProgramId}`) ?? '',
          externalId: attribution.id,
          externalPageViewId: attribution.appListingPageViewId ?? '',
          createdAt: attribution.createdAt,
          deletedAt: attribution.deletedAt ?? null,
        },
        db,
      );
      attributionIds.set(attribution.id, id);
    }

    for (const commission of data.commissions) {
      report.commissions.total += 1;
      report.commissions.totalAmount += commission.amount;

      const attributionId = commission.affiliateAttributionId
        ? attributionIds.get(commission.affiliateAttributionId)
        : undefined;
      const affiliateId = affiliateIds.get(commission.affiliateId);
      const programId = programIds.get(commission.affiliateProgramId);

      if (!attributionId || !affiliateId || !programId) {
        report.commissions.orphaned.push(commission.id);
        continue;
      }

      const payment = paymentFor(commission, payouts);
      const gross = commission.transaction?.grossAmount ?? null;

      upsertCommission(
        {
          attributionId,
          affiliateId,
          programId,
          // Deliberately blank. Mantle's transaction ids are its own UUIDs and
          // its `sid` is its own sequence; neither is a Partner API id, so
          // there is no local transaction to point at. The engine matches these
          // back by (app, shop, date, gross) when it runs its diff.
          transactionId: '',
          amount: commission.amount,
          currency: commission.transaction?.grossAmountCurrencyCode ?? 'USD',
          basisAmount: gross,
          rate: gross ? commission.amount / gross : null,
          earnedAt: commission.transaction?.date ?? commission.date,
          source: 'imported',
          externalId: commission.id,
          externalTransactionId: commission.transactionId ?? '',
          paidAt: payment?.paidAt ?? null,
          paidAmount: payment?.paidAt ? commission.amount : null,
          paymentReference: payment?.reference ?? null,
          paymentNote: payment?.paidAt ? 'Paid by Mantle before migration' : null,
          cancelledAt: commission.cancelled ? commission.updatedAt ?? commission.date : null,
          cancelReason: commission.cancelReason ?? null,
        },
        db,
      );

      report.commissions.imported += 1;
      if (payment?.paidAt) {
        report.commissions.paid += 1;
        report.commissions.paidAmount += commission.amount;
      }
    }

    /*
     * Payouts last, because they are the only rows here that can be checked
     * against something else in the same run: the commissions they claim to have
     * settled are already written, so the link and the reconciliation below run
     * against the ledger rather than against the export.
     */
    /*
     * Which program each payout belongs to, according to what it paid for.
     *
     * Needed because a handful of the payouts name no program: they are the
     * earliest, raised before Mantle scoped payouts to one. The commissions attached to
     * them do carry a program, so the answer is on the ledger rather than in the
     * payout — and it is only taken when every commission in the payout agrees.
     * A set with two entries in it is a payout that spanned two programs, and
     * picking one of them would be inventing a fact rather than reading one.
     */
    const programsPerPayout = new Map<string, Set<string>>();
    for (const commission of data.commissions) {
      if (!commission.payoutId) continue;
      const programId = programIds.get(commission.affiliateProgramId);
      if (!programId) continue;
      const seen = programsPerPayout.get(commission.payoutId) ?? new Set<string>();
      seen.add(programId);
      programsPerPayout.set(commission.payoutId, seen);
    }

    const payoutIds = new Map<string, string>();
    for (const payout of data.payouts) {
      report.payouts.total += 1;
      const status = payoutStatus(payout.status);
      report.payouts.byStatus[status] = (report.payouts.byStatus[status] ?? 0) + 1;

      const affiliateId = payout.affiliateId ? affiliateIds.get(payout.affiliateId) : undefined;
      if (!affiliateId) {
        // Cannot happen in the export as it stands. If it ever does, the payout
        // is named rather than dropped: a payment with nobody to attach it to is
        // still a payment somebody received.
        report.payouts.orphaned.push(payout.id);
        continue;
      }

      const inferred = programsPerPayout.get(payout.id);
      const programId =
        (payout.affiliateProgramId ? programIds.get(payout.affiliateProgramId) : undefined) ??
        // Only when unanimous. See `programsPerPayout`.
        (inferred?.size === 1 ? [...inferred][0]! : null);

      const amount = payout.amount ?? 0;
      const id = upsertPayout(
        {
          affiliateId,
          programId,
          number: payout.number === null || payout.number === undefined ? '' : String(payout.number),
          status,
          amount,
          // Only a paid payout carries an amount actually sent. Mantle leaves it
          // null on the requested one and so do we, rather than defaulting it to
          // the amount raised and asserting a payment that has not happened.
          amountPaid: status === 'paid' ? payout.amountPaid ?? amount : null,
          periodStart: payout.periodStart ?? null,
          periodEnd: payout.periodEnd ?? null,
          paidAt: payout.paidAt ?? null,
          paymentMethod: payout.paymentMethod ?? null,
          notes: payout.notes ?? null,
          externalId: payout.id,
          createdAt: payout.createdAt,
          deletedAt: payout.deletedAt ?? null,
        },
        db,
      );
      payoutIds.set(payout.id, id);

      report.payouts.imported += 1;
      if (status === 'paid') report.payouts.paidAmount += payout.amountPaid ?? amount;
      else report.payouts.outstandingAmount += amount;
    }

    report.payouts.link = linkCommissionsToPayouts(db);

    // Does each payout agree with what it paid for? Both sides are imported
    // facts, so a disagreement is Mantle's, not ours — but it is exactly the
    // kind of thing that is invisible unless something looks for it, and the
    // person reconciling a statement needs to know before the affiliate asks.
    const totals = db
      .prepare(
        `SELECT p.external_id AS externalId, p.number, p.amount,
                COALESCE(SUM(c.amount), 0) AS commissionAmount,
                COUNT(c.id) AS commissionCount
           FROM affiliate_payouts p
           LEFT JOIN affiliate_commissions c ON c.payout_id = p.id
          WHERE p.external_id <> ''
          GROUP BY p.id`,
      )
      .all() as PayoutMismatch[];
    for (const row of totals) {
      // A cent of tolerance: the amounts are floats on both sides and a payout
      // built by summing dozens of commissions will not land on the same bit
      // pattern.
      if (Math.abs(row.amount - row.commissionAmount) > 0.005) {
        report.payouts.amountMismatches.push({
          ...row,
          amount: Number(row.amount.toFixed(2)),
          commissionAmount: Number(row.commissionAmount.toFixed(2)),
        });
      }
    }

    /*
     * Attribution claims, last, and carried across exactly as they stand.
     *
     * A claim is an affiliate asserting a merchant was theirs, waiting for an
     * operator to rule on it. Hundreds of them exist, and the only rule this
     * import applies is Mantle's own: `rejectedAt` beats `approvedAt` beats neither.
     *
     * The undecided ones import as pending, and pending means pending. No
     * attribution is created for them, nothing they touch reaches the commission
     * engine, and nothing here reads their notes, their volume or who filed them.
     * The operator has deliberately not decided these; an import that inferred a
     * decision would be making that call for them and moving money to do it.
     *
     * Approvals are linked to the referral they correspond to rather than
     * producing a new one — see `linkClaimsToAttributions`, which also counts the
     * approvals that correspond to nothing. That count is a finding about what
     * Mantle held, not a gap for this import to fill.
     */
    for (const request of data.attributionRequests ?? []) {
      report.claims.total += 1;

      const programId = programIds.get(request.affiliateProgramId);
      const affiliateId = affiliateIds.get(request.affiliateId);
      if (!programId || !affiliateId) {
        // Cannot happen in the export as it stands. Named rather than dropped,
        // for the same reason as everything else here: a claim that vanishes
        // between two systems is an argument nobody can reconstruct.
        report.claims.orphaned.push(request.id);
        continue;
      }

      const domain = request.appInstallation?.myshopifyDomain?.trim().toLowerCase() ?? '';
      const shopId = shopByDomain.get(domain) ?? '';
      if (!shopId) report.claims.unresolvedMerchants += 1;

      const status = claimStatus(request);
      report.claims.byStatus[status] = (report.claims.byStatus[status] ?? 0) + 1;

      upsertAttributionClaim(
        {
          affiliateId,
          programId,
          shopId,
          myshopifyDomain: domain,
          customerName: request.customerName ?? '',
          claimedAt: request.date,
          notes: request.notes ?? null,
          status,
          // The decision that stands, which is the rejection where there is one.
          decidedAt: request.rejectedAt ?? request.approvedAt ?? null,
          // Mantle's user, by the name they were shown under. There is no local
          // user table to resolve the id against — see the schema note.
          decidedBy: request.decisionBy?.name || request.decisionBy?.email || '',
          decisionNotes: request.decisionNotes ?? null,
          approvedAt: request.approvedAt ?? null,
          rejectedAt: request.rejectedAt ?? null,
          externalId: request.id,
          externalInstallationId: request.appInstallationId ?? '',
          decidedByExternalId: request.decisionById ?? '',
          createdAt: request.createdAt,
          deletedAt: request.deletedAt ?? null,
        },
        db,
      );
      report.claims.imported += 1;
    }

    report.claims.link = linkClaimsToAttributions(db);
  });

  run();

  report.commissions.totalAmount = Number(report.commissions.totalAmount.toFixed(2));
  report.commissions.paidAmount = Number(report.commissions.paidAmount.toFixed(2));
  report.payouts.paidAmount = Number(report.payouts.paidAmount.toFixed(2));
  report.payouts.outstandingAmount = Number(report.payouts.outstandingAmount.toFixed(2));
  return report;
}

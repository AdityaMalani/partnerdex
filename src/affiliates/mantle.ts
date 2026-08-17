import fs from 'node:fs';
import path from 'node:path';

/**
 * The shapes the Mantle export actually has.
 *
 * Written from the export on disk rather than from any published schema, and
 * deliberately partial: only the fields the import reads are declared, every one
 * of them optional where the data is inconsistent about it. A dead platform's
 * payload is not something to model faithfully — it is something to get the
 * facts out of before 2026-08-14 and never depend on again.
 */

export interface MantleProgram {
  id: string;
  name?: string;
  appId?: string;
  rules?: {
    percentCommission?: number;
    revenueComponents?: string[];
    durationMonths?: number;
  } | null;
  requireApprovalToJoin?: boolean;
  removeOnUninstallDays?: number | null;
  deletedAt?: string | null;
  app?: { id?: string; name?: string; displayName?: string; slug?: string } | null;
}

export interface MantleMembership {
  id: string;
  affiliateId: string;
  affiliateProgramId: string;
  handle: string;
  status: string;
  createdAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  deletedAt?: string | null;
  affiliateProgram?: MantleProgram | null;
}

export interface MantleAffiliate {
  id: string;
  name?: string | null;
  email?: string | null;
  paypalEmail?: string | null;
  payoutHold?: boolean;
  createdAt: string;
  deletedAt?: string | null;
  memberships?: MantleMembership[];
}

export interface MantleAttribution {
  id: string;
  affiliateId: string;
  affiliateProgramId: string;
  date: string;
  createdAt: string;
  deletedAt?: string | null;
  appListingPageViewId?: string | null;
  affiliateProgram?: MantleProgram | null;
  appInstallation?: { myshopifyDomain?: string | null; platformId?: string | null } | null;
}

export interface MantleCommission {
  id: string;
  affiliateId: string;
  affiliateProgramId: string;
  affiliateAttributionId: string | null;
  transactionId: string | null;
  amount: number;
  date: string;
  updatedAt?: string;
  cancelled?: boolean;
  cancelReason?: string | null;
  deletedAt?: string | null;
  payoutId?: string | null;
  payout?: { id: string; paidAt?: string | null; status?: string } | null;
  transaction?: {
    date?: string;
    grossAmount?: number;
    grossAmountCurrencyCode?: string;
  } | null;
}

export interface MantlePayout {
  id: string;
  /** Mantle's human-facing reference, an integer counter starting at 1000. */
  number?: number | string | null;
  affiliateId?: string;
  affiliateProgramId?: string;
  /** 'paid' | 'requested' in the export; anything else is treated as requested. */
  status?: string;
  amount?: number | null;
  amountPaid?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  paymentRequestedAt?: string | null;
  notes?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

/**
 * An affiliate asking for a merchant to be attributed to them.
 *
 * Mantle stored no status on these. It stored two nullable timestamps and let
 * every reader work it out, which is why `claimStatus()` exists on our side:
 * hundreds of records, a pending queue of which carry neither timestamp and are
 * therefore still waiting for somebody to decide them.
 *
 * `appInstallation` is where the merchant actually is — the record's own
 * `customerName` is what the affiliate typed, and the domain is what joins.
 */
export interface MantleAttributionRequest {
  id: string;
  affiliateId: string;
  affiliateProgramId: string;
  appInstallationId?: string | null;
  customerName?: string | null;
  date: string;
  notes?: string | null;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  decisionById?: string | null;
  decisionNotes?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
  decisionBy?: { id?: string; name?: string | null; email?: string | null } | null;
  appInstallation?: { myshopifyDomain?: string | null; platformId?: string | null } | null;
}

export interface MantleExport {
  affiliates: MantleAffiliate[];
  /** Live and soft-deleted referrals, already concatenated. */
  attributions: MantleAttribution[];
  commissions: MantleCommission[];
  payouts: MantlePayout[];
  /**
   * Requests for an attribution, decided and undecided alike.
   *
   * Optional because an export copied before this dataset was extracted has no
   * file to read it from, and because the four lists above are the ledger — an
   * import that cannot see any claims is still a complete import of the money.
   */
  attributionRequests?: MantleAttributionRequest[];
}

function readList<T>(file: string, key: 'items'): T[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const items = parsed[key];
  if (!Array.isArray(items)) throw new Error(`${file} has no "${key}" array.`);
  return items as T[];
}

/**
 * The same, for a file an older export may simply not contain.
 *
 * Attribution requests were pulled after the first extraction pass, so an export
 * directory copied before that has no `attribution-requests.json` in it. A
 * missing file means "this export predates that dataset", not "the import is
 * broken" — the four files above are still the ledger, and refusing to run
 * without a fifth would strand anybody importing from an earlier copy. A file
 * that exists and is malformed still throws.
 */
function readOptionalList<T>(file: string, key: 'items'): T[] {
  return fs.existsSync(file) ? readList<T>(file, key) : [];
}

/**
 * Load the export directory.
 *
 * The recovered attributions are concatenated with the live ones on the way in,
 * because they are not a second kind of thing: they are the referrals Mantle
 * soft deleted, recovered from the commission rows that still pointed at them,
 * and every one of them has commissions hanging off it. Importing only the live
 * subset would leave those commissions with nothing to attach to and quietly drop the
 * earnings they represent.
 */
export function readMantleExport(dir: string): MantleExport {
  const dashboard = path.join(dir, 'dashboard');
  const attributions = [
    ...readList<MantleAttribution>(path.join(dashboard, 'attributions.json'), 'items'),
    ...readList<MantleAttribution>(path.join(dashboard, 'attributions-recovered.json'), 'items'),
  ];

  return {
    affiliates: readList<MantleAffiliate>(path.join(dashboard, 'affiliates.json'), 'items'),
    attributions,
    commissions: readList<MantleCommission>(path.join(dashboard, 'commissions.json'), 'items'),
    payouts: readList<MantlePayout>(path.join(dashboard, 'payouts.json'), 'items'),
    attributionRequests: readOptionalList<MantleAttributionRequest>(
      path.join(dashboard, 'attribution-requests.json'),
      'items',
    ),
  };
}

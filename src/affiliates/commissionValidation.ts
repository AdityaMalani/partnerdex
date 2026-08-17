/**
 * Diffing our commissions against Mantle's ledger.
 *
 * The engine is only trustworthy if it can reproduce two years of payments that
 * were actually made. This module holds the comparison itself — pure, so it can
 * be unit tested — while `scripts/validate-commissions.ts` does the loading.
 *
 * Two decisions are worth stating, because they are what make the result
 * meaningful rather than merely green:
 *
 * 1. Money is compared in cents, not floats. Mantle stored raw products such as
 *    `251.8000000000001`. Demanding exact equality would report arithmetic noise
 *    as disagreement and bury any real difference under it.
 *
 * 2. The diff runs in both directions. Finding that every Mantle payment is
 *    reproduced proves the engine does not under-pay; it says nothing about
 *    over-paying. The extra direction — charges we would commission and Mantle
 *    did not — is where the interesting findings actually turned up.
 */

import type { ComputedCommission } from './commission.js';

/** One row of Mantle's ledger, reduced to what a comparison needs. */
export interface LedgerCommission {
  id: string;
  attributionId: string;
  affiliateId: string;
  programId: string;
  /** ISO-8601 date of the source transaction. */
  occurredAt: string;
  amount: number;
  grossAmount: number;
  currency: string;
}

export interface CommissionDifference {
  kind: 'amount_mismatch' | 'missing_from_ours' | 'extra_in_ours';
  attributionId: string;
  occurredAt: string;
  /** Mantle's figure, or null when we produced a commission it never did. */
  ledgerAmount: number | null;
  /** Ours, or null when we failed to reproduce one of theirs. */
  computedAmount: number | null;
  grossAmount: number;
}

export interface CommissionDiff {
  ledgerRows: number;
  computedRows: number;
  /** Rows present on both sides and agreeing to the cent. */
  agreeing: number;
  agreementRate: number;
  /** Signed, in dollars: ours minus Mantle's, across every difference. */
  netVariance: number;
  /** Unsigned total, so offsetting errors cannot hide each other. */
  absoluteVariance: number;
  differences: CommissionDifference[];
  currencies: string[];
}

/** A cent. Anything smaller is float representation, not a disagreement. */
const CENT = 0.005;

/**
 * A commission is grouped by (attribution, transaction instant), not by any id.
 * The two sides come from different systems: Mantle's transaction uuids mean
 * nothing to the Partner API, whose own ids Mantle never saw. What both agree
 * on is which referral earned it and when the charge happened.
 *
 * That pair is a bucket, not a unique key, and finding out why cost a round of
 * false agreement: a small number of the ledger rows share an instant with
 * another row on the same referral. They are genuine — consecutive Shopify transaction
 * ids on the same subscription, billed in the same second. Treating the pair as
 * unique silently collapsed each pair into one row and reported every bucket
 * as perfect agreement while quietly dropping real payments.
 */
function bucketKey(attributionId: string, occurredAt: string): string {
  return `${attributionId} ${new Date(occurredAt).toISOString()}`;
}

interface Side<T> {
  rows: T[];
}

function bucket<T extends { attributionId: string; occurredAt: string }>(
  rows: T[],
): Map<string, Side<T>> {
  const buckets = new Map<string, Side<T>>();
  for (const row of rows) {
    const id = bucketKey(row.attributionId, row.occurredAt);
    const existing = buckets.get(id);
    if (existing) existing.rows.push(row);
    else buckets.set(id, { rows: [row] });
  }
  return buckets;
}

export function diffAgainstLedger(
  computed: ComputedCommission[],
  ledger: LedgerCommission[],
): CommissionDiff {
  const ours = bucket(computed);
  const theirs = bucket(ledger);

  const differences: CommissionDifference[] = [];
  const currencies = new Set<string>();
  let agreeing = 0;
  let computedRows = 0;
  let ledgerRows = 0;
  let netVariance = 0;
  let absoluteVariance = 0;

  // Within a bucket the rows are paired by ascending amount. Nothing else
  // distinguishes them — two charges in the same second on the same referral
  // are interchangeable — and sorting first means a bucket holding a small charge
  // and a larger one pairs like with like instead of reporting two spurious
  // mismatches.
  const byAmount = <T extends { amount: number }>(a: T, b: T): number => a.amount - b.amount;

  for (const id of new Set([...theirs.keys(), ...ours.keys()])) {
    const ledgerSide = [...(theirs.get(id)?.rows ?? [])].sort(byAmount);
    const ourSide = [...(ours.get(id)?.rows ?? [])].sort(byAmount);
    ledgerRows += ledgerSide.length;
    computedRows += ourSide.length;

    for (let index = 0; index < Math.max(ledgerSide.length, ourSide.length); index += 1) {
      const ledgerRow = ledgerSide[index];
      const ourRow = ourSide[index];
      if (ledgerRow) currencies.add(ledgerRow.currency);
      if (ourRow) currencies.add(ourRow.currency);

      if (ledgerRow && !ourRow) {
        differences.push({
          kind: 'missing_from_ours',
          attributionId: ledgerRow.attributionId,
          occurredAt: ledgerRow.occurredAt,
          ledgerAmount: ledgerRow.amount,
          computedAmount: null,
          grossAmount: ledgerRow.grossAmount,
        });
        netVariance -= ledgerRow.amount;
        absoluteVariance += ledgerRow.amount;
        continue;
      }
      if (ourRow && !ledgerRow) {
        differences.push({
          kind: 'extra_in_ours',
          attributionId: ourRow.attributionId,
          occurredAt: ourRow.occurredAt,
          ledgerAmount: null,
          computedAmount: ourRow.amount,
          grossAmount: ourRow.grossAmount,
        });
        netVariance += ourRow.amount;
        absoluteVariance += ourRow.amount;
        continue;
      }
      if (!ledgerRow || !ourRow) continue;

      const delta = ourRow.amount - ledgerRow.amount;
      if (Math.abs(delta) < CENT) {
        agreeing += 1;
        continue;
      }
      differences.push({
        kind: 'amount_mismatch',
        attributionId: ledgerRow.attributionId,
        occurredAt: ledgerRow.occurredAt,
        ledgerAmount: ledgerRow.amount,
        computedAmount: ourRow.amount,
        grossAmount: ledgerRow.grossAmount,
      });
      netVariance += delta;
      absoluteVariance += Math.abs(delta);
    }
  }

  differences.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return {
    ledgerRows,
    computedRows,
    agreeing,
    agreementRate: ledgerRows === 0 ? 1 : agreeing / ledgerRows,
    netVariance: Math.round(netVariance * 100) / 100,
    absoluteVariance: Math.round(absoluteVariance * 100) / 100,
    differences,
    currencies: [...currencies].sort(),
  };
}

/**
 * Commission validation harness.
 *
 *   npx tsx scripts/validate-commissions.ts [--exports <dir>] [--db <path>] [--json]
 *
 * Prints the two-pass diff described in `src/affiliates/commissionReplay.ts` and
 * exits non-zero if either pass disagrees with Mantle's ledger, so it can be
 * wired into CI once the historical sync is complete. It is a script rather than
 * a CLI subcommand because it depends on the Mantle export directory, which is a
 * one-off migration artefact and has no business in the shipped binary.
 */

import path from 'node:path';
import { replayCommissions } from '../src/affiliates/commissionReplay.js';
import type { CommissionDiff } from '../src/affiliates/commissionValidation.js';

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const exportsDir = flag(
  'exports',
  path.join(process.cwd(), 'data/mantle-exports'),
);
const databasePath = flag('db', path.join(process.cwd(), 'data/partnerdex.db'));

const report = replayCommissions({
  commissionsPath: path.join(exportsDir, 'dashboard/commissions.json'),
  reconciliationPath: path.join(exportsDir, 'normalized/reconciliation.json'),
  recoveredAttributionsPath: path.join(exportsDir, 'dashboard/attributions-recovered.json'),
  databasePath,
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const money = (value: number): string => `$${value.toFixed(2)}`;
  const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

  const summarize = (label: string, diff: CommissionDiff): void => {
    console.log(`\n${label}`);
    console.log(`  ledger rows      ${diff.ledgerRows}`);
    console.log(`  recomputed rows  ${diff.computedRows}`);
    console.log(`  agreeing         ${diff.agreeing}  (${percent(diff.agreementRate)})`);
    console.log(`  net variance     ${money(diff.netVariance)}  (ours minus Mantle's)`);
    console.log(`  absolute varianc ${money(diff.absoluteVariance)}`);
    const kinds = new Map<string, number>();
    for (const difference of diff.differences) {
      kinds.set(difference.kind, (kinds.get(difference.kind) ?? 0) + 1);
    }
    for (const [kind, count] of kinds) console.log(`  ${kind.padEnd(17)}${count}`);
    for (const difference of diff.differences.slice(0, 10)) {
      console.log(
        `    ${difference.occurredAt}  ${difference.kind}  mantle=${difference.ledgerAmount ?? '-'}  ours=${difference.computedAmount ?? '-'}`,
      );
    }
    if (diff.differences.length > 10) {
      console.log(`    ... ${diff.differences.length - 10} more`);
    }
  };

  summarize('FORMULA PASS (Mantle-embedded transactions, no join)', report.formula);

  if (report.partner) {
    summarize(
      `PARTNER PASS (PartnerDex transactions ${report.partnerWindowStart} .. ${report.partnerWindowEnd})`,
      report.partner,
    );
    // Coverage is stated before the agreement rate is believed. The local
    // database is mid-backfill, so an unjoined referral is a gap in the sync
    // rather than a defect in the rule, and the two must not be averaged.
    const covered = report.partnerLedgerRowsInWindow - report.partnerLedgerRowsOutOfCoverage;
    console.log(
      `  referrals joined to a shop : ${report.joinedReferrals} of ${report.joinedReferrals + report.unjoinedReferrals}`,
    );
    console.log(
      `  ledger rows in window      : ${report.partnerLedgerRowsInWindow}, comparable: ${covered}, out of coverage: ${report.partnerLedgerRowsOutOfCoverage}`,
    );
    console.log(
      `  the agreement rate above is over the ${covered} comparable rows, not the whole ledger`,
    );
  } else {
    console.log(`\nPARTNER PASS skipped: ${report.partnerUnavailableReason}`);
  }

  console.log('\nUNINSTALL RULE EVIDENCE (removeOnUninstallDays = 30)');
  console.log(`  referrals whose merchant uninstalled : ${report.uninstall.withUninstall}`);
  console.log(`  ... that earned after the uninstall  : ${report.uninstall.earnedAfterUninstall}`);
  console.log(`  ... that earned past the 30-day mark : ${report.uninstall.earnedBeyondGrace}`);
  console.log(`  longest tail after uninstall (days)  : ${report.uninstall.longestTailDays ?? 'n/a'}`);
  console.log(`  referrals Mantle unassigned          : ${report.uninstall.unassignedReferrals}`);
  console.log(`  ... where the merchant had uninstalled: ${report.uninstall.unassignedAfterUninstall}`);
  console.log(`  ... unassigned 30.0-31.5d afterwards  : ${report.uninstall.unassignedWithinGraceWindow}`);
  console.log(`  unassignment stamps (UTC)            : ${report.uninstall.unassignClockTimes.join(', ')}`);

  console.log('\nDURATION EVIDENCE (24-month cap, anchored at first commission)');
  for (const program of report.duration) {
    console.log(
      `  ${program.programId}  referrals=${program.referrals}  longestSpan=${program.longestSpanMonths}mo  firstCommissionLag median=${program.medianFirstCommissionLagDays}d max=${program.maxFirstCommissionLagDays}d`,
    );
  }

  console.log(`\ncurrencies present: ${report.currencies.join(', ')}`);
  if (report.currencies.length > 1) {
    console.log('  WARNING: more than one currency and no FX conversion anywhere. Totals are unsafe.');
  }
}

const failed =
  report.formula.differences.length > 0 || (report.partner?.differences.length ?? 0) > 0;
process.exit(failed ? 1 : 0);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, type Db } from '../db/index.js';
import { importMantleExport, type ImportReport } from './import.js';
import { readMantleExport } from './mantle.js';

/**
 * Running the Mantle import, and saying what it did.
 *
 * This lives in `src/` rather than in `scripts/` for one blunt reason: the
 * production image is runtime-only. Its final stage copies `dist/`, production
 * `node_modules` and `package.json`, and runs `node dist/cli.js` — there is no
 * `scripts/` directory in it and no `tsx` to execute one with. An import that
 * exists only as a script is an import that cannot be run against the deployed
 * database, which is where the hundreds of affiliates actually have to end up.
 *
 * So the logic is here, `partnerdex import-affiliates` calls it, and the script
 * is a four-line wrapper kept for local use. Two callers, one copy — the other
 * arrangement drifts, and the copy that drifts is the one that writes the
 * ledger.
 *
 * Nothing in here decides anything the import does not already decide. It reads
 * the export, runs the import inside a transaction it may roll back, and formats
 * the result — because on a deployed machine that output is the only feedback
 * there is.
 */

export interface RunImportOptions {
  /** The export root. `~` is expanded; everything else is taken literally. */
  exportsDir: string;
  /** Run the whole import and roll it back. */
  dryRun?: boolean;
  /** Mantle app UUID → local `apps.id`, for a program whose app cannot be named. */
  appIds?: Record<string, string>;
  db?: Db;
  onProgress?: (message: string) => void;
}

export class ImportInputError extends Error {}

/** `~/Documents/x` → `/Users/me/Documents/x`. Absolute paths are untouched. */
export function resolveExportsDir(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new ImportInputError('Pass --exports=<dir>, the Mantle export root.');
  // Only a leading `~`, and only when it starts a path segment. A directory
  // legitimately called `~backup` is not a home directory reference.
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const resolved = path.resolve(expanded);

  // The export root is the directory holding `dashboard/`, which is where every
  // file the import reads lives. Checked before anything is read so a mistyped
  // path fails immediately rather than three files in.
  if (!fs.existsSync(path.join(resolved, 'dashboard'))) {
    throw new ImportInputError(
      `No dashboard/ directory under ${resolved}. Point --exports at the export root ` +
        '(on the deployed machine that is the volume path the export was copied to).',
    );
  }
  return resolved;
}

/**
 * Read the export and write it into the ledger.
 *
 * Idempotent by construction rather than by convention: every write inside
 * `importMantleExport` is an upsert keyed on Mantle's own ids, so an interrupted
 * first run is repaired by running it again. That matters most in production,
 * where the first run may be killed halfway by a deploy or a lost connection.
 *
 * A dry run executes the real code path inside an outer transaction and rolls
 * that back. It cannot simply skip the write: the import is a transaction of its
 * own, and a version of it that did not write would not be the thing being
 * tested.
 */
export function runMantleImport(options: RunImportOptions): {
  report: ImportReport;
  exportsDir: string;
} {
  const exportsDir = resolveExportsDir(options.exportsDir);
  const db = options.db ?? getDb();
  const log = options.onProgress ?? (() => {});

  log(`Reading ${exportsDir}...`);
  const data = readMantleExport(exportsDir);
  log(
    `  ${data.affiliates.length} affiliate(s), ${data.attributions.length} referral(s), ` +
      `${data.commissions.length} commission(s), ${data.payouts.length} payout(s)`,
  );

  if (!options.dryRun) {
    return { report: importMantleExport(data, { db, appIds: options.appIds ?? {} }), exportsDir };
  }

  db.exec('BEGIN');
  try {
    return { report: importMantleExport(data, { db, appIds: options.appIds ?? {} }), exportsDir };
  } finally {
    db.exec('ROLLBACK');
  }
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The import report as text.
 *
 * Returned as lines rather than printed, so the caller decides where it goes —
 * but the content is fixed, and in particular every miss is named every time. A
 * referral that fails to find its merchant is an affiliate who stops being paid,
 * and the only thing worse than a long list here is a short summary that hides
 * one.
 */
export function formatImportReport(report: ImportReport, dryRun: boolean): string {
  const lines: string[] = [];
  const say = (line = ''): void => void lines.push(line);

  say(`\n${dryRun ? 'Would import' : 'Imported'}:\n`);

  say('Programs');
  for (const program of report.programs) {
    const duration =
      program.durationMonths === null ? 'lifetime' : `${program.durationMonths} months`;
    say(
      `  ${(program.appName || '(unnamed)').padEnd(12)} ` +
        `${(program.commissionRate * 100).toFixed(0)}% · ${duration} · ` +
        `app ${program.appId || 'UNRESOLVED — pass --app=<mantleAppId>=<appId>'}`,
    );
  }

  say(`\nAffiliates    ${report.affiliates}`);
  const statuses = Object.entries(report.memberships.byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  say(`Memberships   ${report.memberships.total} (${statuses})`);

  const { attributions: a } = report;
  say(
    `Attributions  ${a.total} (${a.live} live, ${a.deleted} soft-deleted in Mantle)\n` +
      `  matched to a local shop      ${a.matched}\n` +
      `  no local shop yet            ${a.unmatched}`,
  );

  const { commissions: c } = report;
  say(
    `Commissions   ${c.imported} of ${c.total}, worth ${money(c.totalAmount)}\n` +
      `  already paid by Mantle       ${c.paid} (${money(c.paidAmount)})\n` +
      `  outstanding                  ${money(c.totalAmount - c.paidAmount)}`,
  );

  const { payouts: p } = report;
  const payoutStatuses = Object.entries(p.byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  say(
    `Payouts       ${p.imported} of ${p.total}${payoutStatuses ? ` (${payoutStatuses})` : ''}\n` +
      `  paid                         ${money(p.paidAmount)}\n` +
      `  raised, not yet sent         ${money(p.outstandingAmount)}\n` +
      `  commissions linked to one    ${p.link.linked} (${p.link.newlyLinked} this run)\n` +
      `  paid, naming no payout       ${p.link.paidWithoutPayout}\n` +
      `  naming a payout we lack      ${p.link.danglingReferences}`,
  );

  /*
   * Claims, and the two numbers a reader has to be able to see at a glance:
   * how many are still undecided, and how many approvals could not be matched to
   * a referral. The first is work waiting for a person; the second is a
   * disagreement between two of Mantle's own tables that nothing here resolves.
   */
  const { claims: cl } = report;
  if (cl.total > 0) {
    const claimStatuses = ['pending', 'approved', 'rejected']
      .map((status) => `${cl.byStatus[status] ?? 0} ${status}`)
      .join(', ');
    say(
      `Claims        ${cl.imported} of ${cl.total} (${claimStatuses})\n` +
        `  approved, linked to referral ${cl.link.linked} (${cl.link.newlyLinked} this run)\n` +
        `  approved, no referral found  ${cl.link.approvedWithoutAttribution}\n` +
        `  no local shop yet            ${cl.unresolvedMerchants}`,
    );
    // Said out loud every run, because it is the property the operator asked
    // for and the one a future change is most likely to break quietly.
    say(
      `  Pending claims are imported undecided: no attribution, no commission,\n` +
        '  no inference. Decide them in the dashboard.',
    );
  }

  if (cl.orphaned.length > 0) {
    say(`\n${cl.orphaned.length} claim(s) had no importable affiliate or program:`);
    for (const id of cl.orphaned) say(`  ${id}`);
  }

  if (c.orphaned.length > 0) {
    say(`\n${c.orphaned.length} commission(s) had no importable attribution:`);
    for (const id of c.orphaned) say(`  ${id}`);
  }

  if (p.orphaned.length > 0) {
    say(`\n${p.orphaned.length} payout(s) had no importable affiliate or program:`);
    for (const id of p.orphaned) say(`  ${id}`);
  }

  // A payout that disagrees with what it paid for is the one number here nobody
  // can reconcile from the outside, so it is printed with both sides.
  if (p.amountMismatches.length > 0) {
    say(`\nPayouts whose amount disagrees with their commissions (${p.amountMismatches.length}):`);
    for (const miss of p.amountMismatches) {
      say(
        `  #${(miss.number || miss.externalId).padEnd(8)} payout ${money(miss.amount).padEnd(10)} ` +
          `commissions ${money(miss.commissionAmount)} (${miss.commissionCount})`,
      );
    }
  }

  if (a.misses.length > 0) {
    say(`\nReferrals with no matching shop (${a.misses.length}):`);
    for (const miss of a.misses) {
      say(
        `  ${miss.myshopifyDomain.padEnd(42)} shop ${miss.shopifyShopId.padEnd(13)} ` +
          `${miss.appName.padEnd(10)} ${miss.referredAt.slice(0, 10)}` +
          `${miss.deleted ? ' (soft-deleted)' : ''}`,
      );
    }
    say(
      '\nThese are imported with their domain kept and no shop attached. Re-run the\n' +
        'import after the Partner API sync has caught up, or call\n' +
        'resolveAttributionShops() — either fills them in without duplicating a row.',
    );
  }

  if (dryRun) say('\nDry run — nothing was written.');
  return lines.join('\n');
}

/** `--app=<mantle-app-uuid>=<partnerdex-app-id>`, repeatable via commas. */
export function parseAppIds(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split('='))
      .filter((parts): parts is [string, string] => parts.length === 2),
  );
}

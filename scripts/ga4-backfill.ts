/**
 * Historical affiliate attribution over the whole GA4 export.
 *
 *   npx tsx scripts/ga4-backfill.ts \
 *     --project <your-bigquery-project> \
 *     --credentials ./.secrets/google-service-account.json \
 *     [--from 2024-04-21] [--to 2026-08-13] [--exports <dir>] [--db <path>] \
 *     [--out <file.json>] [--reuse <file.json>] [--json]
 *
 * Mantle only ever attributed *forward* from the day its integration was
 * switched on, through a poll that ran every ten minutes and had gaps. We hold
 * the complete export — two years of daily tables per app, 2024-04-21 to
 * 2026-08-12 — and a pipeline that reproduces its rule. This script is the
 * first time one has been run over the other.
 *
 * It **writes nothing but its own output file**. Not to `data/partnerdex.db`,
 * which is mid-backfill and opened read-only here, and not to the affiliate
 * tables. What it produces is evidence for a decision about back-crediting
 * affiliates, and that decision is a human one.
 *
 * A script rather than a CLI subcommand, for the same reason
 * `validate-commissions.ts` is: it depends on the Mantle export directory, a
 * one-off migration artefact with no business in the shipped binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { connect, type Connected } from '../src/bigquery/client.js';
import { BigQueryError, type BigQueryConnection } from '../src/bigquery/connection.js';
import { runAttribution, type Attribution } from '../src/affiliates/ga4Attribution.js';
import { readMantleExport } from '../src/affiliates/mantle.js';
import { importedPrograms } from '../src/affiliates/commissionReplay.js';
import {
  AUTOMATED_LAG_CEILING_DAYS,
  MANUAL_LAG_THRESHOLD_DAYS,
  breakdownByPeriod,
  classifyOrigin,
  cohortBenchmarks,
  compareAttributions,
  mergeAttributionChunks,
  estimateByBenchmark,
  originEvidence,
  shopKey,
  valueAttributions,
  type ClassifiedReferral,
  type MantleReferral,
} from '../src/affiliates/backfillCompare.js';

/* ----------------------------------------------------------------- flags */

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseDate(value: string, label: string): Date {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) throw new BigQueryError(`${label} "${value}" is not a date.`);
  return parsed;
}

const home = process.env.HOME ?? '';
const exportsDir = flag('exports', path.join(process.cwd(), 'data/mantle-exports'));
const databasePath = flag('db', path.join(process.cwd(), 'data/partnerdex.db'));
const outPath = flag('out', path.join(process.cwd(), 'ga4-backfill.json'));
const reusePath = flag('reuse', '');

/**
 * Which apps to scan, and where each one's GA4 export lives.
 *
 * Read out of the database rather than compiled in. `bigquery_app_sources` is
 * where the operator already records a dataset per app for the live listing
 * sync, and the affiliate programs are what say which apps have referrals worth
 * back-crediting, so the intersection of the two is exactly the right scope and
 * needs nobody to restate it. This was two named constants and two named
 * environment variables, which was a way to point the analysis at the wrong
 * property in a deployment with three apps.
 *
 * `--app <appId>:<dataset>[:<name>]`, repeatable, overrides the lot — for a
 * dataset that is not registered yet, or to scan one app out of five.
 */
interface BackfillSource {
  appId: string;
  name: string;
  dataset: string;
}

function flagAll(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) {
      const value = process.argv[index + 1];
      if (value) values.push(value);
    }
  }
  return values;
}

function sourcesFromFlags(): BackfillSource[] {
  return flagAll('app').map((entry) => {
    const [appId = '', dataset = '', name = ''] = entry.split(':');
    if (!appId || !dataset) {
      throw new BigQueryError(`--app "${entry}" must be <appId>:<dataset>[:<name>].`);
    }
    return { appId, dataset, name: name || appId };
  });
}

function sourcesFromDatabase(): BackfillSource[] {
  let db: Database.Database;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new BigQueryError(
      `Cannot read ${databasePath} to discover the apps to scan: ${(error as Error).message}. ` +
        `Pass --app <appId>:<dataset> instead.`,
    );
  }
  try {
    return (
      db
        .prepare(
          `SELECT DISTINCT p.app_id AS appId,
                  COALESCE(NULLIF(a.name, ''), NULLIF(p.name, ''), p.app_id) AS name,
                  COALESCE(s.dataset, '') AS dataset
             FROM affiliate_programs p
             LEFT JOIN apps a ON a.id = p.app_id
             LEFT JOIN bigquery_app_sources s ON s.app_id = p.app_id
            WHERE p.app_id <> ''
            ORDER BY name`,
        )
        .all() as BackfillSource[]
    ).filter((row) => row.dataset !== '');
  } finally {
    db.close();
  }
}

/** The first day GA4 exported. Earlier than this there is nothing to read. */
const EXPORT_STARTS = '2024-04-21';

/* ----------------------------------------------------------- the backfill */

/**
 * One month of install dates at a time.
 *
 * The full multi-year scan is only 0.92 GB, so this is not about cost. It is
 * about two other things. A single query returning every candidate click-install pair
 * over two years risks the 200,000-row cap inside `runAttribution`, which
 * refuses rather than truncating — correctly, since first touch over a
 * truncated set credits the wrong affiliate. And a chunked run that fails on
 * month 19 has 18 months of usable output, where one giant query has none.
 *
 * Chunks overlap by construction: each carries its own 30-day click lookback,
 * so a click in late May can still claim an install in early June. The seam is
 * healed in `mergeAttributionChunks`, not here.
 */
function monthChunks(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  if (cursor < from) cursor = from;
  while (cursor < to) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    chunks.push({ from: cursor, to: next > to ? to : next });
    cursor = next;
  }
  return chunks;
}

async function openConnection(): Promise<Connected> {
  const projectId = flag('project', '<your-bigquery-project>');
  const keyPath = flag('credentials', path.join(process.cwd(), '.secrets/google-service-account.json'));
  const now = new Date().toISOString();
  // The credential is read at run time and never echoed — not into the output
  // file, not into an error. It is the one value here that must not reach a
  // terminal someone pastes into a ticket.
  const connection: BigQueryConnection = {
    projectId,
    location: flag('location', 'US'),
    credentials: fs.readFileSync(keyPath.replace(/^~/, home), 'utf8'),
    clientEmail: '',
    privateKeyId: '',
    checkedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  return connect(connection);
}

async function backfill(
  from: Date,
  to: Date,
  handles: string[],
  sources: BackfillSource[],
): Promise<Attribution[][]> {
  const connected = await openConnection();
  const chunks: Attribution[][] = [];
  for (const source of sources) {
    for (const window of monthChunks(from, to)) {
      const found = await runAttribution(
        connected,
        { appId: source.appId, dataset: source.dataset, location: connected.connection.location },
        { from: window.from, to: window.to, handles },
      );
      process.stderr.write(
        `  ${source.name} ${window.from.toISOString().slice(0, 7)}: ${found.length}\n`,
      );
      chunks.push(found);
    }
  }
  return chunks;
}

/* ------------------------------------------------------- Mantle's history */

/**
 * Mantle's imported referrals, flattened to the fields the diff needs.
 *
 * Live and soft-deleted together — `readMantleExport` concatenates them, and it
 * is right to. A referral Mantle unassigned after a 30-day uninstall sweep was
 * still a referral it attributed; excluding those 35 would inflate the "Mantle
 * missed it" count by exactly the referrals it did not miss.
 *
 * The handle comes from the membership, keyed on affiliate *and* program: two
 * affiliates hold memberships in more than one program, and while the handles
 * happen to be equal today, keying on the affiliate alone would be a bug
 * waiting for the first affiliate who joins the second program later.
 */
function loadMantleReferrals(appIdByProgram: Map<string, string>): ClassifiedReferral[] {
  const { attributions, affiliates } = readMantleExport(exportsDir);
  const reconciliation = JSON.parse(
    fs.readFileSync(path.join(exportsDir, 'normalized/reconciliation.json'), 'utf8'),
  ) as { handles?: Array<{ affiliateId: string; affiliateProgramId: string; handle: string }> };

  const handleByMembership = new Map<string, string>();
  for (const membership of reconciliation.handles ?? []) {
    handleByMembership.set(
      `${membership.affiliateId} ${membership.affiliateProgramId}`,
      membership.handle.trim().toLowerCase(),
    );
  }
  const nameById = new Map<string, string | null>(
    affiliates.map((affiliate) => [affiliate.id, affiliate.name ?? null]),
  );

  return attributions.map((row) => {
    const referral: MantleReferral = {
      attributionId: row.id,
      affiliateId: row.affiliateId,
      affiliateName: nameById.get(row.affiliateId) ?? null,
      programId: row.affiliateProgramId,
      appId: appIdByProgram.get(row.affiliateProgramId) ?? '',
      handle: handleByMembership.get(`${row.affiliateId} ${row.affiliateProgramId}`) ?? '',
      shopId: row.appInstallation?.platformId ? String(row.appInstallation.platformId) : null,
      shopDomain: row.appInstallation?.myshopifyDomain ?? null,
      referredAt: row.date,
      createdAt: row.createdAt,
      hasListingPageView: Boolean(row.appListingPageViewId),
      deletedAt: row.deletedAt ?? null,
    };
    return classifyOrigin(referral);
  });
}

/**
 * Lifetime commission actually paid on each of Mantle's own referrals.
 *
 * Cancelled and soft-deleted commission rows are dropped — they were never
 * money owed — which matches `commissionReplay.ts`. Both filters are empty in
 * the current export, but a filter that only holds by luck is not a filter.
 */
function earnedByAttribution(): Map<string, number> {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(exportsDir, 'dashboard/commissions.json'), 'utf8'),
  ) as {
    items?: Array<{
      affiliateAttributionId: string | null;
      amount: number;
      cancelled?: boolean;
      deletedAt?: string | null;
    }>;
  };
  const earned = new Map<string, number>();
  for (const row of parsed.items ?? []) {
    if (row.cancelled === true || row.deletedAt || !row.affiliateAttributionId) continue;
    earned.set(row.affiliateAttributionId, (earned.get(row.affiliateAttributionId) ?? 0) + row.amount);
  }
  return earned;
}

/* ------------------------------------------------------------- valuation */

/**
 * Subscription gross per merchant, from PartnerDex's own transactions.
 *
 * Read-only and from a copy if the caller points at one: the live database is
 * mid-backfill and the sync may hold it. Only `AppSubscriptionSale` is summed,
 * because that is the only component any of the real commission rows ever
 * came from, and only charges dated **on or after the install** count — an
 * affiliate is not owed for revenue that predates the merchant they referred,
 * which matters here precisely because a reinstalled merchant has revenue
 * before their second install.
 */
function grossByShop(
  attributions: Array<{ appId: string; shopId: string; installedAt: string }>,
): { map: Map<string, number>; windowStart: string | null; windowEnd: string | null } {
  const map = new Map<string, number>();
  let db: Database.Database;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    return { map, windowStart: null, windowEnd: null };
  }
  try {
    const bounds = db
      .prepare(
        "SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM transactions WHERE type = 'AppSubscriptionSale'",
      )
      .get() as { lo: string | null; hi: string | null };

    const sum = db.prepare(
      `SELECT COALESCE(SUM(gross_amount), 0) AS gross
         FROM transactions
        WHERE type = 'AppSubscriptionSale' AND app_id = ? AND shop_id = ? AND created_at >= ?`,
    );
    for (const row of attributions) {
      const { gross } = sum.get(row.appId, row.shopId, row.installedAt) as { gross: number };
      if (gross > 0) map.set(shopKey(row.appId, row.shopId), gross);
    }
    return { map, windowStart: bounds?.lo ?? null, windowEnd: bounds?.hi ?? null };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  let from = parseDate(flag('from', EXPORT_STARTS), '--from');
  let to = parseDate(flag('to', new Date().toISOString().slice(0, 10)), '--to');

  const { appIdByProgram } = importedPrograms(databasePath);
  const mantle = loadMantleReferrals(appIdByProgram);
  // The real handle list, not the shape test. Without it an eight-character
  // `utm_source` — a campaign name, a partner site — passes for an affiliate
  // and can take first touch away from the affiliate who earned it.
  const handles = [...new Set(mantle.map((row) => row.handle).filter(Boolean))];
  const reconciliation = JSON.parse(
    fs.readFileSync(path.join(exportsDir, 'normalized/reconciliation.json'), 'utf8'),
  ) as { handles?: Array<{ handle: string }> };
  const allHandles = [
    ...new Set((reconciliation.handles ?? []).map((row) => row.handle.trim().toLowerCase())),
  ];

  let chunks: Attribution[][];
  if (reusePath) {
    process.stderr.write(`Reusing ${reusePath}\n`);
    const cached = JSON.parse(fs.readFileSync(reusePath, 'utf8')) as {
      chunks: Attribution[][];
      report?: { window?: { from?: string; to?: string } };
    };
    chunks = cached.chunks;
    // The window belongs to the cached scan, not to whatever flags this rerun
    // happens to carry. Reporting today's default over last week's chunks
    // would put a period on the analysis that was never queried.
    if (cached.report?.window?.from) from = new Date(cached.report.window.from);
    if (cached.report?.window?.to) to = new Date(cached.report.window.to);
  } else {
    const flagged = sourcesFromFlags();
    const sources = flagged.length > 0 ? flagged : sourcesFromDatabase();
    if (sources.length === 0) {
      throw new BigQueryError(
        'No apps to scan. Every affiliate program either has no app id or no GA4 dataset ' +
          'registered in bigquery_app_sources. Pass --app <appId>:<dataset> to name one.',
      );
    }
    process.stderr.write(
      `Backfilling ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)} ` +
        `over ${allHandles.length} known handles, ` +
        `${sources.map((source) => source.name).join(', ')}\n`,
    );
    chunks = await backfill(from, to, allHandles, sources);
  }

  const merged = mergeAttributionChunks(chunks);
  const comparison = compareAttributions(merged.attributions, mantle);
  const missed = grossByShop(comparison.ga4Only);
  const valuation = valueAttributions(comparison.ga4Only, missed.map);
  // The same rule over the merchants Mantle *did* credit, as a control: if the
  // valuation of the misses looks implausible, this is what it is compared to.
  const matchedGross = grossByShop(comparison.matched.map((pair) => pair.ga4));
  const matchedValuation = valueAttributions(
    comparison.matched.map((pair) => pair.ga4),
    matchedGross.map,
  );
  // And the estimate, because the measured figure above can only see a window
  // that most of the missed merchants predate.
  const benchmarks = cohortBenchmarks(mantle, earnedByAttribution());
  const estimate = estimateByBenchmark(comparison.ga4Only, benchmarks);

  const report = {
    generatedAt: new Date().toISOString(),
    window: { from: from.toISOString(), to: to.toISOString() },
    handlesConsidered: allHandles.length,
    handlesWithReferrals: handles.length,
    ga4: {
      attributions: merged.attributions.length,
      affiliates: new Set(merged.attributions.map((row) => row.handle)).size,
      reinstalledShops: merged.reinstalledShops,
      reinstallConflicts: merged.reinstalls,
    },
    mantle: { referrals: mantle.length, origin: originEvidence(mantle) },
    comparison: {
      matched: comparison.matched.length,
      disagreements: comparison.disagreements.length,
      ga4Only: comparison.ga4Only.length,
      mantleOnly: comparison.mantleOnly.length,
      mantleOnlyManual: comparison.mantleOnly.filter((row) => row.origin === 'manual').length,
      mantleOnlyAutomated: comparison.mantleOnly.filter((row) => row.origin === 'automated').length,
      mantleOnlyUncertain: comparison.mantleOnly.filter((row) => row.origin === 'uncertain').length,
      // The 35 rows with no page view and no retroactive lag, resolved by
      // whether GA4 independently found the same referral. A match is evidence
      // the click existed and Mantle's own pipeline wrote the row.
      uncertainReproducedByGa4: comparison.matched.filter(
        (pair) => pair.mantle.origin === 'uncertain',
      ).length,
      crossApp: comparison.crossApp,
    },
    byPeriod: breakdownByPeriod(comparison),
    valuation: {
      transactionWindow: { from: missed.windowStart, to: missed.windowEnd },
      missed: {
        attributions: comparison.ga4Only.length,
        earning: valuation.earning,
        gross: valuation.totalGross,
        commission: valuation.totalCommission,
      },
      benchmarkEstimate: estimate,
      benchmarks,
      matchedControl: {
        attributions: comparison.matched.length,
        earning: matchedValuation.earning,
        gross: matchedValuation.totalGross,
        commission: matchedValuation.totalCommission,
      },
    },
    disagreements: comparison.disagreements.map((row) => ({
      shopId: row.ga4.shopId,
      shopDomain: row.ga4.shopDomain ?? row.mantle.shopDomain,
      appId: row.ga4.appId,
      ga4Handle: row.ga4Handle,
      ga4ClickedAt: row.ga4.clickedAt,
      ga4InstalledAt: row.ga4.installedAt,
      ga4AnonymousId: row.ga4.anonymousId,
      mantleHandle: row.mantleHandle,
      mantleAffiliate: row.mantle.affiliateName,
      mantleReferredAt: row.mantle.referredAt,
      mantleCreatedAt: row.mantle.createdAt,
      mantleOrigin: row.mantle.origin,
      mantleLagDays: Math.round(row.mantle.lagDays * 100) / 100,
      mantleHadPageView: row.mantle.hasListingPageView,
    })),
    missedByAffiliate: [...
      valuation.rows.reduce((byHandle, row) => {
        const entry = byHandle.get(row.attribution.handle) ?? { merchants: 0, commission: 0 };
        entry.merchants += 1;
        entry.commission = Math.round((entry.commission + row.commission) * 100) / 100;
        byHandle.set(row.attribution.handle, entry);
        return byHandle;
      }, new Map<string, { merchants: number; commission: number }>()),
    ]
      .map(([handle, entry]) => ({ handle, ...entry }))
      .sort((a, b) => b.commission - a.commission || b.merchants - a.merchants),
    missedDetail: valuation.rows.map((row) => ({
      appId: row.attribution.appId,
      shopId: row.attribution.shopId,
      shopDomain: row.attribution.shopDomain,
      handle: row.attribution.handle,
      clickedAt: row.attribution.clickedAt,
      installedAt: row.attribution.installedAt,
      grossSubscription: Math.round(row.grossSubscription * 100) / 100,
      commission: row.commission,
    })),
    mantleOnlyDetail: comparison.mantleOnly.map((row) => ({
      attributionId: row.attributionId,
      appId: row.appId,
      shopDomain: row.shopDomain,
      handle: row.handle,
      referredAt: row.referredAt,
      origin: row.origin,
      lagDays: Math.round(row.lagDays * 100) / 100,
      hasListingPageView: row.hasListingPageView,
      unassigned: Boolean(row.deletedAt),
    })),
  };

  if (!reusePath) {
    fs.writeFileSync(outPath, JSON.stringify({ chunks, report }, null, 2));
    process.stderr.write(`\nWrote ${outPath}\n`);
  }

  if (has('json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const money = (value: number): string => `$${value.toFixed(2)}`;
  console.log(`\nGA4 alone, ${from.toISOString().slice(0, 10)} .. ${to.toISOString().slice(0, 10)}`);
  console.log(`  attributions            ${report.ga4.attributions}`);
  console.log(`  distinct affiliates     ${report.ga4.affiliates}`);
  console.log(`  shops installing twice+ ${report.ga4.reinstalledShops} (${merged.reinstalls.length} credited elsewhere on the reinstall)`);
  console.log(`\nMantle, all referrals`);
  console.log(`  automated (has page view)  ${report.mantle.origin.automated}, median lag ${report.mantle.origin.medianLagAutomated.toFixed(3)}d, max ${report.mantle.origin.maxLagAutomated.toFixed(1)}d`);
  console.log(`  manual    (no page view, lag > ${MANUAL_LAG_THRESHOLD_DAYS}d) ${report.mantle.origin.manual}, median lag ${report.mantle.origin.medianLagManual.toFixed(1)}d, min ${report.mantle.origin.minLagManual.toFixed(1)}d`);
  console.log(`  uncertain (no page view, lag <= ${MANUAL_LAG_THRESHOLD_DAYS}d) ${report.mantle.origin.uncertain}, median lag ${report.mantle.origin.medianLagUncertain.toFixed(2)}d`);
  console.log(`  rows in the grey band ${AUTOMATED_LAG_CEILING_DAYS}d..${MANUAL_LAG_THRESHOLD_DAYS}d: ${report.mantle.origin.inTheGreyBand}  (a lag threshold alone cannot sort these)`);
  console.log(`\nDiff`);
  console.log(`  agreed                  ${report.comparison.matched}`);
  console.log(`  DISAGREED               ${report.comparison.disagreements}`);
  console.log(`  GA4 only (Mantle missed)${String(report.comparison.ga4Only).padStart(5)}`);
  console.log(`  Mantle only             ${report.comparison.mantleOnly} = ${report.comparison.mantleOnlyManual} manual + ${report.comparison.mantleOnlyAutomated} automated + ${report.comparison.mantleOnlyUncertain} uncertain`);
  console.log(`  of the ${report.mantle.origin.uncertain} uncertain rows, GA4 independently reproduced ${report.comparison.uncertainReproducedByGa4}`);
  console.log(`\nBy year (GA4 installs / Mantle referral dates)`);
  for (const period of report.byPeriod) {
    console.log(
      `  ${period.period}  agreed ${String(period.matched).padStart(3)}  ga4-only ${String(period.ga4Only).padStart(3)}` +
        `  mantle-only ${String(period.mantleOnlyAutomated).padStart(3)} auto / ${String(period.mantleOnlyManual).padStart(3)} manual / ${String(period.mantleOnlyUncertain).padStart(2)} unc` +
        `  disagreed ${period.disagreements}`,
    );
  }
  console.log(
    `\nValue of what Mantle missed (20% of gross, subscription only)\n` +
      `  transactions available ${missed.windowStart?.slice(0, 10) ?? 'none'} .. ${missed.windowEnd?.slice(0, 10) ?? 'none'}\n` +
      `  ${valuation.earning} of ${comparison.ga4Only.length} missed merchants have charges in that window\n` +
      `  gross ${money(valuation.totalGross)}  →  commission ${money(valuation.totalCommission)}  (a floor, not a total)\n` +
      `  control: the ${comparison.matched.length} agreed merchants earned ${money(matchedValuation.totalCommission)} over the same window\n` +
      `\nEstimate from Mantle's own ledger (INFERENCE, not measured revenue)\n` +
      `  ${money(estimate.low)} (median per referral) .. ${money(estimate.high)} (mean per referral)` +
      `${estimate.unpriced > 0 ? `, ${estimate.unpriced} merchant(s) with no comparable cohort` : ''}`,
  );
  for (const benchmark of benchmarks) {
    console.log(
      `    app ${benchmark.appId} ${benchmark.period}: n=${benchmark.referrals}` +
        `  mean ${money(benchmark.meanCommission)}  median ${money(benchmark.medianCommission)}`,
    );
  }

  for (const row of report.disagreements) {
    console.log(
      `\nDISAGREEMENT  ${row.shopDomain ?? row.shopId} (app ${row.appId})\n` +
        `  GA4    ${row.ga4Handle}  clicked ${row.ga4ClickedAt}  installed ${row.ga4InstalledAt}\n` +
        `  Mantle ${row.mantleHandle}  referred ${row.mantleReferredAt}  created ${row.mantleCreatedAt}` +
        `  (${row.mantleOrigin}, lag ${row.mantleLagDays}d, page view ${row.mantleHadPageView})`,
    );
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

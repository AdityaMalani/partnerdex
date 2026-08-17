#!/usr/bin/env node
import { ConfigError, getConfig } from './config.js';
import { getDb } from './db/index.js';
import { activeOrgs } from './orgs/registry.js';
import { partnerQuery, PartnerApiError } from './partner/client.js';
import { HEALTHCHECK_QUERY } from './partner/queries.js';
import { dispatchPending } from './notifications/dispatch.js';
import { runSync } from './sync/index.js';
import { rebuildDerivedTables } from './sync/derive.js';
import { runMetric, listMetrics } from './metrics/registry.js';
import { serve } from './server/index.js';
import {
  formatImportReport,
  ImportInputError,
  parseAppIds,
  runMantleImport,
} from './affiliates/importRun.js';
import {
  formatOnboardingSummary,
  OnboardingError,
  runOnboarding,
} from './notifications/onboarding.js';
import { issueSetPasswordLink } from './server/portalAuth.js';
import { runValidators } from './validate.js';

const USAGE = `partnerdex - self-hosted analytics for your Shopify apps

Usage:
  partnerdex doctor              Check configuration and Partner API access
  partnerdex sync [--full]       Pull events and transactions, rebuild indexes
  partnerdex rebuild             Recompile the derived indexes from local data
  partnerdex serve               Start the API and dashboard
  partnerdex validate            Run the trust checks
  partnerdex portal-link --email=<address> | --all
                                 Mint affiliate set-password links and print them
  partnerdex onboard-affiliates [--dry-run] [--limit=N] [--resend] [--spacing-ms=N]
                                 Email set-password links to affiliates who have none
  partnerdex import-affiliates --exports=<dir> [--dry-run] [--app=<mantleAppId>=<appId>]
                                 Import the Mantle affiliate export into the ledger
  partnerdex query <metric> [--period=last_12_months] [--interval=month] [--asOf=YYYY-MM-DD]

Metrics:
${listMetrics()
  .map((metric) => `  ${metric.key.padEnd(24)} ${metric.description}`)
  .join('\n')}
`;

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [name, value] = arg.slice(2).split('=');
    if (name) flags[name] = value ?? 'true';
  }
  return flags;
}

async function doctor(): Promise<void> {
  const config = getConfig();
  // Opened before the organizations are read, because opening is what seeds the
  // table from the environment. `doctor` reporting a different list from the one
  // the sync would use is exactly the confusion it exists to prevent.
  const store = getDb();
  const orgs = activeOrgs(store);
  console.log('Configuration');
  console.log(`  Partner API version   ${config.partner.apiVersion}`);
  if (orgs.length === 0) {
    console.log('  Organization          none configured');
  }
  for (const org of orgs) {
    const label = org.label === org.organizationId ? '' : ` (${org.label})`;
    console.log(`  Organization          ${org.organizationId}${label}`);
  }
  console.log(
    `  App scope             ${
      config.scope.appIds.length > 0
        ? `${config.scope.appIds.length} app(s) from PARTNER_APP_IDS`
        : 'every app with transactions (PARTNER_APP_IDS empty)'
    }`,
  );
  console.log(`  Database              ${config.runtime.databasePath}`);
  console.log(`  Timezone              ${config.runtime.timezone}`);

  /*
   * Every organization is checked, and one failure does not hide the rest.
   *
   * A bad token is the whole reason to run `doctor`, and with several
   * configured the useful answer is *which one* — stopping at the first failure
   * would leave the operator unable to tell a broken second org from an
   * untested one.
   */
  console.log('\nPartner API reachability');
  let unreachable = 0;
  for (const org of orgs) {
    process.stdout.write(`  ${org.label.padEnd(22)}`);
    try {
      await partnerQuery(org, HEALTHCHECK_QUERY);
      console.log('reachable');
    } catch (cause) {
      unreachable += 1;
      console.log(`FAILED - ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const db = store;
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM apps) AS apps,
         (SELECT COUNT(*) FROM app_events) AS events,
         (SELECT COUNT(*) FROM transactions) AS transactions,
         (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
         (SELECT COUNT(*) FROM install_intervals) AS installs`,
    )
    .get() as Record<string, number>;

  console.log('\nLocal store');
  for (const [key, value] of Object.entries(counts)) {
    console.log(`  ${key.padEnd(22)}${value}`);
  }
  const byOrg = db
    .prepare(`SELECT org_id, COUNT(*) AS apps FROM apps GROUP BY org_id ORDER BY org_id`)
    .all() as Array<{ org_id: string; apps: number }>;
  if (byOrg.length > 0) {
    console.log('\nApps by organization');
    for (const row of byOrg) {
      console.log(`  ${(row.org_id || '(unattributed)').padEnd(22)}${row.apps}`);
    }
  }

  if (counts.events === 0) {
    console.log('\nNo data yet. Run: partnerdex sync');
  }

  // A non-zero exit, so a scripted check notices. Printed above rather than
  // thrown, so the local-store section still runs when a token is bad.
  if (unreachable > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case 'doctor':
      await doctor();
      break;

    case 'sync': {
      const started = Date.now();
      const result = await runSync({
        full: flags.full === 'true',
        onProgress: (message) => console.log(message),
      });
      console.log(
        `\nDone in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${result.apps.length} app(s), ${result.transactions} transaction(s), ` +
          `${result.events} event(s), ${result.subscriptions} subscription(s), ` +
          `${result.installs} install interval(s), ` +
          `${result.customerEvents} customer event(s).`,
      );

      if (result.reviews.apps.length > 0) {
        console.log(
          `Reviews: ${result.reviews.added} new, ${result.reviews.updated} edited, ` +
            `${result.reviews.removed} no longer on the listing ` +
            `(${result.reviews.swept.length} listing(s) walked in full).`,
        );
      }

      if (result.listing.rows > 0) {
        console.log(
          `Listing traffic: ${result.listing.rows} GA4 event(s) across ` +
            `${result.listing.apps.length} app(s).`,
        );
      }
      // Said out loud rather than left to the settings page: a funnel that is
      // quietly missing one app looks like an app nobody visits.
      for (const skip of result.listing.skipped) {
        console.log(`Listing traffic skipped for app ${skip.appId}: ${skip.reason}`);
      }

      // `serve` notifies from its own loop. Doing it here too is what keeps a
      // cron-driven `partnerdex sync` — the setup you get with
      // SYNC_INTERVAL_MINUTES=0 — from going quiet. The delivery ledger is
      // shared, so the two can never both send the same event.
      const notified = await dispatchPending();
      if (notified.sent > 0) {
        console.log(`Sent ${notified.sent} notification(s) to ${notified.channels} channel(s).`);
      }
      break;
    }

    /**
     * Everything downstream of the raw feeds is a pure function of them, so the
     * indexes can be rebuilt without touching the Partner API. That is what
     * makes changing a classification rule cheap to try.
     */
    case 'rebuild': {
      const started = Date.now();
      // `rebuild` exists to distrust what is stored, so it recompiles every
      // payment event rather than only the ones the sync has not seen yet.
      const result = rebuildDerivedTables(getDb(), { full: true });
      console.log(
        `Rebuilt in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${result.subscriptions} subscription(s), ${result.installs} install interval(s), ` +
          `${result.customerEvents} customer event(s), ` +
          `${result.reviewEvents} review event(s), ` +
          `${result.transactionDays} day(s) of transaction rollup, ` +
          `${result.pairs} merchant(s) rebuilt.`,
      );
      break;
    }

    case 'serve':
      serve();
      break;

    case 'validate': {
      const findings = runValidators();
      if (findings.length === 0) {
        console.log('All checks passed.');
        break;
      }
      for (const finding of findings) {
        console.log(`[${finding.severity.toUpperCase()}] ${finding.check}: ${finding.message}`);
        if (finding.detail) console.log(`         ${JSON.stringify(finding.detail)}`);
      }
      process.exitCode = findings.some((f) => f.severity === 'high') ? 1 : 0;
      break;
    }

    /**
     * Mint set-password links for affiliates, at a terminal, on purpose.
     *
     * The imported accounts have no passwords, so a link is the only way in
     * for every one of them. Printing links used to happen by itself, into the
     * application log, for every link anyone requested — which published live
     * account-takeover URLs to everyone holding `fly logs`. Here the same output
     * requires somebody to type the command, and lands on their terminal rather
     * than in a log stream with an unbounded audience. That difference is the
     * whole fix; the token, its lifetime and its storage are unchanged.
     *
     * `--csv` because onboarding hundreds of people means a mail merge, and the
     * shape
     * that survives a spreadsheet is two columns and a comma. Emails and names
     * are quoted; the URL cannot contain a comma (base64url plus a UUID).
     */
    case 'portal-link': {
      const db = getDb();
      const all = flags.all === 'true';
      const email = flags.email?.trim().toLowerCase() ?? '';
      if (!all && !email) {
        console.error('Usage: partnerdex portal-link --email=<address> | --all [--csv]');
        process.exitCode = 1;
        break;
      }

      const rows = (
        all
          ? db
              .prepare(`SELECT id FROM affiliates WHERE status = 'active' ORDER BY created_at`)
              .all()
          : db
              .prepare(
                `SELECT id FROM affiliates
                  WHERE LOWER(email) = ? AND status = 'active' ORDER BY created_at`,
              )
              .all(email)
      ) as Array<{ id: string }>;

      if (rows.length === 0) {
        console.error(
          all ? 'No active affiliates.' : `No active affiliate with the address ${email}.`,
        );
        process.exitCode = 1;
        break;
      }

      // Said before the links, not after: on a long run the warning would
      // otherwise scroll away above whatever the operator is about to copy.
      console.error(
        `Minting ${rows.length} link(s). Each one opens that affiliate's account for 24 ` +
          `hours — treat this output as a list of passwords, and note that minting ` +
          `replaces any link already outstanding for the same affiliate.`,
      );

      const csv = flags.csv === 'true';
      if (csv) console.log('email,name,url,expiresAt');
      for (const row of rows) {
        const link = issueSetPasswordLink(db, row.id);
        if (!link) continue;
        const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
        console.log(
          csv
            ? `${quote(link.email)},${quote(link.name)},${link.url},${link.expiresAt}`
            : `${link.email.padEnd(32)} ${link.url}  (valid until ${link.expiresAt})`,
        );
      }
      break;
    }

    /**
     * The bulk onboarding send, and the reason the portal is usable at all.
     *
     * Every one of the imported accounts arrived without a password, so a
     * set-password link is the only way in for all of them. `portal-link --all`
     * above prints those links for a mail merge, which works and which, in
     * practice, nobody was ever going to finish: hundreds of copy-pastes is a
     * task that
     * quietly does not happen. This does the same thing with the links going
     * straight to a relay instead of to a terminal, and with a ledger behind it
     * so a run that stops halfway is resumed by running it again.
     *
     * `--dry-run` first, always. It reports the batch without minting a token or
     * opening a socket, and it is where the shared-address groups show up — one
     * inbox that two separate affiliate accounts both claim. Those are never
     * sent automatically; see `onboarding.ts`.
     */
    case 'onboard-affiliates': {
      const spacing = Number(flags['spacing-ms']);
      const limit = Number(flags.limit);
      try {
        const summary = await runOnboarding(getDb(), {
          dryRun: flags['dry-run'] === 'true',
          resend: flags.resend === 'true',
          limit: Number.isFinite(limit) ? limit : undefined,
          spacingMs: Number.isFinite(spacing) ? spacing : undefined,
          // Printed as they go rather than only at the end: a fifteen-minute run
          // with no output is indistinguishable from a hung one.
          onProgress: (message) => console.log(message),
        });
        console.log(formatOnboardingSummary(summary));
        process.exitCode = summary.failed > 0 ? 1 : 0;
      } catch (error) {
        if (!(error instanceof OnboardingError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
      break;
    }

    /**
     * The one-way move off Mantle, runnable where the database actually is.
     *
     * A subcommand rather than only a script because the production image is
     * runtime-only: it carries `dist/`, production dependencies and nothing
     * else, so `scripts/import-mantle-affiliates.ts` and the `tsx` that runs it
     * are both absent there. The deployed database is exactly where the
     * affiliates have to end up — until they do, every referral link 404s — so
     * the import has to ship in `dist/`.
     *
     * Safe to re-run, and expected to be. Every write is keyed on Mantle's own
     * ids, so an interrupted run is repaired by running it again, and a referral
     * whose merchant had not synced yet gets its shop filled in by a later pass.
     * `--dry-run` does the whole import and rolls it back.
     */
    case 'import-affiliates': {
      try {
        const { report } = runMantleImport({
          exportsDir: flags.exports ?? '',
          dryRun: flags['dry-run'] === 'true',
          appIds: parseAppIds(flags.app),
          onProgress: (message) => console.log(message),
        });
        console.log(formatImportReport(report, flags['dry-run'] === 'true'));
      } catch (error) {
        if (!(error instanceof ImportInputError)) throw error;
        console.error(error.message);
        console.error(
          'Usage: partnerdex import-affiliates --exports=<dir> [--dry-run] ' +
            '[--app=<mantleAppId>=<appId>]',
        );
        process.exitCode = 1;
      }
      break;
    }

    case 'query': {
      const metric = rest.find((arg) => !arg.startsWith('--'));
      if (!metric) {
        console.error('Usage: partnerdex query <metric> [--period=...] [--interval=...]');
        process.exitCode = 1;
        break;
      }
      // `--asOf` is shorthand for "the series ending on this date", which is how
      // you ask what a metric read on a past day.
      const response = runMetric(metric, {
        period: flags.period,
        start: flags.start,
        end: flags.end ?? flags.asOf,
        interval: flags.interval,
        appIds: flags.appIds,
        includeAnnual: flags.includeAnnual,
        includeUsage: flags.includeUsage,
        includeTrials: flags.includeTrials,
        byShop: flags.byShop,
        nocache: flags.nocache,
      });
      console.log(JSON.stringify(response, null, 2));
      break;
    }

    default:
      console.log(USAGE);
  }
}

main().catch((error) => {
  if (error instanceof ConfigError || error instanceof PartnerApiError) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { ConfigError, getConfig } from './config.js';
import { formatDomainCoverage, reportDomainCoverage } from './contacts/coverage.js';
import { dumpContactsToFile, restoreContactsFromFile } from './contacts/dump.js';
import { formatImportSummary, importContacts } from './contacts/import.js';
import { getDb } from './db/index.js';
import { partnerQuery, PartnerApiError } from './partner/client.js';
import { HEALTHCHECK_QUERY } from './partner/queries.js';
import { dispatchPending } from './notifications/dispatch.js';
import { runSync } from './sync/index.js';
import { rebuildDerivedTables } from './sync/derive.js';
import { runMetric, listMetrics } from './metrics/registry.js';
import { serve } from './server/index.js';
import { runValidators } from './validate.js';

const USAGE = `partnerdex - self-hosted analytics for your Shopify apps

Usage:
  partnerdex doctor              Check configuration and Partner API access
  partnerdex sync [--full]       Pull events and transactions, rebuild indexes
  partnerdex rebuild             Recompile the derived indexes from local data
  partnerdex serve               Start the API and dashboard
  partnerdex validate            Run the trust checks
  partnerdex query <metric> [--period=last_12_months] [--interval=month] [--asOf=YYYY-MM-DD]
  partnerdex contacts:dump [--out=./contacts-dump.json]
                                 Write contacts + suppressions to a JSON file
  partnerdex contacts:restore --from=<dump.json>
                                 Replace contacts tables from a dump (destructive)
  partnerdex contacts:coverage   Check shops.myshopify_domain population (pre-import)
  partnerdex contacts:import --from=<contacts.csv> --app-id=<id> [--commit]
                                 Preview (default) or commit a contacts CSV

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
  console.log('Configuration');
  console.log(`  Partner API version   ${config.partner.apiVersion}`);
  console.log(`  Organization          ${config.partner.organizationId}`);
  console.log(
    `  App scope             ${
      config.scope.appIds.length > 0
        ? `${config.scope.appIds.length} app(s) from PARTNER_APP_IDS`
        : 'every app with transactions (PARTNER_APP_IDS empty)'
    }`,
  );
  console.log(`  Database              ${config.runtime.databasePath}`);
  console.log(`  Timezone              ${config.runtime.timezone}`);

  process.stdout.write('\nPartner API reachable... ');
  await partnerQuery(HEALTHCHECK_QUERY);
  console.log('yes');

  const db = getDb();
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
  if (counts.events === 0) {
    console.log('\nNo data yet. Run: partnerdex sync');
  }
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
      const result = rebuildDerivedTables(getDb());
      console.log(
        `Rebuilt in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${result.subscriptions} subscription(s), ${result.installs} install interval(s), ` +
          `${result.customerEvents} customer event(s), ` +
          `${result.reviewEvents} review event(s).`,
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

    case 'contacts:dump': {
      // Ensure schema/migrations are applied before reading.
      const db = getDb();
      const out =
        flags.out ??
        `./contacts-dump-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const { path: written, dump } = dumpContactsToFile(out, db);
      console.log(
        `Wrote ${dump.contacts.length} contact(s), ` +
          `${dump.contact_shops.length} shop link(s), ` +
          `${dump.contact_suppressions.length} suppression(s) → ${written}`,
      );
      break;
    }

    case 'contacts:restore': {
      if (!flags.from) {
        console.error('Usage: partnerdex contacts:restore --from=<dump.json>');
        process.exitCode = 1;
        break;
      }
      getDb();
      const counts = restoreContactsFromFile(flags.from);
      console.log(
        `Restored ${counts.contacts} contact(s), ` +
          `${counts.contact_shops} shop link(s), ` +
          `${counts.contact_suppressions} suppression(s) from ${flags.from}`,
      );
      break;
    }

    case 'contacts:coverage': {
      getDb();
      console.log(formatDomainCoverage(reportDomainCoverage()));
      break;
    }

    case 'contacts:import': {
      const from = flags.from;
      const appId = flags['app-id'] ?? flags.appId;
      if (!from || !appId) {
        console.error(
          'Usage: partnerdex contacts:import --from=<contacts.csv> --app-id=<id> [--commit]',
        );
        process.exitCode = 1;
        break;
      }
      getDb();
      const summary = importContacts({
        csvPath: from,
        appId,
        commit: flags.commit === 'true',
      });
      console.log(formatImportSummary(summary));
      if (!summary.committed) {
        console.log(
          '\nRe-run with --commit to write. ' +
            'Take a volume snapshot first: fly volumes snapshots create <volume-id>',
        );
      }
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

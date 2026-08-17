#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { connect, type Connected } from '../bigquery/client.js';
import { BigQueryError, readConnection, type BigQueryConnection } from '../bigquery/connection.js';
import { getDb } from '../db/index.js';
import {
  DEFAULT_LOOKBACK_DAYS,
  REFERRAL_WINDOW_DAYS,
  runAttribution,
  type Attribution,
} from './ga4Attribution.js';

/**
 * Runs affiliate attribution over a window and prints what it found.
 *
 * This exists so the pipeline can be *checked* before anything is written. The
 * numbers it produces are meant to be compared against Mantle's own attribution
 * export for the same window — a rebuild that credits different affiliates than
 * the platform it replaces is a finding, not a rounding difference, and there is
 * no way to see that from a table nobody has diffed.
 *
 * It takes its dataset and credential from flags rather than only from the
 * settings page for the same reason: validating the pipeline must not require
 * first configuring the instance that will run it, and during the migration the
 * apps do not yet exist in the local database.
 *
 *   tsx src/affiliates/attributeCli.ts \
 *     --project=<your-bigquery-project> \
 *     --credentials=/path/to/service-account.json \
 *     --app=<app-id>:analytics_<ga4-property-id> \
 *     --from=2026-06-01 --to=2026-08-13 \
 *     [--handles=handles.json] [--window=30] [--json]
 *
 * `--to` is exclusive, so `--to=2026-08-13` means "installs through the 12th".
 */

interface Flags {
  values: Record<string, string>;
  repeated: Record<string, string[]>;
}

function parseFlags(argv: string[]): Flags {
  const values: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [name, ...rest] = arg.slice(2).split('=');
    if (!name) continue;
    const value = rest.join('=') || 'true';
    values[name] = value;
    (repeated[name] ??= []).push(value);
  }
  return { values, repeated };
}

/** `--from=2026-06-01` at UTC midnight. Dates, not instants: the window is a range of days. */
function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value || value === 'true') return fallback;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BigQueryError(`"${value}" is not a date. Use YYYY-MM-DD.`);
  }
  return parsed;
}

/**
 * The affiliate handles to accept, if the caller has a list.
 *
 * Without one the run falls back to matching the *shape* of a handle, which
 * cannot tell an affiliate from an eight-character campaign name. Passing the
 * real list is what makes the output trustworthy, and during the migration the
 * list is sitting in the Mantle export — accepted here as either a bare JSON
 * array of strings or the reconciliation file's `handles` array of objects.
 */
function readHandles(path: string | undefined): string[] | undefined {
  if (!path || path === 'true') return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { handles?: unknown }).handles as unknown[]) ?? [];
  const handles = list
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { handle?: string })?.handle))
    .filter((handle): handle is string => Boolean(handle));
  if (handles.length === 0) throw new BigQueryError(`No handles found in ${path}.`);
  return handles;
}

/**
 * A connection from flags, or the stored one.
 *
 * The credential is read from disk at run time and never echoed — not into the
 * output, not into an error. It is the one thing here that must not end up in a
 * terminal someone pastes into a ticket.
 */
async function openConnection(flags: Flags): Promise<Connected> {
  const keyPath = flags.values.credentials;
  if (!keyPath || keyPath === 'true') {
    const stored = readConnection(getDb());
    if (!stored) {
      throw new BigQueryError(
        'BigQuery is not connected and no --credentials was given. Pass --project and ' +
          '--credentials=<service-account.json>, or connect BigQuery in Settings.',
      );
    }
    return connect(stored);
  }

  const projectId = flags.values.project;
  if (!projectId || projectId === 'true') {
    throw new BigQueryError('--credentials needs --project=<google-cloud-project-id>.');
  }

  const now = new Date().toISOString();
  const connection: BigQueryConnection = {
    projectId,
    location: flags.values.location === 'true' ? 'US' : flags.values.location || 'US',
    credentials: readFileSync(keyPath, 'utf8'),
    clientEmail: '',
    privateKeyId: '',
    checkedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  return connect(connection);
}

/** `--app=<name>:<dataset>`, repeatable. The name is only a label in the output. */
function parseApps(flags: Flags): Array<{ appId: string; dataset: string }> {
  const apps = (flags.repeated.app ?? []).map((entry) => {
    const [appId, dataset] = entry.split(':');
    if (!appId || !dataset) {
      throw new BigQueryError(`--app must be <name>:<dataset>, got "${entry}".`);
    }
    return { appId, dataset };
  });
  if (apps.length === 0) throw new BigQueryError('Pass at least one --app=<name>:<dataset>.');
  return apps;
}

function report(attributions: Attribution[]): void {
  const byHandle = new Map<string, number>();
  for (const row of attributions) byHandle.set(row.handle, (byHandle.get(row.handle) ?? 0) + 1);

  for (const row of attributions) {
    console.log(
      `  ${row.installedAt.slice(0, 19)}Z  ${row.handle}  ` +
        `${(row.shopDomain ?? `shop ${row.shopId}`).padEnd(46)} ` +
        `clicked ${row.clickedAt.slice(0, 19)}Z`,
    );
  }

  console.log(`\n${attributions.length} attributed install(s), ${byHandle.size} affiliate(s).`);
  const ranked = [...byHandle.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [handle, count] of ranked) console.log(`  ${handle}  ${count}`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const to = parseDate(flags.values.to, new Date());
  const from = parseDate(
    flags.values.from,
    new Date(to.getTime() - (Number(flags.values.lookback) || DEFAULT_LOOKBACK_DAYS) * 86_400_000),
  );
  const windowDays = Number(flags.values.window) || REFERRAL_WINDOW_DAYS;
  const handles = readHandles(flags.values.handles);

  const connected = await openConnection(flags);
  const apps = parseApps(flags);

  const all: Attribution[] = [];
  for (const app of apps) {
    const found = await runAttribution(
      connected,
      { appId: app.appId, dataset: app.dataset, location: connected.connection.location },
      { from, to, windowDays, handles },
    );
    console.log(`\n${app.appId} (${app.dataset}): ${found.length} attributed install(s)`);
    all.push(...found);
  }

  if (flags.values.json === 'true') {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  console.log(
    `\nInstalls from ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} ` +
      `(exclusive), ${windowDays}-day referral window, ` +
      `${handles ? `${handles.length} known handle(s)` : 'handle shape only'}.`,
  );
  all.sort((a, b) => a.installedAt.localeCompare(b.installedAt));
  report(all);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

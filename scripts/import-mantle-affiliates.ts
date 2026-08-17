/**
 * Import the Mantle affiliate export into the affiliate ledger, locally.
 *
 *   npx tsx scripts/import-mantle-affiliates.ts --exports=./data/mantle-exports
 *
 * A wrapper, and deliberately nothing more. The import itself lives in
 * `src/affiliates/importRun.ts` and is reached from `partnerdex
 * import-affiliates`, because the production image carries only `dist/` and has
 * no `scripts/` directory and no `tsx` to run one with — an import that existed
 * only here could never be run against the deployed database.
 *
 * This file survives because `npx tsx scripts/...` is what a developer already
 * has in their shell history, and because it needs no build. It must stay a
 * wrapper: two copies of a routine that writes the affiliate ledger is one copy
 * too many, and the one that drifts is always the one nobody is watching.
 */
import { getDb } from '../src/db/index.js';
import {
  formatImportReport,
  ImportInputError,
  parseAppIds,
  runMantleImport,
} from '../src/affiliates/importRun.js';

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [name, value] = arg.slice(2).split('=');
    if (name) flags[name] = value ?? 'true';
  }
  return flags;
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = flags['dry-run'] === 'true';

  try {
    const { report } = runMantleImport({
      exportsDir: flags.exports ?? '',
      dryRun,
      appIds: parseAppIds(flags.app),
      db: getDb(),
      onProgress: (message) => console.log(message),
    });
    console.log(formatImportReport(report, dryRun));
  } catch (error) {
    if (!(error instanceof ImportInputError)) throw error;
    console.error(error.message);
    console.error(
      'Usage: npx tsx scripts/import-mantle-affiliates.ts --exports=<dir> [--dry-run] ' +
        '[--app=<mantleAppId>=<appId>]',
    );
    process.exitCode = 1;
  }
}

main();

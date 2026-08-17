/**
 * The two live programs, as rule values.
 *
 * These are constants rather than configuration on purpose, for now. Exactly
 * one rule set covers every affiliate: of all the memberships only one carries
 * a `rulesOverride`, and its value is the literal string `"default"`. Nobody is on
 * custom terms and nobody is in a group, so a rules table would be an empty
 * abstraction with a migration attached. When a second rate genuinely exists,
 * move these rows into the programs table and load them; the engine already
 * takes rules as an argument precisely so that swap costs nothing.
 *
 * The ids are Mantle's, kept verbatim so the migrated ledger, the export files
 * and the recomputation all key on the same value.
 */

import type { ProgramRules } from './commission.js';

export const STOQ_PROGRAM_ID = '311f9942-87a7-4cf6-ad12-4bccd66de775';
export const FILEMONK_PROGRAM_ID = '6813d6c6-dfd0-4324-8efc-c5dbd454f723';

/**
 * Shopify Partner API app ids, which is how PartnerDex's `transactions` table
 * identifies the app. Mantle used its own uuids for the same two apps, so any
 * reconciliation has to cross this seam exactly once.
 */
// Configuration, not constants. These are our own Partner API app ids, and
// hardcoding them put a deployment-specific value in a file that is otherwise
// publishable — the scrub that removed them would also have silently broken the
// mapping, since a placeholder string matches no transaction and a program would
// quietly reconcile against nothing.
//
// Read from the environment at call time rather than at import, so a test can
// set them and so a process that never touches the affiliate ledger does not
// require them. Absent means absent: `programAppIds()` returns no entry, and
// every caller already falls back rather than guessing.
export function programAppIds(): Record<string, string> {
  const stoq = process.env.STOQ_APP_ID?.trim();
  const filemonk = process.env.FILEMONK_APP_ID?.trim();
  return {
    ...(stoq ? { [STOQ_PROGRAM_ID]: stoq } : {}),
    ...(filemonk ? { [FILEMONK_PROGRAM_ID]: filemonk } : {}),
  };
}

/**
 * Kept as a getter so existing call sites read unchanged. Evaluated per access,
 * which matters because the environment is not stable across a test file.
 */
export const PROGRAM_APP_IDS: Record<string, string> = new Proxy(
  {},
  {
    get: (_target, key: string) => programAppIds()[key],
    has: (_target, key: string) => key in programAppIds(),
    ownKeys: () => Reflect.ownKeys(programAppIds()),
    getOwnPropertyDescriptor: (_target, key: string) => {
      const value = programAppIds()[key];
      return value === undefined
        ? undefined
        : { value, enumerable: true, configurable: true, writable: false };
    },
  },
) as Record<string, string>;

export const STOQ_RULES: ProgramRules = {
  id: STOQ_PROGRAM_ID,
  percentCommission: 20,
  revenueComponents: ['subscription'],
  durationMonths: null,
  unassignAfterUninstallDays: 30,
  // Confirmed against the soft-deleted attributions, not the ledger. See the
  // note on `unassignAfterUninstallDays` in commission.ts.
  enforceUnassignAfterUninstall: true,
};

export const FILEMONK_RULES: ProgramRules = {
  id: FILEMONK_PROGRAM_ID,
  percentCommission: 20,
  revenueComponents: ['subscription'],
  // 24 months from the first commission — see the note on `durationMonths`.
  durationMonths: 24,
  unassignAfterUninstallDays: 30,
  // Confirmed against the soft-deleted attributions, not the ledger. See the
  // note on `unassignAfterUninstallDays` in commission.ts.
  enforceUnassignAfterUninstall: true,
};

export function defaultProgramRules(): Map<string, ProgramRules> {
  return new Map([
    [STOQ_PROGRAM_ID, STOQ_RULES],
    [FILEMONK_PROGRAM_ID, FILEMONK_RULES],
  ]);
}

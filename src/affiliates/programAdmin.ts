import { randomUUID } from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import {
  PAYOUT_BASES,
  RECURRENCES,
  REVENUE_COMPONENTS,
  isPayoutBasis,
  isRecurrence,
  isRevenueComponent,
  type PayoutBasis,
  type Recurrence,
} from './commission.js';
import { AffiliateAdminError } from './admin.js';

/**
 * Creating and editing a program.
 *
 * The gap this closes is the difference between a migration and a feature.
 * Every program in this system used to exist because an importer wrote one, so
 * the terms — the rate, what it pays on, how long it runs, the grace period
 * after an uninstall — arrived as a side effect of somebody else's database and
 * could only be changed by editing a row by hand. Attribution and commissions
 * always read those terms from `affiliate_programs`, so nothing about the
 * engine needed to change; what was missing was any supported way to put a row
 * there. This is that way.
 *
 * Validation is the substance of the module, not a preamble to it. A program's
 * terms are the only place in this system where a typo silently costs money in
 * both directions: a rate stored as `20` instead of `0.2` overpays by a factor
 * of a hundred on the next recompute, and a revenue component nobody normalises
 * onto earns exactly nothing while still reading back to the operator as the
 * thing they typed. Both are rejected here rather than discovered in a ledger.
 *
 * Everything is checked before anything is written, and the write goes through
 * `upsertProgram` in `store.ts` so a program created here and a program created
 * by an importer are the same kind of row.
 */

/** The terms an operator sets. `null` and "absent" mean different things. */
export interface ProgramTermsInput {
  name?: unknown;
  appId?: unknown;
  listingUrl?: unknown;
  commissionRate?: unknown;
  revenueComponents?: unknown;
  durationMonths?: unknown;
  unassignAfterUninstallDays?: unknown;
  requireApproval?: unknown;
  status?: unknown;
  payoutBasis?: unknown;
  flatAmount?: unknown;
  flatCurrency?: unknown;
  recurrence?: unknown;
  enforceUnassignAfterUninstall?: unknown;
  minimumPayout?: unknown;
  termsUrl?: unknown;
  /** When a change to the money terms starts applying. Defaults to now. */
  effectiveFrom?: unknown;
  /** Why, in the operator's words. Stored on the version, never on the program. */
  note?: unknown;
}

/** The validated form: every field present, every value in range. */
export interface ProgramTerms {
  name: string;
  appId: string;
  listingUrl: string;
  /** A fraction. 0.2 is twenty percent — the column's own units. */
  commissionRate: number;
  revenueComponents: string[];
  /** Null is "for as long as the merchant keeps paying". */
  durationMonths: number | null;
  /** Null is "never released". */
  unassignAfterUninstallDays: number | null;
  requireApproval: boolean;
  status: 'active' | 'closed';
  payoutBasis: PayoutBasis;
  /** The bounty, when `payoutBasis` is `flat_per_referral`. */
  flatAmount: number;
  /** The bounty's currency. Never converted; see `ProgramRules.flatCurrency`. */
  flatCurrency: string;
  recurrence: Recurrence;
  enforceUnassignAfterUninstall: boolean;
  /** Displayed, never enforced. Nothing in this system moves money. */
  minimumPayout: number;
  termsUrl: string;
}

/**
 * The terms that decide what a charge earns, and therefore the ones that are
 * versioned. A change to any of them writes a new version.
 *
 * Uniform rather than clever: `minimumPayout` and `termsUrl` do not price
 * anything, and they are versioned anyway. The alternative is a subset rule
 * that somebody has to keep in step with the engine, and the first time it
 * drifts a money term changes without a version behind it.
 */
export const VERSIONED_TERMS = [
  'payoutBasis',
  'commissionRate',
  'flatAmount',
  'flatCurrency',
  'revenueComponents',
  'recurrence',
  'durationMonths',
  'unassignAfterUninstallDays',
  'enforceUnassignAfterUninstall',
  'minimumPayout',
  'termsUrl',
] as const satisfies ReadonlyArray<keyof ProgramTerms>;

/** One recorded version of a program's terms. */
export interface ProgramTermsVersion {
  id: string;
  effectiveFrom: string;
  note: string;
  createdAt: string;
  payoutBasis: PayoutBasis;
  commissionRate: number;
  flatAmount: number;
  flatCurrency: string;
  revenueComponents: string[];
  recurrence: Recurrence;
  durationMonths: number | null;
  unassignAfterUninstallDays: number | null;
  enforceUnassignAfterUninstall: boolean;
  minimumPayout: number;
  termsUrl: string;
}

export interface ProgramRecord extends ProgramTerms {
  id: string;
  /** The id this program carried in whatever system it was imported from. */
  externalId: string;
  createdAt: string;
  updatedAt: string;
  /** Enrolled memberships. Present so an edit screen can say what it affects. */
  affiliates: number;
  /** Every version of the money terms, oldest first. Always at least one. */
  versions: ProgramTermsVersion[];
}

/**
 * What a program's terms may be, stated once.
 *
 * The ceilings are sanity rails rather than policy: a program is free to pay
 * 90%, and the only thing refused is a value that cannot have been meant. A
 * rate above 1 is the mistake this catches most often, because the column
 * stores a fraction and every human writes a percentage.
 */
const MAX_DURATION_MONTHS = 1200;
const MAX_UNASSIGN_DAYS = 3650;

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AffiliateAdminError(`"${field}" must be a string.`);
  }
  return value.trim();
}

/**
 * A listing URL is either absent or an absolute http(s) URL.
 *
 * Absolute because it ends up in a `Location` header on the public redirect
 * route and in links affiliates paste into blog posts; a relative or
 * scheme-less value there is a broken link at best and an open redirect off
 * this origin at worst. Checked with the URL parser rather than a regex so the
 * thing that validates it is the thing that will later parse it.
 */
function checkListingUrl(raw: string): string {
  if (raw === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AffiliateAdminError(
      `"listingUrl" must be an absolute URL, for example https://apps.example.com/my-app.`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AffiliateAdminError(`"listingUrl" must use http or https, not "${parsed.protocol}".`);
  }
  return parsed.toString();
}

function checkRate(value: unknown): number {
  const rate = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(rate)) {
    throw new AffiliateAdminError('"commissionRate" must be a number.');
  }
  if (rate < 0 || rate > 1) {
    throw new AffiliateAdminError(
      `"commissionRate" is a fraction between 0 and 1 — 0.2 is twenty percent. ` +
        `Got ${rate}.`,
    );
  }
  return rate;
}

/**
 * The revenue components, checked against the vocabulary rather than stored raw.
 *
 * This is the money bug the vocabulary exists to prevent. An unknown component
 * cannot match a normalised transaction, so it earns nothing — and it does so
 * silently, because the settings screen reads the column back and shows the
 * operator the exact string they typed. Rejecting the write is the only point
 * at which the two can be made to agree.
 *
 * An empty list is refused for the same reason: a program that pays on nothing
 * is a program that pays nobody, and if that is genuinely intended, `status`
 * is the field that says so.
 */
function checkRevenueComponents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AffiliateAdminError(
      `"revenueComponents" must be a non-empty array of ${REVENUE_COMPONENTS.join(', ')}.`,
    );
  }
  const seen: string[] = [];
  for (const entry of value) {
    if (!isRevenueComponent(entry)) {
      throw new AffiliateAdminError(
        `"${String(entry)}" is not a revenue component. ` +
          `Known components: ${REVENUE_COMPONENTS.join(', ')}. ` +
          `A program set to an unknown component earns nothing on it.`,
      );
    }
    if (!seen.includes(entry)) seen.push(entry);
  }
  return seen;
}

function checkOptionalCount(
  value: unknown,
  field: string,
  max: number,
  minimum: number,
): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > max) {
    throw new AffiliateAdminError(
      `"${field}" must be null or a whole number between ${minimum} and ${max}. Got ${String(value)}.`,
    );
  }
  return parsed;
}

/**
 * An app id, checked against `apps` when one is given.
 *
 * Blank is allowed and is not the same as wrong: a program can be set up before
 * the first Partner API sync has run, and the column's own comment says so.
 * What is refused is an id that names no app this deployment has ever seen,
 * because a program pointed at one of those has no transactions to commission
 * and would look, from every screen, exactly like a program nobody has used.
 */
function checkAppId(db: Db, raw: string): string {
  if (raw === '') return '';
  const row = db.prepare('SELECT id FROM apps WHERE id = ?').get(raw) as { id: string } | undefined;
  if (!row) {
    throw new AffiliateAdminError(
      `No app with id "${raw}". Use an id from the apps list, or leave it blank ` +
        `until the first sync has run.`,
    );
  }
  return raw;
}

function checkPayoutBasis(value: unknown): PayoutBasis {
  if (!isPayoutBasis(value)) {
    throw new AffiliateAdminError(
      `"payoutBasis" must be one of ${PAYOUT_BASES.join(', ')}. Got "${String(value)}".`,
    );
  }
  return value;
}

function checkRecurrence(value: unknown): Recurrence {
  if (!isRecurrence(value)) {
    throw new AffiliateAdminError(
      `"recurrence" must be one of ${RECURRENCES.join(', ')}. Got "${String(value)}".`,
    );
  }
  return value;
}

/** A money amount: finite, not negative, and rounded to the cent it will be paid in. */
function checkAmount(value: unknown, field: string): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AffiliateAdminError(`"${field}" must be a number of zero or more. Got ${String(value)}.`);
  }
  return Math.round(amount * 100) / 100;
}

/**
 * A currency code, or blank.
 *
 * Three letters, uppercased, and never checked against a list of real
 * currencies — this system does no FX and never resolves a code to a rate, so a
 * list would only be a way to reject a currency that is perfectly spendable.
 * The shape check exists to catch a currency *symbol* pasted into the field,
 * because "$" beside an amount in a portal reads as dollars and would be a
 * claim nobody made.
 */
function checkCurrency(value: unknown, field: string): string {
  const raw = requireString(value ?? '', field).toUpperCase();
  if (raw === '') return '';
  if (!/^[A-Z]{3}$/.test(raw)) {
    throw new AffiliateAdminError(
      `"${field}" must be a three-letter currency code such as USD, or blank. Got "${raw}".`,
    );
  }
  return raw;
}

/**
 * An ISO-8601 instant, refused rather than coerced.
 *
 * `new Date("last tuesday")` is `Invalid Date`, and a version stamped with one
 * sorts unpredictably against every other — which decides what a charge is
 * priced at.
 */
function checkInstant(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AffiliateAdminError(`"${field}" must be an ISO-8601 date or instant. Got "${raw}".`);
  }
  return parsed.toISOString();
}

function checkStatus(value: unknown): 'active' | 'closed' {
  const status = requireString(value, 'status');
  if (status !== 'active' && status !== 'closed') {
    throw new AffiliateAdminError(`"status" must be "active" or "closed", not "${status}".`);
  }
  return status;
}

/**
 * Terms for a new program: everything defaulted except the two that cannot be.
 *
 * `name` and `commissionRate` have no sensible default — a program with neither
 * is not a program — and everything else takes the shape of the common offer:
 * subscription revenue, no duration cap, no approval step, active.
 */
export function programTermsForCreate(input: ProgramTermsInput, db: Db): ProgramTerms {
  const name = requireString(input.name ?? '', 'name');
  if (name === '') throw new AffiliateAdminError('"name" is required.');
  if (input.commissionRate === undefined) {
    throw new AffiliateAdminError('"commissionRate" is required.');
  }

  return {
    name,
    appId: checkAppId(db, requireString(input.appId ?? '', 'appId')),
    listingUrl: checkListingUrl(requireString(input.listingUrl ?? '', 'listingUrl')),
    commissionRate: checkRate(input.commissionRate),
    revenueComponents: checkRevenueComponents(input.revenueComponents ?? ['subscription']),
    durationMonths: checkOptionalCount(input.durationMonths, 'durationMonths', MAX_DURATION_MONTHS, 1),
    unassignAfterUninstallDays: checkOptionalCount(
      input.unassignAfterUninstallDays,
      'unassignAfterUninstallDays',
      MAX_UNASSIGN_DAYS,
      0,
    ),
    requireApproval: input.requireApproval === true,
    status: input.status === undefined ? 'active' : checkStatus(input.status),
    ...newTerms(input),
  };
}

/**
 * The rules added after the first version of this feature, defaulted to the
 * behaviour that came before them.
 *
 * `enforceUnassignAfterUninstall` defaults **true**, matching the migration and
 * for the same reason: that is what every program has always done, because the
 * engine's only caller passed the flag unconditionally. A default of false here
 * would mean a program created through this API quietly behaves differently
 * from every program created before it.
 */
function newTerms(
  input: ProgramTermsInput,
): Pick<
  ProgramTerms,
  | 'payoutBasis'
  | 'flatAmount'
  | 'flatCurrency'
  | 'recurrence'
  | 'enforceUnassignAfterUninstall'
  | 'minimumPayout'
  | 'termsUrl'
> {
  const payoutBasis =
    input.payoutBasis === undefined ? 'percent_of_gross' : checkPayoutBasis(input.payoutBasis);
  const flatAmount = input.flatAmount === undefined ? 0 : checkAmount(input.flatAmount, 'flatAmount');
  const flatCurrency = checkCurrency(input.flatCurrency, 'flatCurrency');

  // A bounty of nothing is not a bounty, and a bounty with no currency is a
  // number in a portal that means whatever the reader assumes. Both are only
  // refused for the basis that actually uses them, so a percentage program is
  // never asked to fill in a currency it does not have.
  if (payoutBasis === 'flat_per_referral') {
    if (flatAmount <= 0) {
      throw new AffiliateAdminError(
        '"flatAmount" must be greater than zero for a flat_per_referral program.',
      );
    }
    if (flatCurrency === '') {
      throw new AffiliateAdminError(
        '"flatCurrency" is required for a flat_per_referral program. Nothing here converts ' +
          'currencies, so an amount without one cannot be shown to an affiliate.',
      );
    }
  }

  return {
    payoutBasis,
    flatAmount,
    flatCurrency,
    recurrence: input.recurrence === undefined ? 'recurring' : checkRecurrence(input.recurrence),
    enforceUnassignAfterUninstall:
      input.enforceUnassignAfterUninstall === undefined
        ? true
        : input.enforceUnassignAfterUninstall === true,
    minimumPayout:
      input.minimumPayout === undefined ? 0 : checkAmount(input.minimumPayout, 'minimumPayout'),
    termsUrl: checkListingUrl(requireString(input.termsUrl ?? '', 'termsUrl')),
  };
}

/**
 * Terms for an edit: only what was sent is changed.
 *
 * A partial update rather than a replace, because the caller is a settings form
 * and a form that omits a field it did not render would otherwise reset it. The
 * distinction between "absent" and `null` is load-bearing here: `null` is how a
 * duration cap is removed, and it has to survive being told apart from a field
 * the form never sent.
 */
export function programTermsForUpdate(
  input: ProgramTermsInput,
  current: ProgramTerms,
  db: Db,
): ProgramTerms {
  const has = (field: keyof ProgramTermsInput): boolean =>
    Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;

  const name = has('name') ? requireString(input.name, 'name') : current.name;
  if (name === '') throw new AffiliateAdminError('"name" is required.');

  return {
    name,
    appId: has('appId')
      ? checkAppId(db, requireString(input.appId, 'appId'))
      : current.appId,
    listingUrl: has('listingUrl')
      ? checkListingUrl(requireString(input.listingUrl, 'listingUrl'))
      : current.listingUrl,
    commissionRate: has('commissionRate') ? checkRate(input.commissionRate) : current.commissionRate,
    revenueComponents: has('revenueComponents')
      ? checkRevenueComponents(input.revenueComponents)
      : current.revenueComponents,
    durationMonths: has('durationMonths')
      ? checkOptionalCount(input.durationMonths, 'durationMonths', MAX_DURATION_MONTHS, 1)
      : current.durationMonths,
    unassignAfterUninstallDays: has('unassignAfterUninstallDays')
      ? checkOptionalCount(
          input.unassignAfterUninstallDays,
          'unassignAfterUninstallDays',
          MAX_UNASSIGN_DAYS,
          0,
        )
      : current.unassignAfterUninstallDays,
    requireApproval: has('requireApproval')
      ? input.requireApproval === true
      : current.requireApproval,
    status: has('status') ? checkStatus(input.status) : current.status,
    ...newTerms({
      // Carried through the same "absent means unchanged" rule as everything
      // else. Rebuilt from `current` rather than merged field-by-field so the
      // flat-bounty cross-checks in `newTerms` see the whole proposed state:
      // switching a program to a bounty while leaving the amount alone has to
      // fail, and it cannot if the check only ever sees the fields that moved.
      payoutBasis: has('payoutBasis') ? input.payoutBasis : current.payoutBasis,
      flatAmount: has('flatAmount') ? input.flatAmount : current.flatAmount,
      flatCurrency: has('flatCurrency') ? input.flatCurrency : current.flatCurrency,
      recurrence: has('recurrence') ? input.recurrence : current.recurrence,
      enforceUnassignAfterUninstall: has('enforceUnassignAfterUninstall')
        ? input.enforceUnassignAfterUninstall
        : current.enforceUnassignAfterUninstall,
      minimumPayout: has('minimumPayout') ? input.minimumPayout : current.minimumPayout,
      termsUrl: has('termsUrl') ? input.termsUrl : current.termsUrl,
    }),
  };
}

/** Whether any versioned term differs between two validated states. */
export function termsDiffer(before: ProgramTerms, after: ProgramTerms): boolean {
  return VERSIONED_TERMS.some((field) => {
    const a = before[field];
    const b = after[field];
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length !== b.length || a.some((entry, index) => entry !== b[index]);
    }
    return a !== b;
  });
}

/**
 * Refuse a version that would re-price a commission somebody has been paid.
 *
 * A version effective from `T` prices every charge at or after `T`, so it
 * reaches a paid commission exactly when the **latest** paid commission is at
 * or after `T`. The bound is therefore a MAX, not a MIN — an earlier draft of
 * the design said MIN, which would have refused only the edits reaching *every*
 * paid commission and waved through the ones reaching all but the oldest.
 *
 * Refused rather than confirmed. A dialog puts the irreversible outcome behind
 * the same click as the reversible one, at the moment somebody is already sure.
 *
 * This constrains **terms edits only**. A corrected referral date or a late
 * transaction still moves a paid commission's amount and must — those change
 * what was truly earned. The distinction is between changing what the rules
 * were and changing what happened.
 *
 * No index on `affiliate_commissions (program_id)` backs this, deliberately:
 * the table holds a few thousand rows, this runs once per edit, and an index
 * carried for a rare admin write is one the recompute maintains on every sync.
 */
export function assertNoPaidRestatement(
  db: Db,
  programId: string,
  effectiveFrom: string,
): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(earned_at) AS latest
         FROM affiliate_commissions
        WHERE program_id = @programId AND paid_at IS NOT NULL AND cancelled_at IS NULL
          AND earned_at >= @effectiveFrom`,
    )
    .get({ programId, effectiveFrom }) as { n: number; latest: string | null };

  if (row.n > 0) {
    throw new AffiliateAdminError(
      `That change would re-price ${row.n} commission${row.n === 1 ? '' : 's'} that ` +
        `${row.n === 1 ? 'has' : 'have'} already been paid, the most recent earned ` +
        `${String(row.latest).slice(0, 10)}. Set the change to take effect after that date. ` +
        `Payments are a record of money that left; the ledger under them is not rewritten to ` +
        `match a new rate.`,
      409,
    );
  }
}

/* --------------------------------------------------------------- read/write */

/** A stored JSON component list, reported empty rather than guessed at. */
function parseComponents(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
  } catch {
    // A column that will not parse is reported as empty. The edit screen then
    // shows the operator that the stored value is unusable, which is the only
    // honest reading and the one that gets it fixed.
  }
  return [];
}

/** Every recorded version of a program's money terms, oldest first. */
export function listProgramVersions(programId: string, db: Db = getDb()): ProgramTermsVersion[] {
  const rows = db
    .prepare(
      `SELECT id, effective_from AS effectiveFrom, note, created_at AS createdAt,
              payout_basis AS payoutBasis, commission_rate AS commissionRate,
              flat_amount AS flatAmount, flat_currency AS flatCurrency,
              revenue_components AS revenueComponents, recurrence,
              duration_months AS durationMonths,
              unassign_after_uninstall_days AS unassignAfterUninstallDays,
              enforce_unassign_after_uninstall AS enforceUnassign,
              minimum_payout AS minimumPayout, terms_url AS termsUrl
         FROM affiliate_program_terms
        WHERE program_id = ?
        ORDER BY effective_from ASC`,
    )
    .all(programId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    effectiveFrom: String(row.effectiveFrom),
    note: String(row.note ?? ''),
    createdAt: String(row.createdAt),
    payoutBasis: isPayoutBasis(row.payoutBasis) ? row.payoutBasis : 'percent_of_gross',
    commissionRate: Number(row.commissionRate),
    flatAmount: Number(row.flatAmount ?? 0),
    flatCurrency: String(row.flatCurrency ?? ''),
    revenueComponents: parseComponents(row.revenueComponents),
    recurrence: isRecurrence(row.recurrence) ? row.recurrence : 'recurring',
    durationMonths: row.durationMonths === null ? null : Number(row.durationMonths),
    unassignAfterUninstallDays:
      row.unassignAfterUninstallDays === null ? null : Number(row.unassignAfterUninstallDays),
    enforceUnassignAfterUninstall: Number(row.enforceUnassign ?? 1) !== 0,
    minimumPayout: Number(row.minimumPayout ?? 0),
    termsUrl: String(row.termsUrl ?? ''),
  }));
}

/** Write one version row. The only writer of `affiliate_program_terms`. */
function insertVersion(
  db: Db,
  programId: string,
  terms: ProgramTerms,
  effectiveFrom: string,
  note: string,
): void {
  db.prepare(
    `INSERT INTO affiliate_program_terms
       (id, program_id, effective_from, payout_basis, commission_rate, flat_amount,
        flat_currency, revenue_components, recurrence, duration_months,
        unassign_after_uninstall_days, enforce_unassign_after_uninstall,
        minimum_payout, terms_url, note, created_at)
     VALUES
       (@id, @programId, @effectiveFrom, @payoutBasis, @rate, @flatAmount,
        @flatCurrency, @components, @recurrence, @durationMonths,
        @unassignDays, @enforceUnassign,
        @minimumPayout, @termsUrl, @note, @now)`,
  ).run({
    id: randomUUID(),
    programId,
    effectiveFrom,
    payoutBasis: terms.payoutBasis,
    rate: terms.commissionRate,
    flatAmount: terms.flatAmount,
    flatCurrency: terms.flatCurrency,
    components: JSON.stringify(terms.revenueComponents),
    recurrence: terms.recurrence,
    durationMonths: terms.durationMonths,
    unassignDays: terms.unassignAfterUninstallDays,
    enforceUnassign: terms.enforceUnassignAfterUninstall ? 1 : 0,
    minimumPayout: terms.minimumPayout,
    termsUrl: terms.termsUrl,
    note,
    now: new Date().toISOString(),
  });
}

export function getProgram(programId: string, db: Db = getDb()): ProgramRecord | null {
  const row = db
    .prepare(
      `SELECT p.id, p.app_id AS appId, p.name, p.listing_url AS listingUrl,
              p.commission_rate AS commissionRate, p.revenue_components AS revenueComponents,
              p.duration_months AS durationMonths,
              p.unassign_after_uninstall_days AS unassignAfterUninstallDays,
              p.require_approval AS requireApproval, p.status,
              p.payout_basis AS payoutBasis, p.flat_amount AS flatAmount,
              p.flat_currency AS flatCurrency, p.recurrence,
              p.enforce_unassign_after_uninstall AS enforceUnassign,
              p.minimum_payout AS minimumPayout, p.terms_url AS termsUrl,
              p.external_id AS externalId, p.created_at AS createdAt, p.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM affiliate_memberships m
                WHERE m.program_id = p.id AND m.status = 'enrolled') AS affiliates
         FROM affiliate_programs p WHERE p.id = ?`,
    )
    .get(programId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const components = parseComponents(row.revenueComponents);

  return {
    id: String(row.id),
    appId: String(row.appId ?? ''),
    name: String(row.name ?? ''),
    listingUrl: String(row.listingUrl ?? ''),
    commissionRate: Number(row.commissionRate),
    revenueComponents: components,
    durationMonths: row.durationMonths === null ? null : Number(row.durationMonths),
    unassignAfterUninstallDays:
      row.unassignAfterUninstallDays === null ? null : Number(row.unassignAfterUninstallDays),
    requireApproval: Number(row.requireApproval) === 1,
    status: String(row.status) === 'closed' ? 'closed' : 'active',
    externalId: String(row.externalId ?? ''),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    affiliates: Number(row.affiliates ?? 0),
    payoutBasis: isPayoutBasis(row.payoutBasis) ? row.payoutBasis : 'percent_of_gross',
    flatAmount: Number(row.flatAmount ?? 0),
    flatCurrency: String(row.flatCurrency ?? ''),
    recurrence: isRecurrence(row.recurrence) ? row.recurrence : 'recurring',
    enforceUnassignAfterUninstall: Number(row.enforceUnassign ?? 1) !== 0,
    minimumPayout: Number(row.minimumPayout ?? 0),
    termsUrl: String(row.termsUrl ?? ''),
    versions: listProgramVersions(programId, db),
  };
}

/**
 * Create a program.
 *
 * The id is minted here rather than taken from the caller. An operator-supplied
 * id is a way to collide with an existing program or to resurrect a deleted
 * one, and nothing downstream needs the id to mean anything — `external_id` is
 * where an imported program keeps its origin, and this route never sets it.
 *
 * One app may carry more than one program, and this does not stop it: a program
 * that supersedes another on the same listing is a normal thing to want, and
 * the redirect resolves a click by membership rather than by app. What it does
 * refuse is a second program with the *same name* on the same app, which is
 * never intentional and is what a double-submitted form produces.
 */
export function createProgram(input: ProgramTermsInput, db: Db = getDb()): ProgramRecord {
  const terms = programTermsForCreate(input, db);

  const clash = db
    .prepare('SELECT id FROM affiliate_programs WHERE name = ? AND app_id = ?')
    .get(terms.name, terms.appId) as { id: string } | undefined;
  if (clash) {
    throw new AffiliateAdminError(
      `A program named "${terms.name}" already exists for this app.`,
      409,
    );
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  // The program row and its first version in one transaction. A program with no
  // version would price every charge against the "no terms recorded" fallback,
  // which works and records the wrong story; a version with no program is a
  // foreign key violation. Neither half is useful alone.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO affiliate_programs (id, app_id, name, listing_url, commission_rate,
                                       revenue_components, duration_months,
                                       unassign_after_uninstall_days, require_approval,
                                       status, payout_basis, flat_amount, flat_currency,
                                       recurrence, enforce_unassign_after_uninstall,
                                       minimum_payout, terms_url,
                                       external_id, created_at, updated_at)
       VALUES (@id, @appId, @name, @listingUrl, @rate, @components, @durationMonths,
               @unassignDays, @requireApproval, @status, @payoutBasis, @flatAmount,
               @flatCurrency, @recurrence, @enforceUnassign, @minimumPayout, @termsUrl,
               '', @now, @now)`,
    ).run({
      id,
      appId: terms.appId,
      name: terms.name,
      listingUrl: terms.listingUrl,
      rate: terms.commissionRate,
      components: JSON.stringify(terms.revenueComponents),
      durationMonths: terms.durationMonths,
      unassignDays: terms.unassignAfterUninstallDays,
      requireApproval: terms.requireApproval ? 1 : 0,
      status: terms.status,
      payoutBasis: terms.payoutBasis,
      flatAmount: terms.flatAmount,
      flatCurrency: terms.flatCurrency,
      recurrence: terms.recurrence,
      enforceUnassign: terms.enforceUnassignAfterUninstall ? 1 : 0,
      minimumPayout: terms.minimumPayout,
      termsUrl: terms.termsUrl,
      now,
    });

    // Effective from the program's own creation, not from "now" a millisecond
    // later, so a charge stamped at the same instant as the program is priced
    // by it rather than falling before every recorded version.
    insertVersion(db, id, terms, now, 'Terms at creation.');
  })();

  const created = getProgram(id, db);
  if (!created) throw new AffiliateAdminError('Program was not created.', 500);
  return created;
}

/**
 * Edit a program's terms.
 *
 * `external_id` and `created_at` are never touched. The first is the join key a
 * re-import matches on, and rewriting it would strand every row that came in
 * under the old one; the second is a fact about the past.
 *
 * This changes money, and it changes it **forwards**. A change to any versioned
 * term writes a new row in `affiliate_program_terms` effective from now, and
 * the engine prices each charge against the version in force when that charge
 * occurred — so an edit moves what referrals earn from here on and leaves what
 * they have already earned exactly where it is.
 *
 * That is a change from how this function used to behave. It restated the whole
 * history of the program on every edit, which was defensible while terms could
 * only be changed by editing a row by hand and is not once a dashboard button
 * does it: the recompute would re-price commissions that had already been paid,
 * and the reconciliation report — whose job is to surface a handful of real
 * discrepancies — would fill with differences that are not real.
 *
 * An operator who genuinely means to correct the past passes `effectiveFrom`.
 * That path is bounded by `assertNoPaidRestatement`.
 *
 * The router still recomputes inline and answers with the difference, because
 * an edit that changes future earnings should say so at the moment it is made
 * rather than on the next sync.
 */
export function updateProgram(
  programId: string,
  input: ProgramTermsInput,
  db: Db = getDb(),
): ProgramRecord {
  const current = getProgram(programId, db);
  if (!current) {
    throw new AffiliateAdminError(`No program with id ${programId}.`, 404);
  }

  const terms = programTermsForUpdate(input, current, db);

  if (terms.name !== current.name || terms.appId !== current.appId) {
    const clash = db
      .prepare('SELECT id FROM affiliate_programs WHERE name = ? AND app_id = ? AND id <> ?')
      .get(terms.name, terms.appId, programId) as { id: string } | undefined;
    if (clash) {
      throw new AffiliateAdminError(
        `A program named "${terms.name}" already exists for this app.`,
        409,
      );
    }
  }

  const now = new Date().toISOString();

  /*
   * `effectiveFrom` defaults to now, which is what makes the ordinary edit
   * safe: every paid commission is in the past, so the guard below never fires
   * on one. It only bites when somebody deliberately backdates.
   */
  const backdating = input.effectiveFrom !== undefined && input.effectiveFrom !== null;
  const effectiveFrom = backdating ? checkInstant(input.effectiveFrom, 'effectiveFrom') : now;

  /*
   * A version is written when the terms moved — or when the operator named an
   * instant, even if the values match what the program already says.
   *
   * The second half is not a technicality. Supplying `effectiveFrom` is an
   * assertion about history: "these were the terms from this date". An operator
   * who fixes a rate today and then realises it should have applied since
   * launch sends the same rate with an earlier date, and under a
   * values-only comparison that request would be a silent no-op — the screen
   * would report success and nothing would move.
   */
  const changed = termsDiffer(current, terms) || backdating;

  if (changed) assertNoPaidRestatement(db, programId, effectiveFrom);

  db.transaction(() => {
    db.prepare(
      `UPDATE affiliate_programs
          SET app_id = @appId, name = @name, listing_url = @listingUrl,
              commission_rate = @rate, revenue_components = @components,
              duration_months = @durationMonths,
              unassign_after_uninstall_days = @unassignDays,
              require_approval = @requireApproval, status = @status,
              payout_basis = @payoutBasis, flat_amount = @flatAmount,
              flat_currency = @flatCurrency, recurrence = @recurrence,
              enforce_unassign_after_uninstall = @enforceUnassign,
              minimum_payout = @minimumPayout, terms_url = @termsUrl,
              updated_at = @now
        WHERE id = @id`,
    ).run({
      id: programId,
      appId: terms.appId,
      name: terms.name,
      listingUrl: terms.listingUrl,
      rate: terms.commissionRate,
      components: JSON.stringify(terms.revenueComponents),
      durationMonths: terms.durationMonths,
      unassignDays: terms.unassignAfterUninstallDays,
      requireApproval: terms.requireApproval ? 1 : 0,
      status: terms.status,
      payoutBasis: terms.payoutBasis,
      flatAmount: terms.flatAmount,
      flatCurrency: terms.flatCurrency,
      recurrence: terms.recurrence,
      enforceUnassign: terms.enforceUnassignAfterUninstall ? 1 : 0,
      minimumPayout: terms.minimumPayout,
      termsUrl: terms.termsUrl,
      now,
    });

    /*
     * A version only when a versioned term actually moved. Renaming a program
     * or pointing it at a different listing is not a change to what anybody
     * earns, and writing a version for it would fill the history strip with
     * rows that all say the same rate — which is how a history nobody reads
     * gets built.
     *
     * Replacing rather than inserting when a version already occupies this
     * instant: the unique index refuses the collision, and the operator's
     * intent when they submit twice against one `effectiveFrom` is the second
     * value, not an error about an index.
     */
    if (changed) {
      db.prepare(
        'DELETE FROM affiliate_program_terms WHERE program_id = ? AND effective_from = ?',
      ).run(programId, effectiveFrom);
      insertVersion(
        db,
        programId,
        terms,
        effectiveFrom,
        typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '',
      );
    }
  })();

  const updated = getProgram(programId, db);
  if (!updated) throw new AffiliateAdminError('Program was not updated.', 500);
  return updated;
}

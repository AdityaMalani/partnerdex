import type { Db } from '../db/index.js';
import type { PartnerOrg } from '../config.js';

/**
 * Organizations as rows, and the one rule that shapes every function here: the
 * access token goes in and never comes out.
 *
 * `readOrganization` and `listOrganizations` return the token because the sync
 * needs it to open an endpoint. `describeOrganization` is the only shape any
 * reader — an API response, a log line, the dashboard — is ever given, and it
 * carries a four-character hint instead. Nothing in `src/server` may return a
 * value from the first pair without passing it through the second.
 *
 * ## How the token is stored, and what that does and does not buy
 *
 * It is stored as it arrives: plaintext, in the same SQLite file as everything
 * else, with the file mode taken down to 0600 by `restrictFileMode`.
 *
 * That is a deliberate choice rather than an omission, and the case for it is
 * that the alternatives available here are theatre. Encrypting the column with
 * a key held in the same environment as the process protects against exactly
 * one thing — someone who can read the database file but not the environment —
 * and buys it at the cost of a key that can be lost, which turns a rotation
 * mistake into an outage. Nothing in this product can hold a key the process
 * cannot reach, because the process has to open the endpoint unattended every
 * five minutes.
 *
 * So, plainly:
 *
 *   - **Protected against**: another local account reading the file (0600); the
 *     token appearing in an API response, a log line, an error message or the
 *     frontend bundle (this module, and the tests that assert it); a token
 *     being displayed back to whoever is at the keyboard once it is stored.
 *   - **Not protected against**: anyone who can read the database file as the
 *     owning user, take a copy of the volume, or run code in this process. Any
 *     of those already yields every merchant's revenue history, the BigQuery
 *     service-account key and every affiliate's payout address. The Partner
 *     token is not the weakest thing in this file and encrypting it alone would
 *     not make the file safer — it would only make the claim harder to check.
 *
 * The one property worth having, and the one this file actually enforces, is
 * that the token is write-only from outside the process.
 */

export class OrganizationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'OrganizationError';
  }
}

/** Where a row came from. `env` rows were seeded from `PARTNER_ORG_<n>_*`. */
export type OrganizationSource = 'env' | 'manual';

/** The whole row, token included. Only the sync and this module read this. */
export interface Organization {
  id: string;
  label: string;
  token: string;
  tokenHint: string;
  source: OrganizationSource;
  /** Set when the organization has been removed. The row and its data stay. */
  disabledAt: string | null;
  checkedAt: string | null;
  /** What the last check found, in one line. Null when it failed. */
  checkNote: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Everything about an organization that may leave the server. */
export interface OrganizationView {
  id: string;
  label: string;
  /** Last four characters of the token, or '' when none is stored. */
  tokenHint: string;
  hasToken: boolean;
  source: OrganizationSource;
  disabledAt: string | null;
  checkedAt: string | null;
  checkNote: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrganizationRow {
  id: string;
  label: string;
  token: string;
  token_hint: string;
  source: string;
  disabled_at: string | null;
  checked_at: string | null;
  check_note: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Enough of the token to tell two of them apart, and not enough to use.
 *
 * Four characters of a token that is dozens long. Shorter than the BigQuery key
 * hint beside it because a Partner token has no structure to lean on — no key
 * id, no account email — so the hint is cut from the secret itself and every
 * character shown is a character given away.
 */
export function tokenHint(token: string): string {
  const trimmed = token.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : '';
}

/** The numeric organization id from the Partner dashboard URL, or a refusal. */
export function assertOrganizationId(raw: string): string {
  const id = raw.trim().split('/').pop()?.trim() ?? '';
  if (!/^\d+$/.test(id)) {
    throw new OrganizationError(
      `The organization id is the number in your Partner dashboard URL ` +
        `(partners.shopify.com/<id>). Got "${raw}".`,
    );
  }
  return id;
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    label: row.label || row.id,
    token: row.token,
    tokenHint: row.token_hint,
    source: row.source === 'env' ? 'env' : 'manual',
    disabledAt: row.disabled_at,
    checkedAt: row.checked_at,
    checkNote: row.check_note,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The row with the secret taken out. The only shape a reader is given. */
export function describeOrganization(org: Organization): OrganizationView {
  const { token, ...rest } = org;
  return { ...rest, hasToken: token.length > 0 };
}

export function listOrganizations(db: Db): Organization[] {
  /*
   * Removed ones last, then oldest first — and `rowid` rather than `id` as the
   * tie-break, because it is insertion order.
   *
   * That matters for exactly one reason and it is worth stating: the whole
   * environment seed is written in a single transaction, so every row it
   * creates carries the same `created_at`. Breaking that tie on the id would
   * reorder the organizations by their number, and the order they were declared
   * in is the order the sync visits them and the order the dashboard lists them.
   */
  const rows = db
    .prepare('SELECT * FROM organizations ORDER BY disabled_at IS NOT NULL, created_at, rowid')
    .all() as OrganizationRow[];
  return rows.map(toOrganization);
}

export function readOrganization(db: Db, id: string): Organization | null {
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
    | OrganizationRow
    | undefined;
  return row ? toOrganization(row) : null;
}

export interface SaveOrganizationInput {
  id: string;
  label?: string;
  /**
   * Absent on an edit that only changes the label, which is the common case and
   * must not require re-pasting a token that is already stored. Present and
   * empty is refused rather than treated as "clear it" — clearing a credential
   * is what removal is for, and it should not be reachable by an empty field.
   */
  token?: string;
  source?: OrganizationSource;
}

/**
 * Create or update one organization.
 *
 * Saving re-enables a removed organization, which is the way back from a
 * mistaken removal: the row was never deleted, its apps still carry its id, and
 * its watermarks are untouched, so the next sync resumes where it stopped
 * rather than re-walking history.
 *
 * A save clears the last check, for the same reason the BigQuery connection
 * does: the value just entered may well be what broke it, and a green tick from
 * the previous credential is worse than no tick at all.
 */
export function saveOrganization(db: Db, input: SaveOrganizationInput): Organization {
  const id = assertOrganizationId(input.id);
  const existing = readOrganization(db, id);

  const token = input.token === undefined ? (existing?.token ?? '') : input.token.trim();
  if (!token) {
    throw new OrganizationError(
      `Organization ${id} needs an access token. Create one in the Partner dashboard under ` +
        `Settings → API access, with "View financials" and "Manage apps".`,
    );
  }

  const label = (input.label ?? existing?.label ?? '').trim();
  const now = new Date().toISOString();
  const tokenChanged = token !== existing?.token;

  db.prepare(
    `INSERT INTO organizations (
       id, label, token, token_hint, source, disabled_at,
       checked_at, check_note, last_error, created_at, updated_at
     ) VALUES (
       @id, @label, @token, @tokenHint, @source, NULL,
       NULL, NULL, NULL, @now, @now
     )
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       token = excluded.token,
       token_hint = excluded.token_hint,
       -- A row seeded from the environment and then edited here is no longer an
       -- environment row: it is one somebody has taken over, and the seed must
       -- not reclaim it. The source column therefore only moves towards 'manual'.
       source = CASE WHEN excluded.source = 'env' THEN organizations.source ELSE 'manual' END,
       disabled_at = NULL,
       checked_at = CASE WHEN @tokenChanged THEN NULL ELSE organizations.checked_at END,
       check_note = CASE WHEN @tokenChanged THEN NULL ELSE organizations.check_note END,
       last_error = CASE WHEN @tokenChanged THEN NULL ELSE organizations.last_error END,
       updated_at = excluded.updated_at`,
  ).run({
    id,
    label,
    token,
    tokenHint: tokenHint(token),
    source: input.source ?? 'manual',
    now,
    tokenChanged: tokenChanged ? 1 : 0,
  });

  return readOrganization(db, id)!;
}

/**
 * Remove an organization: stop syncing it, forget its credential, keep every
 * row it ever produced.
 *
 * Deliberately not a DELETE, and the reason is in the numbers. The production
 * store holds millions of transactions and events attributed to an
 * organization's apps, none of which the Partner API will re-serve quickly —
 * the backfill that produced them ran for hours. Deleting them because a token
 * was removed would be an irreversible answer to a reversible request. Nor are
 * they orphaned: `apps.org_id` still points at this row, so every app keeps a
 * name and every report keeps counting it.
 *
 * What does go is the token, immediately. "Removed" has to mean the credential
 * is no longer held, or the word is doing no work.
 */
export function removeOrganization(db: Db, id: string): Organization | null {
  const existing = readOrganization(db, id);
  if (!existing) return null;

  db.prepare(
    `UPDATE organizations
        SET token = '', token_hint = '', disabled_at = @now, updated_at = @now,
            checked_at = NULL, check_note = NULL, last_error = NULL
      WHERE id = @id`,
  ).run({ id, now: new Date().toISOString() });

  return readOrganization(db, id);
}

/** Records what a verification found, on the row itself. */
export function recordCheck(
  db: Db,
  id: string,
  outcome: { note: string | null; error: string | null },
): void {
  db.prepare(
    `UPDATE organizations
        SET checked_at = @at, check_note = @note, last_error = @error
      WHERE id = @id`,
  ).run({ id, at: new Date().toISOString(), note: outcome.note, error: outcome.error });
}

/**
 * Seed the table from `PARTNER_ORG_<n>_*`, and never overwrite what is there.
 *
 * The reconciliation rule, stated once: **the environment seeds, the database
 * decides.** An organization the environment names and the table does not is
 * inserted. An organization both of them name is left exactly as the table has
 * it — token included.
 *
 * That direction rather than the other one, for two reasons. The dashboard is
 * the surface this feature exists to provide, and a table the environment
 * silently reasserted on every boot would make every edit in it a lie that
 * survives until the next restart. And an operator who has rotated a token in
 * the UI has, by doing so, said which of the two they mean; a `fly secrets` value
 * left over from the bootstrap has said nothing since the first boot. Where the
 * two disagree the dashboard says so rather than resolving it in silence — see
 * `envDiffers` in the organizations router.
 *
 * A removed organization is not re-seeded. `disabled_at` is a decision, and the
 * environment variable that predates it is not an argument against it; the row
 * exists, so the "insert what is missing" rule does not fire. Removing an
 * organization whose credential is still in the environment therefore sticks
 * across restarts, which is the only behaviour that makes the button honest.
 */
export function seedOrganizationsFromEnv(db: Db, envOrgs: PartnerOrg[]): number {
  if (envOrgs.length === 0) return 0;

  const insert = db.prepare(
    `INSERT INTO organizations (
       id, label, token, token_hint, source, disabled_at,
       checked_at, check_note, last_error, created_at, updated_at
     ) VALUES (
       @id, @label, @token, @tokenHint, 'env', NULL, NULL, NULL, NULL, @now, @now
     )
     ON CONFLICT(id) DO NOTHING`,
  );

  const now = new Date().toISOString();
  let seeded = 0;
  db.transaction(() => {
    for (const org of envOrgs) {
      const result = insert.run({
        id: org.organizationId,
        label: org.label === org.organizationId ? '' : org.label,
        token: org.token,
        tokenHint: tokenHint(org.token),
        now,
      });
      if (result.changes > 0) seeded += 1;
    }
  })();
  return seeded;
}

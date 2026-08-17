import { getDb, type Db } from '../db/index.js';
import { AffiliateAdminError } from './admin.js';
import { HANDLE_SHAPE } from './ga4Attribution.js';
import { generateHandle } from './signup.js';
import { upsertAffiliate, upsertMembership } from './store.js';

/**
 * Creating and editing an affiliate from the dashboard.
 *
 * This is the verb that did not exist. Until now there were exactly two ways an
 * affiliate could come into being: the Mantle import, which is a one-off that
 * will never run on a fresh install, and public self-signup, which requires the
 * person to find the portal and apply. An operator who wanted to add a partner
 * they had just agreed terms with over email had no supported way to do it —
 * which is most of what "half baked" meant, because it makes the very first
 * step of running a program something you cannot do from the product.
 *
 * Everything here is deliberately thin. An affiliate is a ledger record and a
 * membership is an enrolment; both already have well-tested writers in
 * `store.ts`, and this module is the validation and the sequencing in front of
 * them, not a second way to write those rows.
 *
 * ## What this must not become
 *
 * A create that also sets a password. The set-password token is minted by
 * `issueSetPasswordLink` and delivered through the one seam that exists for it,
 * and the route hands it back to the operator. Adding a `password` field here
 * would put a credential the affiliate never chose into a dashboard request
 * body, and it would be the second place in the codebase that writes
 * `affiliate_credentials`.
 */

/** What the dashboard sends to create or edit an affiliate. */
export interface AffiliateAdminInput {
  name?: unknown;
  email?: unknown;
  paypalEmail?: unknown;
  status?: unknown;
  payoutHold?: unknown;
  /** Optional: enrol them in this program at the same time. */
  programId?: unknown;
  /** Their `?mref=` code. Generated when absent. */
  handle?: unknown;
}

export interface AffiliateRecord {
  id: string;
  name: string;
  email: string;
  paypalEmail: string;
  status: 'active' | 'disabled';
  payoutHold: boolean;
  createdAt: string;
}

/**
 * The handle shape, and the one place a new one is checked against it.
 *
 * Imported from the attribution parser rather than restated, for the same
 * reason the redirect imports it: three of the four places that know this shape
 * already share a source, and a fourth spelling of it is how a handle that the
 * redirect resolves stops matching the one the pipeline looks for.
 */
export { HANDLE_SHAPE } from './ga4Attribution.js';

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new AffiliateAdminError(`"${field}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AffiliateAdminError(`"${field}" must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/**
 * An address, checked for shape and nothing more.
 *
 * Deliberately not checked for uniqueness. The imported data holds one address
 * across two affiliate accounts, each with its own handle and its own referrals,
 * and the column is indexed but not unique precisely so that stays
 * representable — a create that refused a duplicate would be this screen
 * inventing a rule the business never had, and would make one of those two
 * people unrecreatable if their row were ever lost.
 */
function checkEmail(value: unknown, field: string, required: boolean): string {
  const raw = requireText(value ?? '', field, 320);
  if (raw === '') {
    if (required) throw new AffiliateAdminError(`"${field}" is required.`);
    return '';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
    throw new AffiliateAdminError(`"${field}" does not look like an email address.`);
  }
  return raw;
}

function checkStatus(value: unknown): 'active' | 'disabled' {
  if (value === undefined) return 'active';
  if (value !== 'active' && value !== 'disabled') {
    throw new AffiliateAdminError(`"status" must be "active" or "disabled".`);
  }
  return value;
}

export function getAffiliateRecord(affiliateId: string, db: Db = getDb()): AffiliateRecord | null {
  const row = db
    .prepare(
      `SELECT id, name, email, paypal_email AS paypalEmail, status,
              payout_hold AS payoutHold, created_at AS createdAt
         FROM affiliates WHERE id = ?`,
    )
    .get(affiliateId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    email: String(row.email ?? ''),
    paypalEmail: String(row.paypalEmail ?? ''),
    status: String(row.status) === 'disabled' ? 'disabled' : 'active',
    payoutHold: Number(row.payoutHold ?? 0) === 1,
    createdAt: String(row.createdAt),
  };
}

export interface CreatedAffiliate {
  affiliate: AffiliateRecord;
  /** Set when a program was named. */
  membership: { programId: string; handle: string; status: string } | null;
}

/**
 * Create an affiliate, optionally enrolling them in a program.
 *
 * The enrolment is part of the same call rather than a second request, because
 * an affiliate with no membership has no handle, and an affiliate with no handle
 * has no link — which is the entire reason an operator is on this screen. Making
 * it two steps means the obvious first path through a fresh install ends with a
 * partner record that cannot earn and no indication of what is missing.
 *
 * A membership created here is `enrolled` outright, and that is not the same
 * decision `require_approval` governs. That flag exists to hold *applicants* —
 * strangers arriving through the public signup form — at the door. An operator
 * typing somebody's name into the dashboard has already made the decision the
 * queue exists to collect, and routing them into their own approval queue would
 * be the product asking a person to confirm something they just did.
 */
export function createAffiliate(input: AffiliateAdminInput, db: Db = getDb()): CreatedAffiliate {
  const name = requireText(input.name ?? '', 'name', 200);
  if (name === '') throw new AffiliateAdminError('"name" is required.');
  const email = checkEmail(input.email, 'email', true);
  const paypalEmail = checkEmail(input.paypalEmail, 'paypalEmail', false);
  const status = checkStatus(input.status);

  const programId = requireText(input.programId ?? '', 'programId', 100);
  let program: { id: string } | undefined;
  if (programId !== '') {
    program = db.prepare('SELECT id FROM affiliate_programs WHERE id = ?').get(programId) as
      | { id: string }
      | undefined;
    if (!program) throw new AffiliateAdminError(`No program with id ${programId}.`, 404);
  }

  const result = db.transaction(() => {
    const affiliateId = upsertAffiliate(
      {
        name,
        email,
        paypalEmail,
        status,
        payoutHold: input.payoutHold === true,
        source: 'admin',
      },
      db,
    );

    if (!program) return { affiliateId, membership: null };

    // A supplied handle is checked against the same shape the redirect and the
    // GA4 parser enforce. A handle outside it is not a cosmetic problem: the
    // redirect 404s anything that fails the pattern, so the link would simply
    // not work, and the pipeline would never match a click carrying it.
    let handle = requireText(input.handle ?? '', 'handle', 64).toLowerCase();
    if (handle === '') {
      handle = generateHandle(db, program.id);
    } else if (!HANDLE_SHAPE.test(handle)) {
      throw new AffiliateAdminError(
        `"handle" must be eight lowercase letters or digits. That is the shape ` +
          `/r/:handle resolves and the attribution pipeline matches; anything else ` +
          `is a link that does not work.`,
      );
    } else {
      const taken = db
        .prepare('SELECT id FROM affiliate_memberships WHERE program_id = ? AND handle = ?')
        .get(program.id, handle) as { id: string } | undefined;
      if (taken) {
        throw new AffiliateAdminError(`Handle "${handle}" is already used on this program.`, 409);
      }
    }

    const now = new Date().toISOString();
    upsertMembership(
      {
        affiliateId,
        programId: program.id,
        handle,
        status: 'enrolled',
        joinedAt: now,
        approvedAt: now,
      },
      db,
    );

    return { affiliateId, membership: { programId: program.id, handle, status: 'enrolled' } };
  })();

  const affiliate = getAffiliateRecord(result.affiliateId, db);
  if (!affiliate) throw new AffiliateAdminError('Affiliate was not created.', 500);
  return { affiliate, membership: result.membership };
}

/**
 * Edit an affiliate. Partial, like the program editor, and for the same reason.
 *
 * `status` and `payoutHold` are the two that matter and they are different
 * things, which is why both are here rather than one standing in for the other.
 * Disabling an affiliate stops their handle resolving on the redirect;
 * `payoutHold` stops nothing at all — commissions keep accruing and the ledger
 * keeps saying what is owed — it records that somebody has decided not to pay
 * yet. Collapsing them would either withdraw earnings from somebody who is
 * merely under review, or keep sending clicks to a partner who has left.
 */
export function updateAffiliate(
  affiliateId: string,
  input: AffiliateAdminInput,
  db: Db = getDb(),
): AffiliateRecord {
  const current = getAffiliateRecord(affiliateId, db);
  if (!current) throw new AffiliateAdminError(`No affiliate with id ${affiliateId}.`, 404);

  const has = (field: keyof AffiliateAdminInput): boolean =>
    Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;

  const name = has('name') ? requireText(input.name, 'name', 200) : current.name;
  if (name === '') throw new AffiliateAdminError('"name" is required.');

  upsertAffiliate(
    {
      // `upsertAffiliate` keys on `external_id` or a fresh uuid, so an edit has
      // to go through the id it already has. Passing the record's own id keeps
      // this one writer rather than adding a second UPDATE statement that would
      // have to be kept in step with it.
      id: affiliateId,
      name,
      email: has('email') ? checkEmail(input.email, 'email', true) : current.email,
      paypalEmail: has('paypalEmail')
        ? checkEmail(input.paypalEmail, 'paypalEmail', false)
        : current.paypalEmail,
      status: has('status') ? checkStatus(input.status) : current.status,
      payoutHold: has('payoutHold') ? input.payoutHold === true : current.payoutHold,
    },
    db,
  );

  const updated = getAffiliateRecord(affiliateId, db);
  if (!updated) throw new AffiliateAdminError('Affiliate was not updated.', 500);
  return updated;
}

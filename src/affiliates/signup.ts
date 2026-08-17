import crypto from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { upsertAffiliate, upsertMembership, type MembershipStatus } from './store.js';

/**
 * Self-signup: how somebody who is not yet an affiliate becomes one.
 *
 * Everything in the affiliate ledger until now arrived by import. There were
 * hundreds of partners and no way to become the next one, which is a program
 * that can only shrink. This is the front door, and it is the first place in this system where
 * an untrusted stranger writes a row.
 *
 * The rules it holds to, each of which has a way of being quietly wrong:
 *
 *   1. **Approval is read from the program, never assumed.** `require_approval`
 *      is true for Stoq and false for Filemonk today, and the difference is not
 *      cosmetic: a Stoq applicant becomes `pending` and gets no working link,
 *      because the attribution pipeline credits only `enrolled` memberships. An
 *      applicant handed a link they cannot earn from would promote it, send us
 *      real installs, and be paid nothing — a failure that is silent on both
 *      sides until somebody asks why a balance never moved. Which program needs
 *      approval is a column, so a third program can arrive without a code change
 *      and an operator flipping the flag takes effect immediately.
 *
 *   2. **One person is one affiliate row.** An existing affiliate applying to a
 *      second program attaches a membership to the account they already have.
 *      The alternative — a second `affiliates` row — splits their commissions
 *      across two balances that nothing joins back together, and the person is
 *      paid twice or half.
 *
 *   3. **A membership that already exists is never rewritten.** Including a
 *      rejected one. Re-applying must not be a way to walk around a decision an
 *      admin already made, and there are rejected memberships in the ledger
 *      today for whom that matters.
 *
 * What this module deliberately does *not* do: mint credentials, answer a
 * request, or decide what a stranger is told. Password setting reuses the
 * existing set-password token flow and the response shape is the router's
 * problem — see `src/server/signup.ts`, where the rule that signup must not
 * disclose whether an address is already ours actually lives.
 */

export class SignupError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SignupError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ limits */

/**
 * Bounds on every attacker-controlled field, chosen to be generous to people and
 * boring to a script.
 *
 * These are not validation for its own sake. Each value is stored, and two of
 * them (`name`, `email`) end up in an operator's inbox and in log lines, so an
 * unbounded string here is somebody else's problem later.
 */
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254; // The longest address SMTP will carry.
const MAX_PROGRAMS_PER_APPLICATION = 8;

/**
 * What counts as a plausible address.
 *
 * Deliberately not an RFC 5322 parser. The purpose is not to prove an address is
 * deliverable — only delivery proves that — but to reject the shapes that cause
 * trouble downstream: no whitespace of any kind (so it can never inject a line
 * into a log), exactly one `@`, and a dotted host. A real address this refuses is
 * a support ticket; a log-injection payload it accepts is an incident, and the
 * asymmetry is why this errs strict.
 */
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/* ------------------------------------------------------------------ handles */

/**
 * The alphabet and length the existing handles use: eight lowercase
 * alphanumerics. Matched exactly, because `HANDLE_SHAPE` in the GA4 parser and
 * the `/r/:handle` route both refuse anything else — a generator that drifted
 * from it would mint links that this system's own redirect route 404s.
 */
const HANDLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HANDLE_LENGTH = 8;

/**
 * How many times to re-roll before giving up.
 *
 * 36^8 is 2.8 × 10^12, against the handles already in use, so the chance that
 * any one draw collides is on the order of 10^-10 and twenty consecutive
 * collisions is not a number worth writing down. The retry is not really for
 * collisions — it is so that the day something *is* wrong (a truncated random
 * source, a test double returning a constant) it fails loudly with a message
 * that says what happened, rather than looping until the request times out.
 */
const HANDLE_ATTEMPTS = 20;

/**
 * Eight random alphanumerics, without modulo bias.
 *
 * 36 does not divide 256, so `byte % 36` would make the first four letters of
 * the alphabet ~14% more likely than the rest. Rejection sampling of the values
 * at or above the largest multiple of 36 removes that. The bias would not be a
 * security problem at this scale — a handle is a public identifier, not a secret
 * — but it costs one comparison to not have, and a biased generator is the kind
 * of thing that gets copied into somewhere it does matter.
 */
function randomHandle(): string {
  const limit = 256 - (256 % HANDLE_ALPHABET.length);
  let handle = '';
  while (handle.length < HANDLE_LENGTH) {
    for (const byte of crypto.randomBytes(HANDLE_LENGTH)) {
      if (byte >= limit) continue;
      handle += HANDLE_ALPHABET[byte % HANDLE_ALPHABET.length];
      if (handle.length === HANDLE_LENGTH) break;
    }
  }
  return handle;
}

/**
 * A handle no membership of this program holds.
 *
 * Uniqueness is per program and **not** global, which is what the unique index
 * `(program_id, handle)` says and what the imported data requires: two affiliates
 * legitimately hold the same handle in both Stoq and Filemonk, and a global
 * constraint would have rejected them at import. So this checks the pair.
 *
 * The read-then-write is safe here for a reason worth stating rather than
 * assuming, because "check then insert" is usually a race: `better-sqlite3` is
 * synchronous and this process has one connection, and every caller runs inside
 * the transaction in `applyForSignup`, so nothing can insert between the check
 * and the write. The unique index is still the actual guarantee — if that
 * reasoning ever stops holding, the insert fails loudly instead of minting a
 * duplicate link that would credit one affiliate's clicks to another.
 *
 * Note what this does not do: reuse the applicant's handle from another program.
 * The two imported affiliates who share one across programs are the reason
 * `destinationFor` has to guess which listing a click meant. New signups get a
 * distinct handle per program, so that ambiguity does not grow.
 */
export function generateHandle(db: Db, programId: string): string {
  const taken = db.prepare(
    'SELECT 1 FROM affiliate_memberships WHERE program_id = ? AND handle = ?',
  );

  for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
    const handle = randomHandle();
    // The column collates NOCASE, so this comparison and the unique index agree
    // on case. Generated handles are lowercase anyway; the collation matters for
    // the imported ones a person may have retyped.
    if (!taken.get(programId, handle)) return handle;
  }

  throw new SignupError(
    `Could not allocate a referral handle for program ${programId} after ` +
      `${HANDLE_ATTEMPTS} attempts. That is not a collision at this table size — ` +
      `check the random source.`,
    500,
  );
}

/* ------------------------------------------------------------------ programs */

export interface OpenProgram {
  id: string;
  name: string;
  /** A fraction — 0.2, not 20. */
  commissionRate: number;
  revenueComponents: string[];
  /** Null means for as long as the merchant keeps paying. */
  durationMonths: number | null;
  unassignAfterUninstallDays: number | null;
  requiresApproval: boolean;
  /** The App Store page, so an applicant can see what they would promote. */
  listingUrl: string;
}

/**
 * The programs a stranger may apply to, and the only thing a stranger may learn.
 *
 * Every field here is either a public fact (the App Store listing) or a term of
 * the offer being made (the rate, what it earns on, how long it runs, whether
 * approval is needed). What is *not* here is as deliberate: no `app_id`, no
 * affiliate counts, no external ids, nothing about a merchant, and no closed
 * programs. The admin's `listPrograms` returns several of those, which is why
 * this is a separate function rather than a filter over it — the two have
 * different readers and the difference has to be visible in one screen of code.
 *
 * `listingUrl` is passed in rather than resolved here so this module stays free
 * of the server layer; see the router, which asks `listingUrlForProgram`.
 */
export function listOpenPrograms(db: Db = getDb()): Array<Omit<OpenProgram, 'listingUrl'>> {
  const rows = db
    .prepare(
      `SELECT p.id, COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS name,
              p.commission_rate AS commissionRate,
              p.revenue_components AS revenueComponents,
              p.duration_months AS durationMonths,
              p.unassign_after_uninstall_days AS unassignAfterUninstallDays,
              p.require_approval AS requireApproval
         FROM affiliate_programs p
         LEFT JOIN apps app ON app.id = p.app_id
        WHERE p.status = 'active'
        ORDER BY name`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    commissionRate: Number(row.commissionRate),
    revenueComponents: parseRevenueComponents(row.revenueComponents),
    durationMonths: row.durationMonths === null ? null : Number(row.durationMonths),
    unassignAfterUninstallDays:
      row.unassignAfterUninstallDays === null ? null : Number(row.unassignAfterUninstallDays),
    requiresApproval: Number(row.requireApproval) === 1,
  }));
}

/**
 * `'["subscription"]'` → `['subscription']`, and never a thrown page.
 *
 * Lives here and is imported by both the portal and the admin read model, so the
 * three places that render this column cannot disagree about what a malformed
 * value means. It degrades to the one component every commission in the ledger
 * actually came from rather than throwing, because a bad JSON string in a
 * settings column should cost a wrong label, not a blank page.
 */
export function parseRevenueComponents(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return ['subscription'];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : ['subscription'];
  } catch {
    return ['subscription'];
  }
}

/* ------------------------------------------------------------------- apply */

export interface SignupInput {
  name: string;
  email: string;
  /** The programs applied to. At least one, at most `MAX_PROGRAMS_PER_APPLICATION`. */
  programIds: string[];
  /** Whether the terms box was ticked. Only load-bearing when a URL is configured. */
  acceptedTerms?: boolean;
  /** The terms presented, from config. Empty means none were. */
  termsUrl?: string;
}

export interface SignupMembership {
  programId: string;
  status: MembershipStatus;
  /** Null when the membership already existed — no new handle was minted. */
  handle: string | null;
  /** True when this application attached to a membership that was already there. */
  alreadyApplied: boolean;
}

export interface SignupOutcome {
  affiliateId: string;
  /** False when the address matched an affiliate we already hold. */
  createdAffiliate: boolean;
  memberships: SignupMembership[];
}

/** Normalized, bounded and refused early — before anything reads the database. */
export function validateSignup(input: SignupInput): {
  name: string;
  email: string;
  programIds: string[];
} {
  const name = String(input.name ?? '').trim();
  // Compared against the raw length, not a character count: the column is text
  // and the point of the bound is to keep an unbounded string out of storage and
  // out of an operator's inbox, so it counts what is actually stored.
  if (name.length === 0) throw new SignupError('Tell us your name.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new SignupError(`Your name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }

  const email = String(input.email ?? '').trim().toLowerCase();
  if (email.length === 0) throw new SignupError('Tell us your email address.');
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    throw new SignupError('That does not look like an email address.');
  }

  const programIds = Array.isArray(input.programIds)
    ? Array.from(new Set(input.programIds.map((id) => String(id)).filter((id) => id.length > 0)))
    : [];
  if (programIds.length === 0) throw new SignupError('Choose at least one program to join.');
  if (programIds.length > MAX_PROGRAMS_PER_APPLICATION) {
    // Bounds the loop below, which does a handle allocation per program. There
    // are two programs; anything near this ceiling is a script, not a partner.
    throw new SignupError('Choose fewer programs.');
  }

  // The tick box is only meaningful when there is something to tick it about.
  // No terms are configured today (Mantle's were not either), so requiring
  // acceptance unconditionally would be demanding agreement to nothing.
  if (input.termsUrl && input.acceptedTerms !== true) {
    throw new SignupError('You need to accept the affiliate terms to apply.');
  }

  return { name, email, programIds };
}

/**
 * Record an application.
 *
 * One transaction, so a partly-written applicant — an affiliate row with no
 * membership, or a membership whose handle was allocated and then lost — cannot
 * exist. That matters more than usual here because the failure would be
 * invisible: an affiliate with no membership has no link, earns nothing, and
 * looks exactly like somebody who has not been approved yet.
 *
 * Two notes on what this deliberately leaves alone when the address is already
 * ours, both of which are about an unauthenticated caller's reach:
 *
 *   - **The name is never overwritten.** Otherwise anyone who knows an
 *     affiliate's address could rename them, and the rename would land on the
 *     row an operator reads when deciding who to pay.
 *   - **Terms acceptance is only ever filled in, never replaced.** A stranger
 *     cannot clear or re-date an existing consent record; they can only supply
 *     one where none exists, which is the case this exists for.
 */
export function applyForSignup(
  input: SignupInput,
  db: Db = getDb(),
  now: string = new Date().toISOString(),
): SignupOutcome {
  const { name, email, programIds } = validateSignup(input);

  const programs = programIds.map((programId) => {
    const row = db
      .prepare(
        `SELECT id, require_approval AS requireApproval FROM affiliate_programs
          WHERE id = ? AND status = 'active'`,
      )
      .get(programId) as { id: string; requireApproval: number } | undefined;
    // Refused before the transaction opens, and worded about the program rather
    // than the applicant: program ids are already public on the signup form, so
    // this tells a caller nothing they did not send us.
    if (!row) throw new SignupError('That program is not open for applications.');
    return { id: row.id, requiresApproval: row.requireApproval === 1 };
  });

  return db.transaction((): SignupOutcome => {
    /*
     * Matched case-insensitively, and `ORDER BY created_at LIMIT 1` for the same
     * reason the login does it: the ledger allows two affiliates to share an
     * address and one imported pair really does. Attaching to the older of the
     * two is the same choice the login makes, so a person who signs up for a
     * second program lands on the account they can actually sign into.
     */
    const existing = db
      .prepare(`SELECT id FROM affiliates WHERE LOWER(email) = ? ORDER BY created_at LIMIT 1`)
      .get(email) as { id: string } | undefined;

    const affiliateId =
      existing?.id ??
      upsertAffiliate({ name, email, source: 'signup', createdAt: now }, db);

    // Fills a hole, never replaces a value — see the note above. Runs on both
    // paths so the two cost the same work, which is part of how this endpoint
    // avoids being a clock that answers "is this address one of yours".
    if (input.termsUrl) {
      db.prepare(
        `UPDATE affiliates
            SET terms_url = @url, terms_accepted_at = @now, updated_at = @now
          WHERE id = @id AND terms_accepted_at IS NULL`,
      ).run({ id: affiliateId, url: input.termsUrl, now });
    }

    const memberships = programs.map((program): SignupMembership => {
      const held = db
        .prepare(
          `SELECT status FROM affiliate_memberships WHERE affiliate_id = ? AND program_id = ?`,
        )
        .get(affiliateId, program.id) as { status: MembershipStatus } | undefined;

      // Left exactly as it is, in every state. An enrolled member re-applying
      // changes nothing; a pending one does not jump the queue by asking again;
      // and a *rejected* one does not get re-admitted by a second form
      // submission, which is the case this rule exists for.
      if (held) {
        return { programId: program.id, status: held.status, handle: null, alreadyApplied: true };
      }

      /*
       * The one decision this whole feature turns on, and it is read from the
       * program row rather than named here. A program that requires approval
       * produces a `pending` membership: no `approved_at`, and — because
       * `portal.ts` and `membershipsFor` both gate on `status === 'enrolled'` —
       * no referral link anywhere in the portal. The attribution pipeline
       * credits enrolled memberships only, so a link handed over here would
       * collect clicks that pay nobody.
       */
      const status: MembershipStatus = program.requiresApproval ? 'pending' : 'enrolled';
      const handle = generateHandle(db, program.id);

      upsertMembership(
        {
          affiliateId,
          programId: program.id,
          handle,
          status,
          joinedAt: now,
          // Stamped for an auto-enrolment too. The column records when the
          // membership started earning, which is the question anyone reading it
          // is actually asking; leaving it null on the half of memberships
          // nobody has to approve would make "enrolled with no approval date"
          // look like a data fault rather than the normal Filemonk case.
          approvedAt: status === 'enrolled' ? now : null,
        },
        db,
      );

      return { programId: program.id, status, handle, alreadyApplied: false };
    });

    return { affiliateId, createdAffiliate: !existing, memberships };
  })();
}

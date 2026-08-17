import crypto from 'node:crypto';
import express from 'express';
import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { deliverInBackground } from '../notifications/affiliateEmail.js';
import { clientKey, readCookie } from './auth.js';
import { sendError } from './errors.js';
import { HashCapacityError, scryptHash } from './scryptPool.js';
import { createThrottle } from './throttle.js';

/**
 * The affiliate realm: a second, weaker-privileged way into this server.
 *
 * Everything here exists because of one asymmetry. `auth.ts` gates `/api` with a
 * single shared password held by one trusted operator, and behind that gate sits
 * two Shopify Partner organizations' revenue, every merchant's identity, and the
 * BigQuery service-account credential. This realm authenticates hundreds of
 * external people. They must never arrive at any of that, and the design assumes
 * at least one of them will try.
 *
 * Three things keep the realms apart, and each is independently sufficient:
 *
 *   1. Different cookie names. A portal session cookie is not named
 *      `partnerdex_session`, so it is never even *read* by `isAuthenticated`.
 *   2. Different signing keys, with no shared secret. An admin token is signed
 *      with a key derived from `DASHBOARD_PASSWORD`; a portal token is signed
 *      with a key derived from the affiliate's own stored password hash. Neither
 *      key can produce a token the other side accepts, and there is no third
 *      secret whose leak would compromise both.
 *   3. Different mount points. `/portal/api/*` never falls through to `/api/*`,
 *      and `requireAuth` still guards `/api` regardless of what happens here.
 *
 * The signing key deserves its own note, because it is doing more work than it
 * looks like. Deriving it from the affiliate's password hash means there is no
 * portal session secret to configure, deploy or rotate — and, for free, changing
 * or resetting a password invalidates every session that affiliate had. That is
 * the same property `auth.ts` gets from deriving its key from the password, and
 * it is the property that makes "reset my password" a real remedy after a device
 * is lost, rather than a change of what to type on a machine still logged in.
 */

/**
 * Deliberately not `partnerdex_session`, and not a prefix of it.
 *
 * A shared name would be worse than an inconvenience: both middlewares read the
 * cookie header by name, so one name would mean one cookie jar and a browser
 * that logged into the portal would overwrite an operator's admin session on the
 * same host.
 */
const COOKIE_NAME = 'partnerdex_affiliate';
const COOKIE_PATH = '/portal';

/** A working session. Affiliates check earnings occasionally, not all day. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a set-password link stays usable.
 *
 * Long enough to survive being delivered by hand and read the next morning,
 * short enough that a link forwarded into an inbox somebody else later reads is
 * usually already dead.
 */
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** scrypt's cost, and the length of what it produces. */
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** The minimum we will store. Not a policy, a floor — see `dashboardPassword`. */
const MIN_PASSWORD_LENGTH = 10;

/**
 * Two counters, because the two flows are abused in different directions.
 *
 * `loginThrottle` is keyed on the client address *and* the account being tried,
 * not the address alone. Keying on the address alone was the original shape and
 * it made a lockout into a weapon: five wrong passwords for any address at all
 * shut the portal for every affiliate behind the same NAT, and for every one of
 * them at once if a second proxy hop ever collapses them into one address.
 * Mixing the account in means an attacker has to name their victim, and locks
 * out only the pair (them, that victim) — not the population.
 *
 * `resetThrottle` counts requests for a set-password link, which is a different
 * question entirely: nobody is guessing a secret there, so the counter is not a
 * guess budget but a flood ceiling. It is separate because sharing the login's
 * counter meant a legitimate reset request consumed a login attempt — five
 * honest "email me a link" clicks from one office locked that office out of the
 * only onboarding path there is.
 */
const loginThrottle = createThrottle();

/**
 * A second login counter, keyed on the client address *alone*.
 *
 * This exists because the per-(address, account) key above is a correctness
 * property, not a cost property. It bounds how many guesses anyone gets at a
 * *named victim* — which is what a lockout is for — and it deliberately does
 * not bound how many attempts one address may make in total, because an
 * attacker who rotates the email address gets a fresh bucket every request. The
 * full review proved that: eight rotated addresses from one IP, eight 401s, zero
 * 429s, and each of those requests bought a 22 ms scrypt on the event loop.
 *
 * So this counter answers a different question: how much *work* may one address
 * ask this process to do. It counts every attempt, hit or miss, existing address
 * or not — counting selectively would be both an oracle and useless, since the
 * whole point is that the miss path is not cheap.
 *
 * The numbers are chosen so it is a cost ceiling and not a lockout. Keying login
 * on the address alone was the original shape and the previous review found it
 * turned a throttle into a weapon: a NAT's worth of affiliates share one address
 * and one guesser shut them all out. That failure is avoided here by making the
 * budget large (an office of twenty people signing in at once never approaches
 * it), the penalty short, and the decay fast, so an honest population behind one
 * address is never held out for meaningfully long — while a flood, which needs
 * *hundreds* of attempts a minute to matter, is stopped in about a second.
 *
 * It does not replace the account-keyed counter, it stacks in front of it. If a
 * future proxy misconfiguration collapses every client into one address, this
 * one degrades to "the whole population shares a 60-attempt-per-10s budget",
 * which is survivable; the account lockout keeps its per-victim meaning either
 * way.
 */
const loginAddressThrottle = createThrottle({
  maxAttempts: 60,
  lockoutMs: 2_000,
  maxLockoutMs: 30_000,
  decayMs: 10_000,
});

const resetThrottle = createThrottle({
  // Deliberately looser than a login: asking for a link twice because the first
  // one has not arrived yet is normal behaviour, not an attack, and the flow
  // this protects is the one every affiliate must complete to have an account
  // at all. Nothing here is a secret being guessed, so the budget can be spent
  // freely without weakening anything.
  maxAttempts: 10,
  lockoutMs: 30_000,
  maxLockoutMs: 5 * 60_000,
  decayMs: 60_000,
});

/**
 * The same address-only accounting for `/request-reset`, for the same reason.
 *
 * The review's attack is one IP walking the hundreds of known affiliate
 * addresses: one attempt per per-email bucket, never throttled, and every hit
 * *replaces* that affiliate's outstanding set-password token and triggers a real
 * email. On day one all accounts have to complete exactly that flow, so this is
 * a denial of onboarding plus one attacker-chosen send per affiliate against our
 * sending reputation.
 *
 * Looser than the login's address counter because the flow is genuinely bursty
 * — a mail-out lands and a batch of people click "send me a link" at once — and
 * tighter than the affiliate population, which is the number that has to be out
 * of reach.
 */
const resetAddressThrottle = createThrottle({
  maxAttempts: 30,
  lockoutMs: 60_000,
  maxLockoutMs: 10 * 60_000,
  decayMs: 60_000,
});

/**
 * The ceiling on how many set-password links this process will mint per hour in
 * response to *unauthenticated* requests, across every address and every caller.
 *
 * The address counters above stop one IP. They do nothing about a few hundred
 * IPs each asking politely once, which is a botnet's normal shape and is enough
 * to invalidate every in-flight onboarding link and empty our sending quota.
 *
 * The trade, stated plainly because it is a real one: an attacker who saturates
 * this ceiling denies self-service password resets to everyone until the window
 * rolls. That is deliberately accepted, and it is survivable for one specific
 * reason — the *operator's* path is not subject to it. `POST
 * /api/affiliates/:id/set-password-link` and the bulk `set-password-links`
 * route sit behind the dashboard gate and mint unconditionally, so an onboarding
 * campaign can always be completed even while this ceiling is pinned. Losing
 * self-service for an hour is recoverable; having all live links replaced by
 * a stranger is not.
 *
 * 200/hour against a population in the hundreds is roughly "a third of everyone
 * could ask in the same hour", which no real day looks like.
 */
const RESET_MINTS_PER_HOUR = 200;
const RESET_CEILING_WINDOW_MS = 60 * 60_000;
let resetMints: number[] = [];
let resetCeiling = RESET_MINTS_PER_HOUR;

/**
 * Test seam: shrink the ceiling so a test can reach it in four requests rather
 * than two hundred. `null` restores the shipped number.
 */
export function configureResetCeiling(max: number | null): void {
  resetCeiling = max ?? RESET_MINTS_PER_HOUR;
  resetMints = [];
}

function resetCeilingAllows(now = Date.now()): boolean {
  // Kept as a timestamp list rather than a counter with a reset, so the window
  // slides instead of stepping — a stepped window lets an attacker spend the
  // whole budget twice across a boundary.
  resetMints = resetMints.filter((at) => now - at < RESET_CEILING_WINDOW_MS);
  if (resetMints.length >= resetCeiling) return false;
  resetMints.push(now);
  return true;
}

/** Test seam: per-process counters that no test should have to wait out. */
export function resetPortalThrottles(): void {
  portalThrottleKeys.forEach((key) => {
    loginThrottle.clear(key);
    loginAddressThrottle.clear(key);
    resetThrottle.clear(key);
    resetAddressThrottle.clear(key);
  });
  portalThrottleKeys.clear();
  resetMints = [];
}

/**
 * The address-only bucket, registered with the same test seam as the rest.
 *
 * Prefixed separately from the per-account keys so the two counters can never
 * collide on a key and share a budget by accident.
 */
function addressKey(prefix: string, request: express.Request): string {
  const key = `${prefix}:addr:${clientKey(request)}`;
  portalThrottleKeys.add(key);
  return key;
}

/** Every key handed to either throttle, so the test seam can drop them all. */
const portalThrottleKeys = new Set<string>();

/**
 * The bucket a login or reset attempt falls in.
 *
 * The account is folded in as a digest rather than appended raw: the email is
 * attacker-controlled and unbounded, and a key that grows with the input is a
 * memory-exhaustion primitive dressed up as a rate-limit key. Sixteen hex
 * characters is far past the point where a collision would matter — two
 * addresses sharing a bucket is a shared lockout between two accounts, not a
 * security failure.
 */
function attemptKey(prefix: string, request: express.Request, email: string): string {
  const key = `${prefix}:${clientKey(request)}:${digest(email).slice(0, 16)}`;
  portalThrottleKeys.add(key);
  return key;
}

export class PortalAuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------- credentials */

interface CredentialRow {
  affiliateId: string;
  passwordHash: string;
  passwordSalt: string;
  resetTokenHash: string;
  resetExpiresAt: string | null;
}

function credentialsFor(db: Db, affiliateId: string): CredentialRow | null {
  return (
    (db
      .prepare(
        `SELECT affiliate_id AS affiliateId, password_hash AS passwordHash,
                password_salt AS passwordSalt, reset_token_hash AS resetTokenHash,
                reset_expires_at AS resetExpiresAt
           FROM affiliate_credentials WHERE affiliate_id = ?`,
      )
      .get(affiliateId) as CredentialRow | undefined) ?? null
  );
}

/**
 * The synchronous hash, kept for the *write* paths only.
 *
 * `setPasswordFor` runs this, and that is a considered exception rather than an
 * oversight: reaching it requires a valid single-use reset token, so it is not
 * an operation an unauthenticated stranger can repeat at volume, and it is
 * called from CLI commands where an async signature would ripple for nothing.
 * The login path — the one an attacker can call as fast as they like — must not
 * use this. See `hashPasswordAsync`.
 */
function hashPassword(password: string, saltHex: string): string {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN).toString('hex');
}

/**
 * The hash every *login* uses: off the event loop, and behind a global cap.
 *
 * Rejects with `HashCapacityError` when the process is already hashing as much
 * as it will; the route turns that into a 429. See `scryptPool.ts` for why both
 * halves — async and capped — are necessary and why neither is sufficient.
 */
function hashPasswordAsync(password: string, saltHex: string): Promise<Buffer> {
  return scryptHash(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
}

/**
 * A credential row nobody can log in as, used to spend the same time as a real one.
 *
 * Built once from random bytes: the salt is real, the hash is scrypt over a
 * secret this process throws away, so no presented password can match it and
 * checking against it costs exactly what checking a real account costs. Built
 * lazily rather than at import so a CLI command that never serves a login does
 * not pay 20ms of scrypt to start up.
 */
let decoyRow: CredentialRow | null = null;
let decoyBuild: Promise<CredentialRow> | null = null;
function decoy(): Promise<CredentialRow> {
  // Memoized as the *promise*, not the row: two logins arriving in the same tick
  // before the first hash resolves must share one build rather than each paying
  // for their own — the whole point of this module is that concurrent logins do
  // not multiply work.
  if (!decoyBuild) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    decoyBuild = hashPasswordAsync(crypto.randomBytes(32).toString('hex'), salt).then((hash) => {
      decoyRow = {
        affiliateId: '',
        passwordHash: hash.toString('hex'),
        passwordSalt: salt,
        resetTokenHash: '',
        resetExpiresAt: null,
      };
      return decoyRow;
    });
    // A failed build must not be cached as a permanently broken decoy — that
    // would silently reopen the timing oracle for the life of the process.
    decoyBuild.catch(() => {
      decoyBuild = null;
    });
  }
  return decoyBuild;
}

/**
 * Whether this password produces the stored hash.
 *
 * A row with a blank hash cannot match anything — that blank is the whole
 * representation of "has never set a password", and there is no sentinel value
 * to accidentally match because the empty string is not a scrypt output any
 * input can produce. But it is checked against the decoy rather than answered
 * immediately, and a missing row is too, because *returning early is itself the
 * answer to a question we refuse to answer in the response body*.
 *
 * The review measured 21ms for an address that is one of ours against 0.7ms for
 * one that is not: a 25× separation, readable in a single probe, which turns any
 * list of email addresses into a list of which of them are our affiliates — the
 * exact fact the identical error message downstream exists to hide. Running the
 * hash regardless costs one scrypt on a path that was going to fail anyway, and
 * that is cheap compared to publishing the roster.
 *
 * The limit of this defence, stated because it is easy to over-trust: it
 * equalizes the *dominant* cost, not every cost. A missing account still skips a
 * credential lookup, and a disabled one still takes a slightly different branch;
 * those are sub-millisecond differences under a 20ms hash rather than the 25×
 * one, and closing them completely would need a fixed time floor on the whole
 * handler. If scrypt ever gets cheaper here, revisit that.
 *
 * Asynchronous since the availability review, and that changes nothing about
 * the property above: both arms still run exactly one scrypt, of the same cost,
 * through the same queue, so the wall-clock separation between "one of ours" and
 * "not one of ours" stays inside the noise. What it changes is who waits — the
 * request, not the process. `test/availability.test.ts` pins both halves: the
 * two paths stay comparable in time, *and* a burst of logins no longer stalls an
 * unrelated endpoint.
 */
async function verifyPassword(password: string, row: CredentialRow | null): Promise<boolean> {
  const against = row && row.passwordHash && row.passwordSalt ? row : await decoy();
  const presented = await hashPasswordAsync(password, against.passwordSalt);
  const stored = Buffer.from(against.passwordHash, 'hex');
  if (presented.length !== stored.length) return false;
  const matched = crypto.timingSafeEqual(presented, stored);
  // The decoy can never match, but say so structurally rather than relying on
  // that: a comparison against a row nobody owns must not be able to authorize.
  return matched && against !== decoyRow;
}

export function setPasswordFor(db: Db, affiliateId: string, password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PortalAuthError(
      `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  const now = new Date().toISOString();
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');

  db.prepare(
    `INSERT INTO affiliate_credentials (affiliate_id, password_hash, password_salt,
                                        password_set_at, reset_token_hash, reset_expires_at,
                                        created_at, updated_at)
     VALUES (@id, @hash, @salt, @now, '', NULL, @now, @now)
     ON CONFLICT(affiliate_id) DO UPDATE SET
       password_hash    = excluded.password_hash,
       password_salt    = excluded.password_salt,
       password_set_at  = excluded.password_set_at,
       -- Redeeming a token spends it, and setting a password by any other route
       -- spends any token still outstanding. Both are the same rule: after this
       -- returns, no link that existed before it opens this account.
       reset_token_hash = '',
       reset_expires_at = NULL,
       updated_at       = excluded.updated_at`,
  ).run({ id: affiliateId, hash: hashPassword(password, salt), salt, now });
}

/* ------------------------------------------------------- set-password token */

/**
 * Issue a single-use link for setting or resetting a password.
 *
 * The returned token is the only copy that will ever exist: what is stored is
 * its SHA-256 digest, so a leaked database hands over no account. The affiliate
 * id rides in front of the secret so redemption is a primary-key lookup followed
 * by a constant-time compare, rather than a query against an attacker-controlled
 * index — and so a token that names an affiliate who no longer exists is
 * rejected before any comparison happens at all.
 *
 * There is no email sender here, on purpose. This project has four runtime
 * dependencies and adding SMTP to ship the first version of a portal is not a
 * trade worth making. The token is returned to the caller so it can be delivered
 * out of band; the seam where a sender plugs in later is `deliverSetPasswordLink`
 * below, and nothing else in this file knows how the token travels.
 */
export function issueResetToken(
  db: Db,
  affiliateId: string,
  now: Date = new Date(),
): { token: string; expiresAt: string } {
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${affiliateId}.${secret}`;
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS).toISOString();
  const stamp = now.toISOString();

  db.prepare(
    `INSERT INTO affiliate_credentials (affiliate_id, reset_token_hash, reset_expires_at,
                                        reset_requested_at, created_at, updated_at)
     VALUES (@id, @hash, @expiresAt, @stamp, @stamp, @stamp)
     ON CONFLICT(affiliate_id) DO UPDATE SET
       -- One outstanding token per affiliate. Asking again replaces the previous
       -- link rather than adding to it, so the number of live ways into an
       -- account never exceeds one however many times the button is pressed.
       reset_token_hash   = excluded.reset_token_hash,
       reset_expires_at   = excluded.reset_expires_at,
       reset_requested_at = excluded.reset_requested_at,
       updated_at         = excluded.updated_at`,
  ).run({ id: affiliateId, hash: digest(secret), expiresAt, stamp });

  return { token, expiresAt };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * The link an affiliate follows, from a token.
 *
 * The token rides in the URL *fragment*, which is the load-bearing detail: a
 * fragment is never sent to a server, so the secret stays out of access logs,
 * out of `Referer` headers, and out of any proxy in between. Prefixed with
 * `PORTAL_BASE_URL` when it is configured and left site-relative otherwise,
 * because this process does not reliably know its own public hostname and a
 * confidently wrong link is worse than one an operator completes by hand.
 */
export function setPasswordLink(token: string): string {
  return `${getConfig().runtime.portalBaseUrl}/portal#/set-password/${token}`;
}

export interface SetPasswordLink {
  affiliateId: string;
  name: string;
  email: string;
  url: string;
  expiresAt: string;
}

/**
 * Mint a link for one affiliate, addressed to whoever is going to send it.
 *
 * This is the deliberate, authenticated way to get a working link out of the
 * system: an operator asks, and the answer goes to that operator. It replaces
 * the previous arrangement, where every requested link was printed to stdout —
 * which is to say published to anyone holding `fly logs`, a copy of a container
 * log, or an account on the log aggregator. All the imported accounts arrived
 * without passwords, so that channel was not an edge case, it was the entire
 * onboarding path, and every account on it was takeable without a network
 * position or a password.
 *
 * The caller is responsible for what happens next. What comes back is an
 * account-takeover link with a 24-hour life: it belongs in an email, a payload
 * an operator pastes into one, or a terminal an operator is looking at — never
 * in a log line, an error report, or a metrics label.
 */
export function issueSetPasswordLink(
  db: Db,
  affiliateId: string,
  now: Date = new Date(),
): SetPasswordLink | null {
  const affiliate = db
    .prepare(`SELECT id, name, email FROM affiliates WHERE id = ? AND status = 'active'`)
    .get(affiliateId) as { id: string; name: string; email: string } | undefined;
  if (!affiliate) return null;

  const { token, expiresAt } = issueResetToken(db, affiliate.id, now);
  return {
    affiliateId: affiliate.id,
    name: affiliate.name,
    email: affiliate.email,
    url: setPasswordLink(token),
    expiresAt,
  };
}

/**
 * Where the sender plugs in.
 *
 * Called by `/request-reset` when an affiliate asks for a link themselves. This
 * used to be the end of the road — there was nowhere to send a link, and both
 * obvious stand-ins were worse than doing nothing: returning it in the response
 * hands the account to any stranger who knows an address, and writing it to the
 * log is what the security review found and is the reason this seam exists at
 * all.
 *
 * There is now a sender behind it, in `notifications/affiliateEmail.ts`. When no
 * mail relay is configured it degrades to precisely the old behaviour — the
 * token is minted and stored, the operator is told without the secret that
 * somebody is waiting, and the working paths remain `POST
 * /api/affiliates/:id/set-password-link` behind the dashboard gate and
 * `partnerdex portal-link` at a terminal.
 *
 * The one rule this seam has always had is unchanged and holds on both sides of
 * it: `link.url` is a bearer credential with a 24-hour life. It may be handed to
 * a transport. It may not be logged, recorded, or put in an error message.
 *
 * Exported for one other caller: affiliate self-signup, which finishes by handing
 * a new applicant a set-password link. Deliberately the same seam rather than a
 * second one — a signup that delivered its own link would be a second place to
 * forget that the link is a credential.
 */
export function deliverSetPasswordLink(link: SetPasswordLink): void {
  deliverInBackground(link, getDb());
}

/**
 * Check a token and return whose it is, or null.
 *
 * Expiry is read from the stored column rather than from anything inside the
 * token, because the token is a bearer string a holder can rewrite and the
 * column is not.
 */
export function affiliateForResetToken(db: Db, token: string, now: Date = new Date()): string | null {
  const separator = token.indexOf('.');
  if (separator <= 0) return null;

  const affiliateId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!secret) return null;

  const row = credentialsFor(db, affiliateId);
  if (!row || !row.resetTokenHash || !row.resetExpiresAt) return null;
  if (row.resetExpiresAt <= now.toISOString()) return null;

  const presented = Buffer.from(digest(secret), 'hex');
  const stored = Buffer.from(row.resetTokenHash, 'hex');
  if (presented.length !== stored.length) return null;
  if (!crypto.timingSafeEqual(presented, stored)) return null;

  return affiliateId;
}

/* ------------------------------------------------------------------ session */

/**
 * The session key: per affiliate, derived from what they currently know.
 *
 * Including the hash *and* the salt means a password re-set to the same string
 * still invalidates old sessions, because the salt is new every time.
 */
function sessionKey(row: CredentialRow): Buffer {
  return crypto
    .createHash('sha256')
    .update(`partnerdex.portal.session.v1:${row.passwordHash}:${row.passwordSalt}`)
    .digest();
}

function sign(payload: string, row: CredentialRow): string {
  return crypto.createHmac('sha256', sessionKey(row)).update(payload).digest('base64url');
}

function issueToken(affiliateId: string, row: CredentialRow, ttlMs: number): string {
  const payload = `${affiliateId}.${Date.now() + ttlMs}`;
  return `${payload}.${sign(payload, row)}`;
}

export interface PortalIdentity {
  affiliateId: string;
  name: string;
  email: string;
}

/**
 * Who this request is, or null.
 *
 * Note what is re-read on every request rather than trusted from the token: the
 * credential row (so a password change kills the session) and the affiliate's
 * status (so disabling someone takes effect immediately, not in twelve hours).
 * A session cookie here is a claim to be checked, never a cached answer.
 */
export function identify(request: express.Request, db: Db = getDb()): PortalIdentity | null {
  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [affiliateId, expiresAt, signature] = parts as [string, string, string];

  const row = credentialsFor(db, affiliateId);
  if (!row || !row.passwordHash) return null;

  const presented = Buffer.from(signature);
  const expected = Buffer.from(sign(`${affiliateId}.${expiresAt}`, row));
  if (presented.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(presented, expected)) return null;

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;

  const affiliate = db
    .prepare(`SELECT id, name, email FROM affiliates WHERE id = ? AND status = 'active'`)
    .get(affiliateId) as { id: string; name: string; email: string } | undefined;
  if (!affiliate) return null;

  return { affiliateId: affiliate.id, name: affiliate.name, email: affiliate.email };
}

/**
 * The identity every portal query scopes itself to.
 *
 * `requirePortalAuth` puts it here and nothing else ever does, which is what
 * makes the scoping in `portal.ts` provable by reading it: there is no route
 * that takes an affiliate id from the caller, so there is no route where the
 * caller can name someone else.
 */
declare global {
  namespace Express {
    interface Request {
      affiliate?: PortalIdentity;
    }
  }
}

export function requirePortalAuth(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  const identity = identify(request);
  if (!identity) {
    response.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  request.affiliate = identity;
  next();
}

/** Throws rather than returning undefined: a missing identity is a mount bug. */
export function currentAffiliate(request: express.Request): PortalIdentity {
  const identity = request.affiliate;
  if (!identity) {
    throw new Error('Portal route reached without requirePortalAuth in front of it.');
  }
  return identity;
}

/* ------------------------------------------------------------------ routes */

function cookieOptions(request: express.Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Scoped to the portal, so an affiliate's browser does not even send this
    // cookie to `/api`. Defence in depth: `requireAuth` would reject it anyway,
    // but a credential that is never transmitted cannot be mishandled.
    path: COOKIE_PATH,
    secure: request.protocol === 'https',
  };
}

export function portalAuthRouter(): express.Router {
  const router = express.Router();

  /** What the portal shell asks before it renders. Deliberately open. */
  router.get('/session', (request, response) => {
    const identity = identify(request);
    response.json({
      authenticated: identity !== null,
      ...(identity ? { name: identity.name, email: identity.email } : {}),
    });
  });

  router.post('/login', (request, response) => {
    // Express 4 does not observe a rejected promise, so the catch is here rather
    // than in the handler's signature. `sendError` keeps this file free of
    // `console.*` (the previous review's F3 property) and answers a generic 500
    // instead of letting Express's default handler render a stack trace.
    handleLogin(request, response).catch((error: unknown) => sendError(response, error));
  });

  /**
   * Split out of the route because it is `async` now, and Express 4 does not
   * catch a rejected promise from a handler — an unhandled rejection here would
   * take the process down, which is the exact class of bug this workstream is
   * about. Everything below is inside one try/catch for that reason.
   */
  async function handleLogin(
    request: express.Request,
    response: express.Response,
  ): Promise<void> {
    const body = request.body as { email?: unknown; password?: unknown; remember?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const remember = body?.remember === true;

    /*
     * Two counters, checked in cost order.
     *
     * The address-only one is first and is charged *before* any work happens,
     * because it is the one that answers "how much may this client spend", and
     * a counter charged after the expensive part has already paid for the
     * expensive part. It is charged on every attempt regardless of outcome —
     * including a successful one — so rotating the email address, which defeats
     * the per-account bucket entirely, no longer buys free scrypt.
     */
    const addrKey = addressKey('login', request);
    const addrLocked = loginAddressThrottle.lockoutSeconds(addrKey);
    if (addrLocked > 0) {
      response
        .status(429)
        .json({ error: `Too many attempts. Try again in ${addrLocked} second(s).` });
      return;
    }
    loginAddressThrottle.recordFailure(addrKey);

    // Read after the body, because the bucket is per (client, account) now and
    // the account is in the body. That ordering is the fix: one affiliate's
    // failures no longer spend another affiliate's attempts.
    const key = attemptKey('login', request, email);
    const locked = loginThrottle.lockoutSeconds(key);
    if (locked > 0) {
      response.status(429).json({ error: `Too many attempts. Try again in ${locked} second(s).` });
      return;
    }

    const db = getDb();
    /*
     * Matched case-insensitively, because an address typed into a login form is
     * not typed the way it was typed into the import. `LIMIT 1` and an ordering
     * are not decoration: the ledger deliberately allows two affiliates to share
     * an address — one pair really does in the imported data — so this picks the
     * older account rather than failing, and those two people cannot both be
     * served by an email login. That is a known limit, recorded here because it
     * is the kind of thing that otherwise gets discovered as a support ticket.
     */
    const affiliate = db
      .prepare(
        `SELECT id, status FROM affiliates
          WHERE LOWER(email) = ? ORDER BY created_at LIMIT 1`,
      )
      .get(email) as { id: string; status: string } | undefined;

    const row = affiliate ? credentialsFor(db, affiliate.id) : null;
    // Evaluated before the `&&` chain rather than inside it, on purpose: a
    // short-circuit here is what let the clock answer "is this address one of
    // ours". `verifyPassword` hashes against a decoy when there is no row.
    let passwordOk: boolean;
    try {
      passwordOk = await verifyPassword(password, row);
    } catch (error) {
      if (error instanceof HashCapacityError) {
        // Overload, not a failed guess, so it is deliberately *not* counted
        // against the account bucket: refusing work must never become a way to
        // lock a named affiliate out. The address counter was already charged
        // above, which is where the cost of this request belongs.
        response.setHeader('Retry-After', '1');
        response.status(429).json({ error: error.message });
        return;
      }
      throw error;
    }
    const ok = affiliate?.status === 'active' && row !== null && passwordOk;

    if (!ok || !affiliate || !row) {
      loginThrottle.recordFailure(key);
      // One message for every failure — unknown address, no password set yet,
      // wrong password, disabled account. Distinguishing them would confirm to
      // a stranger which of the known addresses is an affiliate of ours.
      response.status(401).json({ error: 'That email and password do not match.' });
      return;
    }

    loginThrottle.clear(key);
    db.prepare(
      `UPDATE affiliate_credentials SET last_login_at = ?, updated_at = ? WHERE affiliate_id = ?`,
    ).run(new Date().toISOString(), new Date().toISOString(), affiliate.id);

    const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
    response.cookie(COOKIE_NAME, issueToken(affiliate.id, row, ttl), {
      ...cookieOptions(request),
      ...(remember ? { maxAge: REMEMBER_TTL_MS } : {}),
    });
    response.json({ ok: true });
  }

  router.post('/logout', (request, response) => {
    response.clearCookie(COOKIE_NAME, cookieOptions(request));
    response.json({ ok: true });
  });

  /**
   * Ask for a set-password link.
   *
   * Answers the same way whether or not the address is one of ours, for the same
   * reason the login does. The token is never in this response — returning it to
   * the browser would make every affiliate account takeable by anyone who knows
   * an address — and, since the review, it is not written to the log either. See
   * `deliverSetPasswordLink` for where it goes instead and why that is currently
   * nowhere.
   *
   * The counter is `resetThrottle`, not the login's, and it is keyed per address
   * *and* per email. Sharing the login's counter meant a legitimate request
   * consumed a login attempt, and counting per address alone meant five honest
   * requests from one office exhausted the bucket for everyone in it — on the
   * one flow every affiliate has to complete before they have an account at all.
   */
  router.post('/request-reset', (request, response) => {
    const body = request.body as { email?: unknown };
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';

    // Charged first and unconditionally, for the same reason the login's is:
    // the per-email bucket bounds nothing when the attacker supplies a
    // different email every time, and the whole address list is guessable.
    const addrKey = addressKey('reset', request);
    const addrLocked = resetAddressThrottle.lockoutSeconds(addrKey);
    if (addrLocked > 0) {
      response
        .status(429)
        .json({ error: `Too many requests. Try again in ${addrLocked} second(s).` });
      return;
    }
    resetAddressThrottle.recordFailure(addrKey);

    const key = attemptKey('reset', request, email);
    const locked = resetThrottle.lockoutSeconds(key);
    if (locked > 0) {
      response.status(429).json({ error: `Too many requests. Try again in ${locked} second(s).` });
      return;
    }
    // Counted whether or not the address exists: a throttle that only bites on
    // hits is an oracle for which addresses exist. That is why this counts
    // "successes" too — the fix for the review's finding was to give the flow
    // its own budget with its own decay, not to make the counter selective.
    resetThrottle.recordFailure(key);

    const db = getDb();
    const affiliate = db
      .prepare(
        `SELECT id FROM affiliates
          WHERE LOWER(email) = ? AND status = 'active' ORDER BY created_at LIMIT 1`,
      )
      .get(email) as { id: string } | undefined;

    // The global ceiling is consulted *after* the address is known to be
    // permitted and only when there is really something to mint, so a flood of
    // requests for addresses that are not ours cannot spend the budget that
    // real affiliates need. Over the ceiling nothing is minted and nothing is
    // sent — critically, no token is replaced, which is the actual harm — and
    // the answer is byte-identical to the normal one, because a distinguishable
    // "we are rate limited" reply would be an oracle for which addresses exist.
    if (affiliate && resetCeilingAllows()) {
      const link = issueSetPasswordLink(db, affiliate.id);
      if (link) deliverSetPasswordLink(link);
    }

    response.json({ ok: true });
  });

  /**
   * Redeem a link and set the password.
   *
   * Signing in is left to the client rather than done here, so the affiliate
   * types the password they just chose once more and finds out immediately if
   * their password manager saved something else.
   */
  router.post('/set-password', (request, response) => {
    const body = request.body as { token?: unknown; password?: unknown };
    const token = typeof body?.token === 'string' ? body.token : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    const db = getDb();
    const affiliateId = affiliateForResetToken(db, token);
    if (!affiliateId) {
      response
        .status(400)
        .json({ error: 'That link has expired or has already been used. Request a new one.' });
      return;
    }

    try {
      setPasswordFor(db, affiliateId, password);
    } catch (error) {
      if (error instanceof PortalAuthError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      // Answered here rather than rethrown. A rethrow reached Express's default
      // error handler, which renders a stack trace into the response body
      // whenever `NODE_ENV` is not `production` — a config-dependent leak on a
      // route a stranger can reach with a token they were legitimately sent.
      sendError(response, error);
    }

    response.json({ ok: true });
  });

  return router;
}

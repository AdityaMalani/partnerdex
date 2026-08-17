import crypto from 'node:crypto';
import express from 'express';
import { getConfig } from '../config.js';
import { createThrottle } from './throttle.js';

/**
 * A single shared password in front of the dashboard.
 *
 * This is a self-hosted tool with one operator, so there are no accounts to
 * model — only the question of whether the person at the keyboard knows the
 * password in `.env`. That makes a stateless signed cookie the right shape: no
 * session table to keep, no store to grow, and the server can be restarted or
 * run from two processes without logging anybody out.
 *
 * The signing key is derived from the password itself, which gives one property
 * worth having for free: changing `DASHBOARD_PASSWORD` invalidates every cookie
 * ever issued under the old one.
 */

const COOKIE_NAME = 'partnerdex_session';

/** Closing the browser ends it. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** "Remember me" — long enough to be worth ticking, short enough to expire. */
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Guessing is cheap over a network and a shared password is short, so failed
 * attempts are throttled per client. The mechanism moved to `throttle.ts` when
 * the affiliate portal needed the same one; this realm keeps its own counters,
 * so a partner guessing at the portal cannot lock the operator out of here.
 *
 * Keyed on the client address alone, and — unlike the portal — that cannot be
 * narrowed: there is one account, so there is nothing to mix in. The collateral
 * is therefore real and is accepted rather than solved. Anyone sharing the
 * operator's egress address who burns five attempts locks the operator out for
 * a minute, and the review measured exactly that against the live deployment.
 * Two things make it tolerable here: the population sharing this bucket is one
 * person rather than hundreds, and failures now age out on their own (see
 * `throttle.ts`), so the lockout cannot be walked up indefinitely by an attacker
 * spending one wrong password per expiry.
 */
const throttle = createThrottle();

export function authPassword(): string | null {
  return getConfig().auth.password;
}

/** Whether the API is gated at all. Unset password means it is not. */
export function authRequired(): boolean {
  return authPassword() !== null;
}

function signingKey(password: string): Buffer {
  return crypto.createHash('sha256').update(`partnerdex.session.v1:${password}`).digest();
}

function sign(payload: string, password: string): string {
  return crypto.createHmac('sha256', signingKey(password)).update(payload).digest('base64url');
}

/** The token is its own expiry plus a signature over it — nothing else is secret. */
function issueToken(password: string, ttlMs: number): string {
  const expiresAt = String(Date.now() + ttlMs);
  return `${expiresAt}.${sign(expiresAt, password)}`;
}

function tokenIsValid(token: string, password: string): boolean {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(payload, password));
  // timingSafeEqual throws on a length mismatch, so that case is answered first.
  if (presented.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(presented, expected)) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Compared over digests rather than the raw strings, so the comparison is
 * constant-time in the password's *content* and tells an attacker nothing from
 * its length either.
 *
 * Checked against the availability review and deliberately left synchronous.
 * The portal login had to move to async, capped scrypt because it runs a ~22 ms
 * key-derivation on every attempt; this runs two SHA-256 digests over a short
 * string, which is single-digit microseconds. Flooding it is a bandwidth
 * attack, not an event-loop attack, and moving it onto the libuv pool would add
 * a queue and a failure mode to defend against nothing. If this ever becomes a
 * real KDF — which it should if this password is ever more than one operator's
 * — it must move to `scryptPool.ts` at the same time.
 */
function passwordMatches(presented: string, actual: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Express only parses cookies with middleware; one name is not worth a dependency. */
export function readCookie(request: express.Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function isAuthenticated(request: express.Request): boolean {
  const password = authPassword();
  if (password === null) return true;
  const token = readCookie(request, COOKIE_NAME);
  return token !== null && tokenIsValid(token, password);
}

export function clientKey(request: express.Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

export function authRouter(): express.Router {
  const router = express.Router();

  /**
   * What the dashboard asks before it renders anything: is there a gate, and am
   * I through it? Deliberately unauthenticated — the answer is the login form.
   */
  router.get('/session', (request, response) => {
    response.json({
      required: authRequired(),
      authenticated: isAuthenticated(request),
    });
  });

  router.post('/login', (request, response) => {
    const password = authPassword();
    if (password === null) {
      response.json({ ok: true, required: false });
      return;
    }

    const key = clientKey(request);
    const locked = throttle.lockoutSeconds(key);
    if (locked > 0) {
      response
        .status(429)
        .json({ error: `Too many attempts. Try again in ${locked} second(s).` });
      return;
    }

    const body = request.body as { password?: unknown; remember?: unknown } | undefined;
    const presented = typeof body?.password === 'string' ? body.password : '';
    const remember = body?.remember === true;

    if (!presented || !passwordMatches(presented, password)) {
      throttle.recordFailure(key);
      // One message for "empty" and "wrong": there is nothing useful to
      // distinguish, and distinguishing them is what leaks.
      response.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    throttle.clear(key);
    const ttl = remember ? REMEMBER_TTL_MS : SESSION_TTL_MS;
    response.cookie(COOKIE_NAME, issueToken(password, ttl), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // Set only over TLS, so a cookie issued on localhost still arrives.
      secure: request.protocol === 'https',
      // Without maxAge the cookie dies with the browser session, which is
      // exactly what leaving "Remember me" unticked should mean. The token
      // carries its own shorter expiry regardless, so a browser that keeps
      // session cookies across restarts does not keep the login forever.
      ...(remember ? { maxAge: REMEMBER_TTL_MS } : {}),
    });
    response.json({ ok: true, required: true });
  });

  router.post('/logout', (request, response) => {
    response.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: request.protocol === 'https',
    });
    response.json({ ok: true });
  });

  return router;
}

/**
 * The gate itself. Mounted on `/api` after the routes that have to stay open —
 * the session check, the login form's target, and the health probe.
 */
export function requireAuth(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (isAuthenticated(request)) {
    next();
    return;
  }
  response.status(401).json({ error: 'Authentication required.' });
}

import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import type { SetPasswordLink } from '../server/portalAuth.js';
import { sendMail, type EmailMessage, type SendResult, type SmtpSettings } from './email.js';

/**
 * The set-password email: what it says, who sends it, and what we write down.
 *
 * This is the piece that turns the imported accounts into accounts somebody can
 * actually log into. Everything about it is shaped by one fact: these are
 * existing partners being carried across from a platform that is shutting down,
 * not leads. They did not ask for this message, they are already owed money by
 * us, and the thing they most need to be told is that nothing they have built
 * has changed. So the copy reads as continuity and the mechanics are boring —
 * no tracking, no images, no marketing, one link, one job.
 *
 * The delivery ledger lives here too, next to the sender rather than in
 * `store.ts`, because the rule it enforces is a property of *this* message: send
 * once, record the fact, never record the secret.
 */

/** The only message type so far. See the schema note on the `kind` column. */
export const SET_PASSWORD_EMAIL = 'set_password';

export interface EmailDelivery {
  affiliateId: string;
  kind: string;
  email: string;
  attemptedAt: string;
  deliveredAt: string | null;
  attempts: number;
  ok: boolean;
  error: string | null;
}

export function emailDeliveryFor(
  db: Db,
  affiliateId: string,
  kind: string = SET_PASSWORD_EMAIL,
): EmailDelivery | null {
  const row = db
    .prepare(
      `SELECT affiliate_id AS affiliateId, kind, email, attempted_at AS attemptedAt,
              delivered_at AS deliveredAt, attempts, ok, error
         FROM affiliate_email_deliveries WHERE affiliate_id = ? AND kind = ?`,
    )
    .get(affiliateId, kind) as
    | (Omit<EmailDelivery, 'ok'> & { ok: number })
    | undefined;
  return row ? { ...row, ok: row.ok === 1 } : null;
}

/** Errors are the relay's words, and a relay can be verbose. Keep it readable. */
const MAX_RECORDED_ERROR = 500;

/**
 * Write down that we tried, and how it went.
 *
 * Upsert rather than insert, and the reason is the resume: a second attempt at
 * the same person is the *same* fact with a higher attempt count, not a second
 * fact. `delivered_at` only ever moves forward on a success, so a later failure
 * against an address that once worked does not erase the evidence that it did —
 * which is the record that stops a re-run mailing them again.
 */
export function recordEmailAttempt(
  db: Db,
  input: { affiliateId: string; kind?: string; email: string; ok: boolean; error?: string | null },
  now: Date = new Date(),
): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO affiliate_email_deliveries
       (affiliate_id, kind, email, attempted_at, delivered_at, attempts, ok, error)
     VALUES (@id, @kind, @email, @at, CASE WHEN @ok = 1 THEN @at END, 1, @ok, @error)
     ON CONFLICT(affiliate_id, kind) DO UPDATE SET
       email        = excluded.email,
       attempted_at = excluded.attempted_at,
       delivered_at = CASE WHEN @ok = 1 THEN @at ELSE delivered_at END,
       attempts     = attempts + 1,
       -- Once true, always true: a delivery that happened cannot un-happen, and
       -- this column is the one a resumed run reads to decide who to skip.
       ok           = CASE WHEN ok = 1 OR @ok = 1 THEN 1 ELSE 0 END,
       error        = @error`,
  ).run({
    id: input.affiliateId,
    kind: input.kind ?? SET_PASSWORD_EMAIL,
    email: input.email,
    at,
    ok: input.ok ? 1 : 0,
    error: input.error ? input.error.slice(0, MAX_RECORDED_ERROR) : null,
  });
}

/* ----------------------------------------------------------------- sender */

export type Sender =
  | { kind: 'noop'; reason: string }
  | { kind: 'smtp'; settings: SmtpSettings };

/**
 * Which sender is in play, and — when it is the no-op — why.
 *
 * The `reason` is the whole point of returning a shape rather than a boolean.
 * "No sender is configured" and "a sender is configured but PORTAL_BASE_URL is
 * empty, so every link in the message would be a relative path" are the same
 * outcome and completely different problems, and an operator who has just set
 * five SMTP variables deserves to be told which one they hit.
 */
export function resolveSender(): Sender {
  const config = getConfig();
  if (!config.email.enabled) {
    return {
      kind: 'noop',
      reason:
        'Email is off (EMAIL_ENABLED is not set). Links are still minted and the request is ' +
        'recorded; nothing is delivered.',
    };
  }
  if (!config.runtime.portalBaseUrl) {
    // A set-password link with no origin is `/portal#/set-password/…`, which is
    // a working link at a terminal and a dead one in an inbox. Sending it would
    // be a delivery that looks like a success and helps nobody, so it is not a
    // send at all.
    return {
      kind: 'noop',
      reason:
        'PORTAL_BASE_URL is empty, so set-password links have no origin and would arrive in an ' +
        'inbox as unusable relative paths. Set it to the portal origin, e.g. ' +
        'https://partners.example.com.',
    };
  }
  const { email } = config;
  return {
    kind: 'smtp',
    settings: {
      host: email.host,
      port: email.port,
      user: email.user,
      password: email.password,
      from: email.from,
      fromAddress: email.fromAddress,
      implicitTls: email.implicitTls,
      allowInsecure: email.allowInsecure,
    },
  };
}

/* ---------------------------------------------------------------- content */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "13 August 2026 at 09:14 UTC" — unambiguous to a reader in any country. */
function readableExpiry(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toUTCString().replace(/ GMT$/, ' UTC')}`;
}

/** A first name if there is one, so the greeting is not "Hello ,". */
function greeting(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first ? `Hello ${first},` : 'Hello,';
}

/**
 * The message.
 *
 * Written to answer, in order, the four questions a partner actually has when
 * an unexpected mail asks them to set a password: who is this, why am I getting
 * it, does it change anything about my money, and how long do I have. Anything
 * that is not one of those is left out — there is no logo, no image, no tracking
 * pixel, no unsubscribe funnel, and no "exciting news". A partner who has been
 * earning with us for two years does not need to be sold to, and a mail that
 * looks like marketing is a mail that lands in spam.
 *
 * The link is written out in full in the text part rather than hidden behind
 * anchor text, so that a reader can see where it goes before they click it —
 * which is also the advice we would give them about any other mail.
 */
export function buildSetPasswordEmail(
  link: SetPasswordLink,
  senderName: string,
): EmailMessage {
  const expires = readableExpiry(link.expiresAt);
  const from = senderName || 'the affiliate program';

  const paragraphs = [
    greeting(link.name),
    `We have moved our affiliate program onto our own portal, and your account has ` +
      `moved with it. You are getting this because you are already one of our affiliates ` +
      `— this is not a new signup and there is nothing to apply for again.`,
    `Nothing about your account has changed:`,
  ];

  const unchanged = [
    'Your existing referral links keep working exactly as they are. You do not need to replace them anywhere.',
    'Your referrals and everything you have earned so far have carried over unchanged.',
    'Your commission terms are the same.',
  ];

  const tail = [
    `The one thing the new portal does not have is a password for you. Set one here:`,
    link.url,
    `That link works once and stops working after 24 hours — it expires at ${expires}. ` +
      `If it has already expired by the time you read this, you can ask for a new one from ` +
      `the sign-in page.`,
    `If you were not expecting this, nothing has happened to your account and nothing will ` +
      `unless the link above is used. If you think it reached you by mistake, reply to this ` +
      `message and tell us.`,
    `— ${from}`,
  ];

  const text = [
    ...paragraphs,
    ...unchanged.map((line) => `  - ${line}`),
    ...tail,
  ].join('\n\n');

  const html = [
    // Inline styles only, and barely any: a mail client will strip a <style>
    // block, and the message has to read correctly with every style gone.
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:34em">`,
    ...paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<ul>${unchanged.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    `<p>${escapeHtml(tail[0]!)}</p>`,
    `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.url)}</a></p>`,
    ...tail.slice(2).map((line) => `<p>${escapeHtml(line)}</p>`),
    `</div>`,
  ].join('');

  return {
    to: link.email,
    toName: link.name,
    subject: `Set your password for the ${from} partner portal`,
    text,
    html,
  };
}

/* ------------------------------------------------------------------- send */

export interface DeliveryOutcome extends SendResult {
  /** False when no send was attempted at all — the no-op sender. */
  attempted: boolean;
}

/**
 * Send one affiliate their set-password link and record the attempt.
 *
 * The record is written on both outcomes, and the failure text comes from the
 * relay. `link.url` reaches `sendMail` and goes no further: it is not in the
 * record, not in the return value, and not in any string this function builds
 * for a caller to log.
 */
export async function sendSetPasswordEmail(
  db: Db,
  link: SetPasswordLink,
  sender: Sender = resolveSender(),
): Promise<DeliveryOutcome> {
  if (sender.kind === 'noop') {
    return { attempted: false, ok: false, permanent: false, error: sender.reason };
  }

  const message = buildSetPasswordEmail(link, getConfig().email.senderName);
  const result = await sendMail(sender.settings, message);

  recordEmailAttempt(db, {
    affiliateId: link.affiliateId,
    email: link.email,
    ok: result.ok,
    error: result.error,
  });

  return { attempted: true, ...result };
}

/**
 * The self-service path's sender, wired into `deliverSetPasswordLink`.
 *
 * Not awaited by the route that calls it, and that is a security decision rather
 * than a performance one. `/request-reset` answers identically whether or not
 * the address is one of ours, on purpose — awaiting an SMTP round trip would
 * make the response time say what the response body refuses to, and turn a list
 * of email addresses into a list of which of them are our affiliates. So the
 * send runs behind the answer and reports its own failures.
 *
 * The catch is total. A relay being down must not take out the portal.
 */
export function deliverInBackground(link: SetPasswordLink, db: Db = getDb()): void {
  void sendSetPasswordEmail(db, link)
    .then((outcome) => {
      if (outcome.ok) return;
      // The address is named and the link is not. Knowing which affiliate is
      // stuck is the whole point of the line; the token would make the line a
      // vulnerability.
      console.warn(
        `[partnerdex] could not email a set-password link to ${link.email}: ` +
          `${outcome.error ?? 'unknown error'}`,
      );
    })
    .catch((cause: unknown) => {
      console.error(`[partnerdex] set-password email failed for ${link.email}:`, cause);
    });
}

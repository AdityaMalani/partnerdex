import express from 'express';
import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { applyForSignup, listOpenPrograms, SignupError } from '../affiliates/signup.js';
import { clientKey } from './auth.js';
import { issueSetPasswordLink, deliverSetPasswordLink } from './portalAuth.js';
import { listingUrlForProgram } from './referralRedirect.js';
import { createThrottle } from './throttle.js';

/**
 * `GET /portal/api/signup/programs` and `POST /portal/api/signup` — the front
 * door for a partner who is not one yet.
 *
 * **This is the first fully public write endpoint in this product**, and the
 * pre-launch security review of the portal is a list of the ways the last batch
 * of public surface went wrong. Every finding in it that could apply here is
 * answered below, in the code rather than in a checklist:
 *
 *   - **Findings 1, 2 and 5 — the throttle.** It reuses `createThrottle` from
 *     `throttle.ts`, which is where the decay, the lockout ceiling and the map
 *     eviction were fixed. A second rate limiter written here would be a second
 *     place for all three to be wrong again. The key is derived from
 *     `clientKey`, which reads `request.ip` under the configured
 *     `TRUST_PROXY_HOPS` rather than trusting a header outright.
 *   - **Finding 4 — the timing oracle.** The login leaked which addresses are
 *     ours because a missing account skipped the expensive hash. Signup would
 *     leak the same fact more directly, so the response is identical either way
 *     *and* both paths execute the same statements; see `POST /` below for what
 *     that does and does not buy.
 *   - **Finding 3 — secrets in the log.** Nothing here writes a token, a link,
 *     or an applicant's address into a log line. Delivery goes through the one
 *     seam (`deliverSetPasswordLink`) that the mail sender plugs into.
 *
 * And one rule that is specific to this endpoint: **no unauthenticated caller
 * learns anything about anybody else.** Not whether an address is already an
 * affiliate, not how many affiliates there are, not which merchants exist. The
 * only thing `GET /programs` returns is the offer itself, which is the offer we
 * are inviting strangers to accept.
 */

/**
 * One counter, keyed on the client address alone — and that is a deliberate
 * departure from the login next door, which keys on (address, account).
 *
 * The login mixes the account in because a lockout there denies an *existing*
 * affiliate their own account, and letting one attacker shut out everyone behind
 * an office NAT was finding 2. Signup has neither property. There is no account
 * to protect yet, and mixing the email into the key would be actively wrong: the
 * email is chosen by the attacker, so a per-email budget is an unlimited budget
 * — rotate the address and every request is the first one. The thing being
 * rationed here is "rows written into a money ledger by a stranger", and the
 * only identifier that resists rotation is where the request came from.
 *
 * The cost of that choice, stated rather than discovered: two people applying
 * from the same office share a budget, and a determined attacker on a shared
 * address can stop their neighbours applying. That is bounded — a signup denied
 * now can be made 15 minutes later, and nobody loses access to anything they
 * already have. It is a real cost and it is the smaller one.
 *
 * The budget is generous because a person who mistypes their address, corrects
 * it, and adds the second program is three requests deep before doing anything
 * unusual.
 */
const signupThrottle = createThrottle({
  maxAttempts: 8,
  lockoutMs: 60_000,
  maxLockoutMs: 15 * 60_000,
  decayMs: 5 * 60_000,
});

/** Every key handed to the throttle, so the test seam can drop them all. */
const signupThrottleKeys = new Set<string>();

/** Test seam: a per-process counter no test should have to wait out. */
export function resetSignupThrottle(): void {
  signupThrottleKeys.forEach((key) => signupThrottle.clear(key));
  signupThrottleKeys.clear();
}

function throttleKey(request: express.Request): string {
  const key = `signup:${clientKey(request)}`;
  signupThrottleKeys.add(key);
  return key;
}

export function signupRouter(): express.Router {
  const router = express.Router();

  /**
   * What a prospective partner is offered.
   *
   * Public, and the exact boundary of what "public" means here is the point.
   * Each field is either the terms of the offer or a link to a page anyone can
   * already open. `listOpenPrograms` returns no app id, no affiliate counts, no
   * external ids and no closed programs; nothing about a merchant is reachable
   * from this router at all.
   *
   * Not throttled. It is a read of two rows with no per-caller state and no
   * write behind it, so a counter would buy nothing that the process's own
   * limits do not already provide — and a signup form that 429s before it has
   * rendered is a partner lost to a defence with nothing to defend.
   */
  router.get('/programs', (_request, response) => {
    try {
      const db = getDb();
      const { affiliateTermsUrl } = getConfig().runtime;

      response.json({
        programs: listOpenPrograms(db).map((program) => ({
          ...program,
          // The App Store page, resolved the same way a referral link is, so an
          // applicant sees the listing they would actually be promoting.
          listingUrl: listingUrlForProgram(db, program.id) ?? '',
        })),
        // Empty unless an operator has configured one. The form renders the
        // checkbox only when there is a document to agree to — see
        // `AFFILIATE_TERMS_URL` in config.ts for why there is none today.
        termsUrl: affiliateTermsUrl,
      });
    } catch (error) {
      // Deliberately not `sendError`: a stranger gets a fixed sentence, and the
      // detail goes to the log where the operator is.
      console.error('[partnerdex] signup program list failed:', error);
      response.status(500).json({ error: 'Applications are unavailable right now.' });
    }
  });

  /**
   * Apply.
   *
   * The response is the same object for every accepted application — a new
   * partner, an existing affiliate joining their second program, and a stranger
   * probing somebody else's address all get `{ ok: true }` and the same
   * sentence. That is the whole defence against this becoming a roster oracle,
   * and it is why nothing about the outcome (whether an account already existed,
   * which memberships were created, what handle was minted) appears here. The
   * applicant learns their real state after they set a password and sign in,
   * where they are authenticated as themselves.
   *
   * **Timing.** Both paths run the same sequence: one lookup by email, one
   * write to the affiliate row, a membership check and possibly a write per
   * program, and one token mint. The costs that differ — an INSERT into a
   * `WITHOUT ROWID` table versus not, one membership row that already exists
   * versus one that has to be created — are tens of microseconds inside a
   * request whose floor is a socket round trip. Be exact about the limit of
   * that, because the review's finding 4 was a 25× gap that a single probe could
   * read: this endpoint equalizes the *shape* of the work, not every instruction
   * of it, and it has no expensive constant-cost operation to hide behind the
   * way the login has scrypt. If a measurement ever separates the two paths, the
   * fix is a fixed time floor on the whole handler, not more careful branches.
   *
   * **What an attacker can still do**, since it is better written down than
   * discovered: submit an application for an address they do not own. The result
   * is a pending or enrolled membership attached to that person's account and a
   * set-password link they did not ask for — the same capability
   * `/auth/request-reset` already gives anyone who knows an address, and it
   * moves no money: the applicant still cannot sign in, and an unwanted
   * membership is one click for an admin to reject. The throttle is what keeps
   * it from being done at scale.
   */
  router.post('/', (request, response) => {
    const locked = signupThrottle.lockoutSeconds(throttleKey(request));
    if (locked > 0) {
      response
        .status(429)
        .json({ error: `Too many applications from here. Try again in ${locked} second(s).` });
      return;
    }
    // Counted on every request, accepted or refused. A counter that only bit on
    // one outcome would be a signal about which outcome happened, which is the
    // same mistake as a login that answers faster for an address it does not
    // know. `request-reset` counts unconditionally for exactly this reason.
    signupThrottle.recordFailure(throttleKey(request));

    const body = (request.body ?? {}) as Record<string, unknown>;
    const { affiliateTermsUrl } = getConfig().runtime;

    try {
      const db = getDb();
      const outcome = applyForSignup(
        {
          name: typeof body.name === 'string' ? body.name : '',
          email: typeof body.email === 'string' ? body.email : '',
          programIds: Array.isArray(body.programIds)
            ? // Bounded before it reaches the domain layer as well as inside it:
              // a million-element array would otherwise be mapped to strings
              // before anything checked how long it was.
              body.programIds.slice(0, 32).map((id) => String(id))
            : [],
          acceptedTerms: body.acceptedTerms === true,
          // Taken from config, never from the body. A caller that could name the
          // terms it agreed to could record itself as having agreed to anything.
          termsUrl: affiliateTermsUrl,
        },
        db,
      );

      /*
       * Onboarding reuses the existing set-password token flow — the same
       * `issueResetToken` the imported affiliates come in through, the same
       * 24-hour single-use link, the same digest-only storage. There is
       * deliberately no second credential path: a signup that set its own
       * password would be a second place for the password rules, the session-key
       * derivation and the token invalidation to be subtly different.
       *
       * The token is minted and handed to the delivery seam. It is never in this
       * response — returning it would make every account takeable by anyone who
       * knows an address — and never in a log line. Until a sender is wired into
       * that seam the operator mints the link from the admin route; that is the
       * same state every imported affiliate is already in.
       */
      const link = issueSetPasswordLink(db, outcome.affiliateId);
      if (link) deliverSetPasswordLink(link);

      response.json({
        ok: true,
        // One sentence, identical for every accepted application. It promises
        // an email rather than describing what happened, because describing what
        // happened is exactly the disclosure this endpoint refuses to make.
        message:
          'Thanks — check your email for a link to set your password. ' +
          'If that address is already on our affiliate list, the link signs you into the ' +
          'account you already have.',
      });
    } catch (error) {
      // Only the 4xx half of `SignupError` is a message for the applicant. Its
      // 5xx case — a handle that could not be allocated — carries a diagnosis
      // written for whoever fixes it, and that reader is not the stranger.
      if (error instanceof SignupError && error.status < 500) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      // The applicant is told nothing about the failure. Note what is *not*
      // interpolated into this line: no name, no address, no program id.
      // Everything in the request is attacker-controlled, and a log line is read
      // by tools that treat a newline as a record boundary.
      console.error('[partnerdex] affiliate signup failed:', error);
      response.status(500).json({ error: 'We could not record that application. Try again.' });
    }
  });

  return router;
}

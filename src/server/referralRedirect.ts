import express from 'express';
import { getDb, type Db } from '../db/index.js';
import { HANDLE_SHAPE } from '../affiliates/ga4Attribution.js';

/**
 * `GET /r/:handle` — the affiliate link itself.
 *
 * The only route in this server that is public by design, and the only one whose
 * failure mode is measured in money: a link that 404s is a click somebody was
 * paid to generate and we threw away. So the behaviour leans one way throughout
 * — when in doubt, send the visitor to the App Store and record the doubt.
 *
 * Three things follow from that:
 *
 *   - **An unrecognised handle still redirects**, to the program's listing with
 *     the parameter intact, and is logged. Handles from before this system
 *     existed will keep arriving for months on links printed in blog posts and
 *     YouTube descriptions; refusing them loses the install *and* the chance to
 *     reattribute it later, because GA4 records the click either way and the log
 *     is what tells an admin which handle to go looking for.
 *   - **The shape is validated before use.** `:handle` is attacker-controlled
 *     text on an unauthenticated route that ends in a `Location` header, so it
 *     is matched against the same eight-character pattern the GA4 attribution
 *     pipeline uses and rejected outright otherwise. Nothing unvalidated is ever
 *     concatenated into the URL.
 *   - **It is rate-limited**, because it is public, does a database read, and
 *     writes a log line per unknown handle.
 *
 * The redirect is a 302 rather than a 301: a permanent redirect is cached by the
 * browser and by every proxy in between, which would make a mis-mapped listing
 * uncorrectable and would stop the click ever reaching this server again.
 */

/**
 * Requests allowed per client per window.
 *
 * Generous, because the legitimate pattern is bursty in a way that looks like
 * abuse: a newsletter goes out, an office NATs two hundred readers behind one
 * address, and every one of them clicks within a minute. The ceiling is here to
 * stop a scraper walking the handle space and to keep the log from being a
 * denial-of-service target, not to police enthusiasm.
 */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

const hits = new Map<string, { count: number; resetAt: number }>();

function overRateLimit(key: string, now = Date.now()): boolean {
  const record = hits.get(key);
  if (!record || record.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    // A fixed window keeps one number per client and forgets it on the hour.
    // Sweeping expired entries here rather than on a timer means an idle process
    // holds nothing; the map only ever grows while traffic is flowing.
    if (hits.size > 10_000) {
      for (const [existing, value] of hits) if (value.resetAt <= now) hits.delete(existing);
    }
    return false;
  }
  record.count += 1;
  return record.count > RATE_LIMIT;
}

/** Test seam: the window is a minute, which no test should have to wait out. */
export function resetRateLimit(): void {
  hits.clear();
}

/**
 * Which listing a program points at, in decreasing order of who said so.
 *
 * `app_listings` first: that is the operator's own mapping, entered on the App
 * listings page, and it outranks anything else. Then the program's own
 * `listing_url`, which is how a program whose app has not synced yet still has
 * a link, since `app_listings` is keyed on an app id it does not have.
 *
 * There is no third source, and that is the point. A slug inferred from a
 * program's name sends a visitor to a page that may not exist, or to somebody
 * else's app, and does it silently — the click is spent, the install is
 * credited to the wrong program, and nothing anywhere says so. Null is the
 * honest answer, and the route decides what to do with it.
 */
export function listingUrlForProgram(db: Db, programId: string): string | null {
  const program = db
    .prepare(
      `SELECT p.listing_url AS programListingUrl,
              (SELECT url FROM app_listings WHERE app_id = p.app_id) AS listingUrl
         FROM affiliate_programs p
        WHERE p.id = ?`,
    )
    .get(programId) as
    | { programListingUrl: string; listingUrl: string | null }
    | undefined;
  if (!program) return null;

  return program.listingUrl || program.programListingUrl || null;
}

/**
 * The link an affiliate is given.
 *
 * Relative on purpose: this server does not know its own public hostname — it
 * may be behind a proxy, a tunnel or neither — and a link built from a guessed
 * origin is worse than one the reader's browser resolves against the page it is
 * already on.
 */
export function referralUrl(handle: string): string {
  return `/r/${encodeURIComponent(handle)}`;
}

/**
 * Where a click ends up, and whether the handle was one of ours.
 *
 * `known` is reported separately from `url` because the two questions have
 * different answers and the caller needs both: an unrecognised handle is worth
 * logging whether or not it could be served, and a recognised one is worth
 * serving even when its program has no listing mapped.
 */
export function destinationFor(
  db: Db,
  handle: string,
): { url: string | null; known: boolean } {
  const memberships = db
    .prepare(
      `SELECT m.program_id AS programId, m.status
         FROM affiliate_memberships m
         JOIN affiliates a ON a.id = m.affiliate_id
        WHERE m.handle = ? AND a.status = 'active'
        ORDER BY CASE m.status WHEN 'enrolled' THEN 0 ELSE 1 END, m.joined_at`,
    )
    .all(handle) as Array<{ programId: string; status: string }>;

  /*
   * A handle is unique per program, not globally: two affiliates in the imported
   * data hold both programs under one code, so a click on `/r/abcd1234` is
   * genuinely ambiguous about which listing was meant. The enrolled membership
   * wins, then the oldest — and the ambiguity is harmless downstream, because
   * attribution is decided by the listing the visitor actually installed from,
   * not by this choice.
   */
  const enrolled = memberships.find((row) => row.status === 'enrolled') ?? memberships[0];
  if (enrolled) {
    const url = listingUrlForProgram(db, enrolled.programId);
    if (url) return { url, known: true };
  }
  const known = memberships.length > 0;

  /*
   * Unknown, or known with no listing mapped anywhere.
   *
   * The click is still real, so it is worth serving — but only if there is one
   * possible answer. With a second listing mapped there is no way to tell which
   * app a legacy code belonged to, and guessing sends a visitor to install the
   * wrong one: a worse outcome than the 404, and one that would go on to
   * attribute an install nobody asked for. So a single mapped listing is
   * followed and anything more is refused — after the log line, which is what
   * actually preserves the referral for reattribution.
   */
  const listings = db.prepare('SELECT url FROM app_listings ORDER BY app_id LIMIT 2').all() as
    | Array<{ url: string }>;
  if (listings.length === 1) return { url: listings[0]!.url, known };

  return { url: null, known };
}

export function referralRedirectRouter(): express.Router {
  const router = express.Router();

  router.get('/:handle', (request, response) => {
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    if (overRateLimit(key)) {
      response.status(429).type('text/plain').send('Too many requests. Try again shortly.');
      return;
    }

    const raw = request.params.handle ?? '';
    // Lowercased before the shape test, not after: the handle column collates
    // NOCASE and these codes get retyped out of print with a capital letter.
    const handle = raw.trim().toLowerCase();
    if (!HANDLE_SHAPE.test(handle)) {
      // Not logged as an unknown handle — this is a crawler or a typo'd path,
      // not a referral code, and mixing the two would bury the ones worth
      // reattributing under noise.
      response.status(404).type('text/plain').send('Unknown referral link.');
      return;
    }

    let destination: { url: string | null; known: boolean };
    try {
      destination = destinationFor(getDb(), handle);
    } catch (error) {
      console.error('[partnerdex] referral redirect failed:', error);
      response.status(500).type('text/plain').send('Referral link unavailable.');
      return;
    }

    if (!destination.known) {
      // The whole point of the log line, and it is written before the response
      // is decided so it survives the case that cannot be served. A stray or
      // legacy code is a real referral by a real person that this system cannot
      // yet credit; recorded here, an admin can attribute the install by hand
      // later — the same manual path a large minority of the imported referrals
      // took.
      console.warn(
        `[partnerdex] unrecognised referral handle "${handle}"` +
          `${destination.url ? ' — redirected anyway' : ' — nowhere to send it'}, ` +
          'attribute the install manually if one follows.',
      );
    }

    if (!destination.url) {
      response.status(404).type('text/plain').send('Unknown referral link.');
      return;
    }

    const target = new URL(destination.url);
    target.searchParams.set('mref', handle);
    // Never cached: a 302 that a proxy holds onto is a click this server stops
    // seeing, and the listing mapping behind it can change.
    response.set('Cache-Control', 'no-store');
    response.redirect(302, target.toString());
  });

  return router;
}

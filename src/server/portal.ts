import express from 'express';
import { getDb, type Db } from '../db/index.js';
import { currentAffiliate } from './portalAuth.js';
import { listingReferralUrl } from '../affiliates/listings.js';
import { AFFILIATE_PAYOUT_SORTS, listPayoutsForAffiliate } from '../affiliates/payouts.js';
// Attribution claims. Kept as its own import block so a merge that lands two
// features on this file is a mechanical one.
import {
  ClaimSubmissionError,
  listClaimsForAffiliate,
  submitClaim,
} from '../affiliates/claims.js';
import { createThrottle } from './throttle.js';
// One parser for the JSON `revenue_components` column, shared with the admin
// read model and the public signup list, so the three cannot disagree about what
// a malformed value means.
import { parseRevenueComponents } from '../affiliates/signup.js';
import { listingUrlForProgram, referralUrl } from './referralRedirect.js';
import { sendError } from './errors.js';

/**
 * What an affiliate can see: their own row, and nothing that is not a function
 * of it.
 *
 * Two rules hold this file together, and both are stated as rules because they
 * are the kind of thing that erodes one convenient query at a time.
 *
 * **Every query is scoped by `affiliate_id`, taken from the session.** Not from
 * a path parameter, not from a query string, not from a body. There is no route
 * here that names an affiliate, which means there is no route where changing a
 * number in a URL reads somebody else's earnings. The scoping predicate is a
 * bound parameter on the same statement that selects the rows, never a filter
 * applied afterwards in JavaScript.
 *
 * **Nothing about the merchant leaves except their name.** Mantle showed
 * affiliates the shop name and that is the bar being matched: no merchant email,
 * no access token, no myshopify domain — with one stated exception, the store
 * label, described at `SHOP_NAME_SQL` — and no revenue figure other than the
 * affiliate's own commission. That last one is the easiest to get wrong, because
 * `affiliate_commissions.basis_amount` sits right beside `amount` and is the
 * merchant's gross — publishing it would let an affiliate read the exact
 * subscription revenue of every store they ever referred. It is excluded from
 * every SELECT below, deliberately, and `rate` is not: the commission rate is
 * the affiliate's own term and they are entitled to check the arithmetic.
 */

/**
 * How a merchant is named to an affiliate.
 *
 * `shops.name` when the merchant has synced. When they have not — which is the
 * normal state for a chunk of the imported referrals, whose shop rows arrive
 * only as the Partner API backfill reaches them — the store label from the
 * myshopify domain stands in.
 *
 * Be exact about what that means, because the comment that used to sit here was
 * not and the review caught it. The label is the first component of the domain,
 * so `acme.myshopify.com` leaves this file as `acme`, and one string
 * concatenation puts the domain back. Saying "the domain never leaves this file"
 * was therefore false in the way that matters: a reader who trusted it would
 * have been wrong about what an affiliate can see.
 *
 * It is kept anyway, deliberately. The alternative is showing "Merchant" against
 * hundreds of rows on the one page an affiliate opens to check they are being
 * paid for the stores they sent us — a page that cannot do its job while the
 * merchants on it are anonymous. And the disclosure is narrow: every row here is
 * already scoped to this affiliate's own referrals, so the only domains
 * reconstructible are those of merchants they themselves referred and therefore
 * already know. What is *not* exposed is any merchant they did not refer, which
 * is the boundary that actually matters and the one the tests assert.
 *
 * The rule this file holds to, stated so it can be checked: nothing here emits a
 * merchant's full domain, email, id or revenue. A store label for one of the
 * affiliate's own referrals is in scope; everything else about a merchant is not.
 */
const SHOP_NAME_SQL = `
  COALESCE(
    NULLIF(s.name, ''),
    NULLIF(SUBSTR(a.myshopify_domain, 1, INSTR(a.myshopify_domain || '.', '.') - 1), ''),
    'Merchant'
  )`;

interface MembershipView {
  membershipId: string;
  programId: string;
  program: string;
  handle: string;
  status: string;
  joinedAt: string;
  /** The link to share. Null when the program has no listing mapped yet. */
  referralUrl: string | null;
  commissionRate: number;
  durationMonths: number | null;
}

function membershipsFor(db: Db, affiliateId: string): MembershipView[] {
  const rows = db
    .prepare(
      `SELECT m.id AS membershipId, m.program_id AS programId, m.handle, m.status,
              m.joined_at AS joinedAt,
              COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS program,
              p.commission_rate AS commissionRate, p.duration_months AS durationMonths
         FROM affiliate_memberships m
         JOIN affiliate_programs p ON p.id = m.program_id
         LEFT JOIN apps app ON app.id = p.app_id
        WHERE m.affiliate_id = ?
        ORDER BY m.joined_at`,
    )
    .all(affiliateId) as Array<Omit<MembershipView, 'referralUrl'>>;

  return rows.map((row) => ({
    ...row,
    // Only an enrolled membership gets a link. A pending application has a
    // handle in the table — the import carries one for every membership — and
    // handing it over would invite an affiliate to promote a program they have
    // not been approved for and then argue about the commission.
    referralUrl:
      row.status === 'enrolled' && listingUrlForProgram(db, row.programId)
        ? referralUrl(row.handle)
        : null,
  }));
}

/**
 * How fast one affiliate may file claims.
 *
 * The *shared* `createThrottle`, not a second implementation — the security
 * review's standing rule, and for the usual reason: a lockout written twice is
 * a lockout that is subtly wrong in one of the two places. Everything the
 * shared one learned the hard way (failures decay, the escalation has a
 * ceiling, the key map is bounded and swept) applies here unchanged.
 *
 * Keyed on the **affiliate id from the session**, not the client address. Every
 * caller here is authenticated, so the account is the actor that matters and it
 * is the one an attacker cannot rotate: address-keying would put a NAT's worth
 * of partners in one bucket for no gain, since none of them can reach this
 * route without an account of their own anyway.
 *
 * The numbers are sized against the real shape of the data rather than picked
 * round. Filing a claim is a considered act — a person naming a merchant they
 * believe they referred — so 20 in a burst is already far past normal, and the
 * bucket refills one slot every two minutes, which is roughly 30 an hour
 * sustained. The largest claimant in the imported ledger filed 121 claims over
 * *months*; that history is comfortably reachable at this rate and a script
 * walking a domain list is not, which is the whole distinction being drawn. The
 * cap is on the noise a single account can make, and it stacks in front of the
 * no-enumeration property rather than substituting for it: even at one request
 * a minute forever, this endpoint answers the same thing for every merchant, so
 * the throttle bounds cost and queue spam, not disclosure.
 */
const claimThrottle = createThrottle({
  maxAttempts: 20,
  lockoutMs: 60_000,
  maxLockoutMs: 15 * 60_000,
  decayMs: 2 * 60_000,
});

/** Every key handed to the claim throttle, so the test seam can drop them all. */
const claimThrottleKeys = new Set<string>();

function claimKey(affiliateId: string): string {
  const key = `claim:${affiliateId}`;
  claimThrottleKeys.add(key);
  return key;
}

/** Test seam: a per-process counter no test should have to wait out. */
export function resetClaimThrottle(): void {
  claimThrottleKeys.forEach((key) => claimThrottle.clear(key));
  claimThrottleKeys.clear();
}

export function portalRouter(): express.Router {
  const router = express.Router();

  /** The affiliate, their programs, and the links they can share. */
  router.get('/me', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const db = getDb();

      const affiliate = db
        .prepare(
          `SELECT id, name, email, paypal_email AS paypalEmail, payout_hold AS payoutHold,
                  created_at AS createdAt
             FROM affiliates WHERE id = ?`,
        )
        .get(affiliateId) as
        | {
            id: string;
            name: string;
            email: string;
            paypalEmail: string | null;
            payoutHold: number;
            createdAt: string;
          }
        | undefined;

      if (!affiliate) {
        // Only reachable if the row went away between the session check and
        // here, which is a deletion mid-request rather than an unknown caller.
        response.status(404).json({ error: 'Account not found.' });
        return;
      }

      response.json({
        affiliate: {
          name: affiliate.name,
          email: affiliate.email,
          paypalEmail: affiliate.paypalEmail,
          // Said plainly rather than hidden: an affiliate whose payments are
          // held is going to ask why their balance is not moving.
          payoutHold: affiliate.payoutHold === 1,
          memberSince: affiliate.createdAt,
        },
        memberships: membershipsFor(db, affiliateId),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The merchants this affiliate referred.
   *
   * Soft-deleted referrals are included and labelled, not hidden. An affiliate
   * whose merchant was unassigned 30 days after uninstalling needs to see that
   * happen, or the commissions simply stop with no explanation on the page.
   */
  router.get('/referrals', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const db = getDb();

      const referrals = db
        .prepare(
          `SELECT a.id AS referralId,
                  COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS program,
                  ${SHOP_NAME_SQL} AS shop,
                  a.referred_at AS referredAt,
                  a.deleted_at AS unassignedAt,
                  (SELECT COUNT(*) FROM affiliate_commissions c
                    WHERE c.attribution_id = a.id AND c.affiliate_id = a.affiliate_id
                      AND c.cancelled_at IS NULL) AS commissionCount,
                  (SELECT COALESCE(SUM(c.amount), 0) FROM affiliate_commissions c
                    WHERE c.attribution_id = a.id AND c.affiliate_id = a.affiliate_id
                      AND c.cancelled_at IS NULL) AS earned,
                  (SELECT MAX(c.earned_at) FROM affiliate_commissions c
                    WHERE c.attribution_id = a.id AND c.affiliate_id = a.affiliate_id
                      AND c.cancelled_at IS NULL) AS lastCommissionAt
             FROM affiliate_attributions a
             JOIN affiliate_programs p ON p.id = a.program_id
             LEFT JOIN apps app ON app.id = p.app_id
             LEFT JOIN shops s ON s.id = a.shop_id
            WHERE a.affiliate_id = ?
            ORDER BY a.referred_at DESC`,
        )
        .all(affiliateId) as Array<Record<string, unknown>>;

      response.json({ referrals, total: referrals.length });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The balance, in the four states money can be in here.
   *
   * "Unpaid" is not a promise of payment on any date — payouts are processed
   * outside this system entirely — so the response says what has been earned and
   * what has been settled, and leaves the scheduling to whoever does it.
   */
  router.get('/earnings', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const db = getDb();

      const totals = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN cancelled_at IS NULL THEN amount ELSE 0 END), 0) AS lifetime,
                  COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND paid_at IS NOT NULL
                                    THEN COALESCE(paid_amount, amount) ELSE 0 END), 0) AS paid,
                  COALESCE(SUM(CASE WHEN cancelled_at IS NULL AND paid_at IS NULL
                                    THEN amount ELSE 0 END), 0) AS unpaid,
                  COALESCE(SUM(CASE WHEN cancelled_at IS NOT NULL THEN amount ELSE 0 END), 0) AS cancelled,
                  COUNT(*) AS commissions,
                  MAX(earned_at) AS lastEarnedAt
             FROM affiliate_commissions WHERE affiliate_id = ?`,
        )
        .get(affiliateId) as Record<string, number | string | null>;

      const byProgram = db
        .prepare(
          `SELECT COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS program,
                  COALESCE(SUM(c.amount), 0) AS amount,
                  COUNT(*) AS commissions
             FROM affiliate_commissions c
             JOIN affiliate_programs p ON p.id = c.program_id
             LEFT JOIN apps app ON app.id = p.app_id
            WHERE c.affiliate_id = ? AND c.cancelled_at IS NULL
            GROUP BY p.id
            ORDER BY amount DESC`,
        )
        .all(affiliateId) as Array<Record<string, unknown>>;

      // Twelve months of history, which is the span a statement is read over.
      // Grouped in UTC rather than the reporting timezone: the commission's
      // `earned_at` is the transaction's own instant, and shifting it to make a
      // month boundary prettier would move money between statements.
      const byMonth = db
        .prepare(
          `SELECT SUBSTR(earned_at, 1, 7) AS month,
                  COALESCE(SUM(amount), 0) AS amount,
                  COUNT(*) AS commissions
             FROM affiliate_commissions
            WHERE affiliate_id = ? AND cancelled_at IS NULL
            GROUP BY month
            ORDER BY month DESC
            LIMIT 12`,
        )
        .all(affiliateId) as Array<Record<string, unknown>>;

      const referrals = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active
             FROM affiliate_attributions WHERE affiliate_id = ?`,
        )
        .get(affiliateId) as { total: number; active: number };

      response.json({
        ...totals,
        // One currency in the data and one in the arithmetic. Stated rather than
        // assumed, so a second one arriving shows up as a wrong label on screen
        // instead of as silently added-up dollars and euros.
        currency: 'USD',
        referrals,
        byProgram,
        byMonth: byMonth.reverse(),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The commission history behind the balance.
   *
   * Paged, because an affiliate with two years of monthly charges across forty
   * merchants has a few thousand rows and the page only ever shows a screenful.
   */
  router.get('/commissions', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const db = getDb();

      const asNumber = (value: unknown, fallback: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const limit = Math.min(Math.max(asNumber(request.query.limit, 50), 1), 200);
      const offset = Math.max(asNumber(request.query.offset, 0), 0);

      const commissions = db
        .prepare(
          `SELECT c.id AS commissionId,
                  COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS program,
                  ${SHOP_NAME_SQL} AS shop,
                  c.amount, c.currency, c.rate,
                  c.earned_at AS earnedAt,
                  c.paid_at AS paidAt,
                  c.cancelled_at AS cancelledAt,
                  c.cancel_reason AS cancelReason
             FROM affiliate_commissions c
             JOIN affiliate_programs p ON p.id = c.program_id
             LEFT JOIN apps app ON app.id = p.app_id
             LEFT JOIN affiliate_attributions a ON a.id = c.attribution_id
             LEFT JOIN shops s ON s.id = a.shop_id
            WHERE c.affiliate_id = ?
            ORDER BY c.earned_at DESC, c.id
            LIMIT ? OFFSET ?`,
        )
        .all(affiliateId, limit, offset) as Array<Record<string, unknown>>;

      const { total } = db
        .prepare('SELECT COUNT(*) AS total FROM affiliate_commissions WHERE affiliate_id = ?')
        .get(affiliateId) as { total: number };

      response.json({ commissions, total, limit, offset });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The programs this affiliate is in, with the terms they are on.
   *
   * Separate from `/me` even though `/me` already carries memberships, because
   * the two answer different questions: `/me` is the account, this is the offer
   * — the rate, what revenue it applies to, how long it runs, and the link to
   * share. A page that shows an affiliate what they signed up for should not
   * have to read it out of an account payload.
   *
   * Terms come from the program row rather than being restated here. There are
   * no per-affiliate overrides in the data — one of the memberships carried one
   * and its value was the string "default" — so the program's terms are the
   * affiliate's terms, and a column that pretended otherwise would be inventing
   * a rule the business never had.
   */
  router.get('/programs', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const db = getDb();

      const rows = db
        .prepare(
          `SELECT m.program_id AS programId,
                  COALESCE(NULLIF(p.name, ''), NULLIF(app.name, ''), 'Program') AS programName,
                  COALESCE(app.name, '') AS appName,
                  m.handle, m.status, m.joined_at AS joinedAt, m.approved_at AS approvedAt,
                  p.commission_rate AS commissionRate,
                  p.revenue_components AS revenueComponents,
                  p.duration_months AS durationMonths,
                  -- Added because the portal was stating this number from a
                  -- constant in terms.ts — the only line of the terms page not
                  -- backed by the row it describes. It is 30 for both programs
                  -- today, which is exactly why a hardcoded copy was survivable
                  -- and exactly why it would have gone wrong quietly the first
                  -- time a program disagreed.
                  p.unassign_after_uninstall_days AS unassignAfterUninstallDays
             FROM affiliate_memberships m
             JOIN affiliate_programs p ON p.id = m.program_id
             LEFT JOIN apps app ON app.id = p.app_id
            WHERE m.affiliate_id = ?
            ORDER BY m.joined_at`,
        )
        .all(affiliateId) as Array<Record<string, unknown>>;

      response.json({
        programs: rows.map((row) => {
          const listingUrl = listingUrlForProgram(db, String(row.programId));
          return {
            ...row,
            // Stored as a JSON array because that is the shape the source
            // platform used and the settings screen will edit; parsed here so
            // the page reads a list rather than a string. A malformed value
            // degrades to the one component every commission in the data
            // actually came from rather than throwing the page away.
            revenueComponents: parseRevenueComponents(row.revenueComponents),
            // The absolute App Store link, which is what an affiliate pastes
            // into a post. Only an enrolled membership gets one: a pending
            // application already has a handle in the table — the import
            // carries one for every membership — and handing it over would
            // invite promoting a program they have not been approved for and
            // then arguing about the commission.
            referralUrl:
              row.status === 'enrolled' && listingUrl
                ? listingReferralUrl(listingUrl, String(row.handle))
                : null,
          };
        }),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The payments this affiliate has received.
   *
   * A record, not a schedule. Payouts are raised and sent outside this system
   * entirely, so nothing here promises a date, and a payout still in 'requested'
   * is shown as exactly that rather than as pending money with an implied
   * arrival.
   *
   * Scoped on the session's affiliate id, bound into the same statement that
   * selects the rows — `listPayoutsForAffiliate` takes it as its first argument
   * and has no path that omits it. No parameter of this request names an
   * affiliate, so there is no number in a URL to change.
   */
  router.get('/payouts', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const page = Number(request.query.page);
      const limit = Number(request.query.limit);

      // Validated here rather than silently defaulted, because a name this
      // list does not have is a client bug and answering 200 with a different
      // ordering hides it. Before this, an unknown name reached a shared
      // allowlist that named `a.name` — a column this query has no join for —
      // and every one of those requests was a 500 an affiliate could trigger
      // by editing a query string.
      const sort = typeof request.query.sort === 'string' ? request.query.sort : undefined;
      if (sort !== undefined && !(AFFILIATE_PAYOUT_SORTS as readonly string[]).includes(sort)) {
        response
          .status(400)
          .json({ error: `Sort by one of: ${AFFILIATE_PAYOUT_SORTS.join(', ')}.` });
        return;
      }

      response.json(
        listPayoutsForAffiliate(
          affiliateId,
          {
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            sort,
            sortDirection: request.query.sortDirection === 'asc' ? 'asc' : 'desc',
          },
          getDb(),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /* ------------------------------------------------ attribution claims --
   *
   * The claims this affiliate filed, and where each one got to.
   *
   * An affiliate may read their own claims and file a new one. They may not see
   * anybody else's, and they may not *decide* one — there is no route here that
   * approves, rejects, edits or withdraws a claim, and that asymmetry is the
   * feature. Filing is a request; deciding is the thing that moves money, and it
   * lives behind the dashboard gate in `affiliatesAdmin.ts`.
   *
   * Scoped from the session, like everything else in this file. The affiliate id
   * is bound into the same statement that selects the rows and no parameter of
   * this request names an affiliate, so there is no number in a URL to change.
   */
  router.get('/claims', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);
      const page = Number(request.query.page);
      const limit = Number(request.query.limit);

      response.json(
        listClaimsForAffiliate(
          affiliateId,
          {
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
          },
          getDb(),
        ),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * File a claim.
   *
   * The affiliate id comes from `currentAffiliate(request)` — the session —
   * exactly as it does on every other route in this file. The body carries a
   * program, a merchant and a note, and nothing in it names an affiliate; there
   * is no field to set and no id in the path to change, so a caller cannot file
   * on somebody else's behalf and cannot file *against* somebody else.
   *
   * **The response is identical for a merchant we have never heard of, one that
   * is ours and unclaimed, and one already credited to a different affiliate.**
   * That is the property this endpoint is designed around and it is enforced in
   * `submitClaim`, which never reads attribution at all — see the long comment
   * there. It matters here too, in what this handler is careful *not* to do: it
   * adds no status code, no message and no field of its own that varies with the
   * merchant. Every failure it can produce is about the body or the caller's own
   * membership, and the success body is a function of the input.
   *
   * 201 on a new claim, 200 on a duplicate. That distinction is about the
   * caller's own claim list — which they can read in full at `GET` above — and
   * is the same answer whoever the merchant belongs to.
   */
  router.post('/claims', (request, response) => {
    try {
      const { affiliateId } = currentAffiliate(request);

      // Charged before any work, including on the duplicate path: a counter that
      // only counts the requests that wrote a row makes re-filing the same
      // merchant a free way to spend this server's time.
      const key = claimKey(affiliateId);
      const locked = claimThrottle.lockoutSeconds(key);
      if (locked > 0) {
        response
          .status(429)
          .json({ error: `Too many claims filed at once. Try again in ${locked} second(s).` });
        return;
      }
      claimThrottle.recordFailure(key);

      const body = (request.body ?? {}) as Record<string, unknown>;
      const claim = submitClaim(
        {
          affiliateId,
          programId: body.programId,
          merchant: body.merchant,
          notes: body.notes,
        },
        getDb(),
      );

      response.status(claim.duplicate ? 200 : 201).json({ claim });
    } catch (error) {
      if (error instanceof ClaimSubmissionError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      sendError(response, error);
    }
  });

  /* ------------------------------------------------ end attribution claims */

  return router;
}

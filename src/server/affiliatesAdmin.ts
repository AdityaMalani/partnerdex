import express from 'express';
import { getDb } from '../db/index.js';
import {
  AffiliateAdminError,
  assignAttribution,
  decideMembership,
  getAffiliate,
  listAffiliates,
  listPendingMemberships,
  listPrograms,
  listReferrals,
  reconciliation,
  unassignAttribution,
  type AffiliateSort,
} from '../affiliates/admin.js';
import { createProgram, getProgram, updateProgram } from '../affiliates/programAdmin.js';
import { createAffiliate, updateAffiliate } from '../affiliates/affiliateAdmin.js';
import { affiliateSetupState } from '../affiliates/setup.js';
import {
  readAttributionSettings,
  updateAttributionSettings,
} from '../affiliates/attributionSettings.js';
import { REVENUE_COMPONENTS } from '../affiliates/commission.js';
import { getPayout, listPayouts } from '../affiliates/payouts.js';
// Attribution claims. Kept as its own import block so a merge that lands two
// features on this file is a mechanical one.
import { decideClaim, getClaim, listClaims } from '../affiliates/claims.js';
import { recomputeCommissions } from '../affiliates/commissionRun.js';
import {
  OnboardingError,
  planOnboarding,
  runOnboarding,
} from '../notifications/onboarding.js';
import {
  deliverSetPasswordLink,
  issueSetPasswordLink,
  type SetPasswordLink,
} from './portalAuth.js';
import { sendError } from './errors.js';

/**
 * The admin JSON API for the affiliate program.
 *
 * Mounted inside `/api`, which means it sits behind `requireAuth` — the same
 * single-password gate as the rest of the dashboard. That placement is the
 * security decision here, and it is deliberate: this router can reassign a
 * merchant and therefore move money between two people. It must never be
 * reachable from the affiliate portal's own auth realm, where the caller is one
 * of the hundreds of partners rather than the person who runs the program.
 *
 * Endpoints only. The dashboard UI is built separately and reads these.
 */
export function affiliatesAdminRouter(): express.Router {
  const router = express.Router();

  /** Everything raised deliberately here carries a status; the rest is a 500. */
  const fail = (response: express.Response, error: unknown): void => {
    if (error instanceof AffiliateAdminError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    sendError(response, error);
  };

  const pick = (request: express.Request, name: string): string | undefined => {
    const value = request.query[name];
    return typeof value === 'string' ? value : undefined;
  };

  /**
   * The affiliate list, with balances.
   *
   * Search matches name, email or handle — the three ways an affiliate is
   * named in a support thread. Default sort is outstanding balance descending,
   * because the question this page is opened to answer is "who do we owe".
   */
  router.get('/', (request, response) => {
    try {
      const limit = Number(pick(request, 'limit'));
      const offset = Number(pick(request, 'offset'));
      response.json(
        listAffiliates(
          {
            search: pick(request, 'q') ?? '',
            sort: (pick(request, 'sort') ?? 'outstanding') as AffiliateSort,
            limit: Number.isFinite(limit) ? limit : undefined,
            offset: Number.isFinite(offset) ? offset : undefined,
          },
          getDb(),
        ),
      );
    } catch (error) {
      fail(response, error);
    }
  });

  /*
   * Fixed paths ahead of `/:affiliateId`, or Express hands them to it: a
   * request for `/reconciliation` would arrive as an affiliate id and 404.
   */

  router.get('/reconciliation', (_request, response) => {
    try {
      response.json(reconciliation(getDb()));
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Every referral, across every affiliate.
   *
   * The endpoint the affiliate list page needed and did not have: without it the
   * UI fetched `/api/affiliates/:id` once per affiliate and assembled the feed
   * in the browser. Filters are the three ways the question is asked — one
   * program, one
   * affiliate, or one attribution source — and `source` is the interesting one,
   * because 'ga4' is the automated pipeline and 'manual' is an admin assigning
   * a merchant by hand, which is a large minority of the imported rows.
   *
   * Soft-deleted referrals are included and carry `standing`. That is the fix
   * for the paged-total-versus-real-total discrepancy the browser-side assembly
   * produced — see `listReferrals`, where the two definitions and why both are
   * right are written down.
   */
  router.get('/referrals', (request, response) => {
    try {
      const page = Number(pick(request, 'page'));
      const limit = Number(pick(request, 'limit'));
      response.json(
        listReferrals(
          {
            programId: pick(request, 'programId'),
            affiliateId: pick(request, 'affiliateId'),
            source: pick(request, 'source'),
            // `q` matches store name or myshopify domain, server-side, beside
            // the paging — see `merchantSearchSql`. `standing` moved here from
            // the browser for the same reason: a filter applied after paging
            // filters the page, not the population.
            search: pick(request, 'q'),
            standing: pick(request, 'standing'),
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            sort: pick(request, 'sort'),
            sortDirection: pick(request, 'sortDirection') === 'asc' ? 'asc' : 'desc',
          },
          getDb(),
        ),
      );
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * What state this programme is in, as figures.
   *
   * Read fresh on every request rather than stored, so it cannot disagree with
   * the database it describes — and so half a setup done through the API is
   * reflected without anybody having to finish a wizard they never started.
   *
   * Registered ahead of `/:affiliateId` for the same reason `/claims` is: a
   * bare word under this router is otherwise swallowed by the affiliate-detail
   * route and comes back as a 404 that reads as "no such affiliate".
   */
  router.get('/setup', (_request, response) => {
    try {
      response.json({ setup: affiliateSetupState(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Create an affiliate, and optionally enrol them in a programme.
   *
   * The verb that did not exist. An affiliate could previously only arrive
   * through the Mantle import — a one-off that will never run on a fresh
   * install — or through public self-signup, which needs the person to find the
   * portal and apply. Neither is a way for an operator to add a partner they
   * have just agreed terms with.
   *
   * Body: `{ name, email, paypalEmail?, status?, payoutHold?, programId?,
   * handle? }`. Naming a programme enrols them and returns their handle, which
   * is what makes the response actionable: an affiliate with no membership has
   * no link, and a link is the reason the operator is here.
   *
   * The response carries a **set-password link when one could be minted**, and
   * that link is an account-takeover credential with a 24-hour life. It is in
   * the body because the operator is the only one who can deliver it when no
   * mail relay is configured. It must never be logged, and `deliverSetPasswordLink`
   * is what sends it when email is on.
   */
  router.post('/', (request, response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const created = createAffiliate(body, getDb());
      const link = issueSetPasswordLink(getDb(), created.affiliate.id);
      if (link) deliverSetPasswordLink(link);
      response.status(201).json({
        affiliate: created.affiliate,
        membership: created.membership,
        setPasswordUrl: link?.url ?? null,
        setPasswordExpiresAt: link?.expiresAt ?? null,
      });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * How a click becomes a referral.
   *
   * Instance-wide rather than per programme: which programme a click belongs to
   * is only known after its handle resolves, and two programmes can share an
   * app, so a per-programme window would mean two programmes disagreeing about
   * one click with no principled tie-break.
   *
   * Saving these does not re-derive anything already credited. An attribution
   * is a durable fact with money computed from it — the opposite of a
   * programme's terms, which are a rule that prices a charge — so a change
   * applies to the next pipeline run and nothing moves between affiliates.
   */
  router.get('/attribution-settings', (_request, response) => {
    try {
      response.json({ settings: readAttributionSettings(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  router.patch('/attribution-settings', (request, response) => {
    try {
      const settings = updateAttributionSettings(
        (request.body ?? {}) as Record<string, unknown>,
        getDb(),
      );
      response.json({ settings });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Programs and their terms.
   *
   * `revenueComponents` names the vocabulary a program's terms may draw on, so
   * a settings form can offer the list rather than a free-text box that only
   * fails on save. It is a constant of this build, not of the data.
   */
  router.get('/programs', (_request, response) => {
    try {
      response.json({ programs: listPrograms(getDb()), revenueComponents: REVENUE_COMPONENTS });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Create a program.
   *
   * The endpoint that turns this from a migration into a feature. Before it,
   * every program existed because an importer had written one, and an operator
   * standing up their own had no supported way to get a row into
   * `affiliate_programs` — which meant no memberships, no referral links, no
   * attribution and no commissions. Nothing downstream needed to change: the
   * engine has always read its rules from that table.
   *
   * Body: `{ name, commissionRate, appId?, listingUrl?, revenueComponents?,
   * durationMonths?, unassignAfterUninstallDays?, requireApproval?, status? }`.
   * Terms are validated in `programAdmin.ts`; a rejected write says which field
   * and why.
   */
  router.post('/programs', (request, response) => {
    try {
      response.status(201).json({ program: createProgram((request.body ?? {}) as never, getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /** One program, for the settings screen that edits it. */
  router.get('/programs/:programId', (request, response) => {
    try {
      const program = getProgram(request.params.programId, getDb());
      if (!program) {
        response.status(404).json({ error: `No program with id ${request.params.programId}.` });
        return;
      }
      response.json({ program });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Edit a program's terms.
   *
   * A partial update: only the fields present in the body change, so a form
   * that does not render a field cannot reset it. `null` clears a duration cap
   * or an uninstall grace period, and is told apart from absent.
   *
   * A change to any versioned term writes a new row in
   * `affiliate_program_terms` effective from now, so the edit moves what
   * referrals earn from here on and leaves what they have already earned where
   * it is. `effectiveFrom` in the body backdates it, and that path is refused
   * outright — 409 — if the version would re-price a commission somebody has
   * already been paid.
   *
   * Commissions are recomputed inline and returned. That is not a convenience:
   * an edit that changes future earnings should say so at the moment it is
   * made rather than on the next sync, and a backdated one has moved something
   * the operator needs to see. Payments are untouched; the recompute has no
   * code path that writes one.
   */
  router.patch('/programs/:programId', (request, response) => {
    try {
      const program = updateProgram(
        request.params.programId,
        (request.body ?? {}) as never,
        getDb(),
      );
      response.json({ program, commissions: recomputeCommissions(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * The payout history: what has been paid, to whom, for what period.
   *
   * A read-only record of payments made outside this system — there is no route
   * here that creates, schedules or sends one, and there should not be. Filters
   * are the three ways the question is asked: one affiliate's history, one
   * program's, or everything still only requested.
   */
  router.get('/payouts', (request, response) => {
    try {
      const page = Number(pick(request, 'page'));
      const limit = Number(pick(request, 'limit'));
      response.json(
        listPayouts(
          {
            affiliateId: pick(request, 'affiliateId'),
            programId: pick(request, 'programId'),
            status: pick(request, 'status'),
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            sort: pick(request, 'sort'),
            sortDirection: pick(request, 'sortDirection') === 'asc' ? 'asc' : 'desc',
          },
          getDb(),
        ),
      );
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * One payout, itemised.
   *
   * The commissions are those that name this payout, which is the only honest
   * answer to "what did this pay for" — see `getPayout`. A payout with none is
   * returned with an empty list rather than an error: 26 payouts were imported
   * out of Mantle and a payment we cannot itemise is a finding to show, not a
   * request to fail.
   */
  router.get('/payouts/:payoutId', (request, response) => {
    try {
      const detail = getPayout(request.params.payoutId, getDb());
      if (!detail) {
        response.status(404).json({ error: `No payout with id ${request.params.payoutId}.` });
        return;
      }
      response.json(detail);
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Mint set-password links — the onboarding path for all the imported accounts.
   *
   * Every affiliate was imported without a password, so a link is the only way
   * any of them gets in. Until the security review this was done by printing
   * each requested link to stdout, which published a live account-takeover URL
   * to everyone who can read the application log; it is now this route, which is
   * inside `/api` and therefore behind `requireAuth`, plus `partnerdex
   * portal-link` for an operator at a terminal.
   *
   * Bulk on purpose. Onboarding hundreds of people one request at a time is the
   * kind of chore that gets solved by somebody grepping a log, which is the
   * thing this replaces.
   *
   * Two consequences worth stating rather than discovering:
   *
   *   - **The response body is a list of live credentials.** Twenty-four hours
   *     each, one click to own the account. It must not be logged, screenshotted
   *     into a ticket, or pasted anywhere with more readers than the mail merge
   *     it is destined for.
   *   - **Minting replaces.** One outstanding token per affiliate is the rule
   *     `issueResetToken` enforces, so running this twice invalidates the first
   *     batch. Send what you mint, or mint again for the stragglers.
   *
   * Body: `{ affiliateIds?: string[] }`. Omitted means every active affiliate.
   */
  router.post('/set-password-links', (request, response) => {
    try {
      const db = getDb();
      const body = (request.body ?? {}) as { affiliateIds?: unknown };
      const requested = Array.isArray(body.affiliateIds)
        ? body.affiliateIds.map((id) => String(id))
        : (db
            .prepare(`SELECT id FROM affiliates WHERE status = 'active' ORDER BY created_at`)
            .all() as Array<{ id: string }>).map((row) => row.id);

      const links = requested
        .map((id) => issueSetPasswordLink(db, id))
        // A named affiliate who is disabled or absent is skipped rather than
        // failing the batch: a long list of ids pasted from a spreadsheet will
        // have a stale one in it, and losing every other link to it helps nobody.
        .filter((link): link is SetPasswordLink => link !== null);

      response.json({ links, minted: links.length, requested: requested.length });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * The bulk onboarding send: mint a link for everyone who has never set a
   * password and email it to them.
   *
   * The difference between this and `/set-password-links` above is who ends up
   * holding the credential. That route answers with a live takeover link per
   * affiliate and makes the operator responsible for every one of them; this
   * route hands each link to one person's mail server and keeps none.
   *
   * `GET` is the dry run and takes no action at all — it reports who would be
   * emailed, who is held back and why, and is the thing to read before the
   * `POST`. That includes the shared-address groups, which are a decision for a
   * person and are never sent automatically; `onboarding.ts` explains why.
   *
   * `POST` sends, with a default cap. The cap is not a safety rail, it is an
   * HTTP one: a send is rate-limited to roughly one message per second, so a
   * full run is a quarter of an hour and no proxy in front of this will hold a
   * request open that long. The run is resumable by construction — membership of
   * the batch is re-derived from the delivery ledger every time — so the honest
   * shape is several calls, and the response says how many are still owed.
   *
   * Body: `{ dryRun?, limit?, resend?, affiliateIds? }`.
   */
  router.get('/onboarding-emails', (_request, response) => {
    try {
      response.json(planOnboarding(getDb()));
    } catch (error) {
      fail(response, error);
    }
  });

  /** The cap on one HTTP-driven pass. See the note above for why there is one. */
  const ONBOARDING_REQUEST_LIMIT = 100;

  router.post('/onboarding-emails', (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requested = Number(body.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.trunc(requested), ONBOARDING_REQUEST_LIMIT)
        : ONBOARDING_REQUEST_LIMIT;

    runOnboarding(getDb(), {
      dryRun: body.dryRun === true,
      limit,
      resend: body.resend === true,
      affiliateIds: Array.isArray(body.affiliateIds)
        ? body.affiliateIds.map((id) => String(id))
        : undefined,
    })
      .then((summary) => response.json(summary))
      .catch((error: unknown) => {
        if (error instanceof OnboardingError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        fail(response, error);
      });
  });

  /** One link, for the support answer to "I never got my invite". */
  router.post('/:affiliateId/set-password-link', (request, response) => {
    try {
      const link = issueSetPasswordLink(getDb(), request.params.affiliateId);
      if (!link) {
        response
          .status(404)
          .json({ error: `No active affiliate with id ${request.params.affiliateId}.` });
        return;
      }
      response.json({ link });
    } catch (error) {
      fail(response, error);
    }
  });

  /** The approval queue, across every program whose `require_approval` is set. */
  router.get('/memberships/pending', (_request, response) => {
    try {
      response.json({ memberships: listPendingMemberships(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Decide an application.
   *
   * A rejection is a recorded decision, not a deletion — see `decideMembership`
   * — and an approval rewinds the app's attribution watermark so the next sync
   * looks for clicks this affiliate sent while they were waiting.
   */
  router.post('/memberships/:membershipId/:decision', (request, response) => {
    try {
      const decision = request.params.decision;
      // Validated here rather than as a path pattern so an unknown verb is a
      // stated 400 instead of a 404 that reads as "no such membership".
      if (decision !== 'approve' && decision !== 'reject') {
        throw new AffiliateAdminError(`Decide with "approve" or "reject", not "${decision}".`);
      }
      response.json(decideMembership(request.params.membershipId, decision, getDb()));
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Assign a merchant to an affiliate by hand.
   *
   * The path that accounts for a large minority of the imported referrals.
   * Commissions are recomputed inline rather than left to the next sync: the
   * person doing this is looking at a balance and needs to see it change, and
   * the recompute is a few hundred indexed reads.
   */
  router.post('/:affiliateId/attributions', (request, response) => {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const result = assignAttribution(
        {
          affiliateId: request.params.affiliateId,
          programId: String(body.programId ?? ''),
          myshopifyDomain: body.myshopifyDomain ? String(body.myshopifyDomain) : undefined,
          shopId: body.shopId ? String(body.shopId) : undefined,
          referredAt: body.referredAt ? String(body.referredAt) : undefined,
        },
        getDb(),
      );
      response.json({ attribution: result, commissions: recomputeCommissions(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Unassign a referral. Soft — the commissions already earned under it stay,
   * and the engine stops it earning from this instant forward.
   */
  router.delete('/attributions/:attributionId', (request, response) => {
    try {
      const result = unassignAttribution(request.params.attributionId, getDb());
      response.json({ attribution: result, commissions: recomputeCommissions(getDb()) });
    } catch (error) {
      fail(response, error);
    }
  });

  /* ------------------------------------------------ attribution claims --
   *
   * Ahead of `/:affiliateId` deliberately, and this is not a style choice: that
   * route is registered below and would otherwise swallow `/claims` as an
   * affiliate id and answer 404. The same trap the fixed paths at the top of
   * this file avoid.
   *
   * These routes exist for a decision nobody has made yet. A pending queue of
   * claims was carried out of Mantle undecided, on purpose, and this is where
   * they get worked through later — one at a time, by a person, with the
   * merchant and any competing claim in front of them.
   */

  /** The claim queue. Filter by status, affiliate or program; paged and sorted. */
  router.get('/claims', (request, response) => {
    try {
      const page = Number(pick(request, 'page'));
      const limit = Number(pick(request, 'limit'));
      response.json(
        listClaims(
          {
            status: pick(request, 'status'),
            affiliateId: pick(request, 'affiliateId'),
            programId: pick(request, 'programId'),
            // Store name or myshopify domain, one box, matched server-side.
            search: pick(request, 'q'),
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            sort: pick(request, 'sort'),
            sortDirection: pick(request, 'sortDirection') === 'asc' ? 'asc' : 'desc',
          },
          getDb(),
        ),
      );
    } catch (error) {
      fail(response, error);
    }
  });

  /** One claim, with the referral it corresponds to and anyone else claiming it. */
  router.get('/claims/:claimId', (request, response) => {
    try {
      const detail = getClaim(request.params.claimId, getDb());
      if (!detail) {
        response.status(404).json({ error: `No claim with id ${request.params.claimId}.` });
        return;
      }
      response.json(detail);
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * Decide a claim.
   *
   * Approving goes through `assignAttribution`, the same function
   * `POST /:affiliateId/attributions` calls, so a merchant credited by approving
   * a claim is credited exactly as one credited by hand — one path, not two that
   * drift. Commissions are recomputed inline for the same reason as there: the
   * person doing this is looking at a balance and needs to see it move.
   *
   * Rejecting writes the decision and nothing else. No attribution, no
   * commission, no recompute to do.
   */
  router.post('/claims/:claimId/:decision', (request, response) => {
    try {
      const decision = request.params.decision;
      // Validated here rather than as a path pattern so an unknown verb is a
      // stated 400 rather than a 404 that reads as "no such claim".
      if (decision !== 'approve' && decision !== 'reject') {
        throw new AffiliateAdminError(`Decide with "approve" or "reject", not "${decision}".`);
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const claim = decideClaim(
        request.params.claimId,
        decision,
        {
          decidedBy: body.decidedBy ? String(body.decidedBy) : undefined,
          notes: body.notes ? String(body.notes) : undefined,
        },
        getDb(),
      );
      response.json({
        claim,
        commissions: decision === 'approve' ? recomputeCommissions(getDb()) : null,
      });
    } catch (error) {
      fail(response, error);
    }
  });

  /* ------------------------------------------------ end attribution claims */

  /**
   * Edit an affiliate: their name, addresses, status and payout hold.
   *
   * Partial, like the programme editor. `status` and `payoutHold` are kept
   * apart deliberately — disabling stops a handle resolving on the public
   * redirect, while a payout hold stops nothing and records that somebody has
   * decided not to pay yet. Commissions keep accruing under a hold, which is
   * the point of it.
   *
   * Registered before `GET /:affiliateId` in source order but on a different
   * verb, so no route shadowing is involved.
   */
  router.patch('/:affiliateId', (request, response) => {
    try {
      const affiliate = updateAffiliate(
        request.params.affiliateId,
        (request.body ?? {}) as Record<string, unknown>,
        getDb(),
      );
      response.json({ affiliate });
    } catch (error) {
      fail(response, error);
    }
  });

  /** One affiliate: memberships, handles, referrals and commissions. */
  router.get('/:affiliateId', (request, response) => {
    try {
      const detail = getAffiliate(request.params.affiliateId, getDb());
      if (!detail) {
        response.status(404).json({ error: `No affiliate with id ${request.params.affiliateId}.` });
        return;
      }
      response.json(detail);
    } catch (error) {
      fail(response, error);
    }
  });

  return router;
}

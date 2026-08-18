import express from 'express';
import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { candidateOrg } from '../orgs/registry.js';
import {
  assertOrganizationId,
  describeOrganization,
  listOrganizations,
  OrganizationError,
  readOrganization,
  recordCheck,
  removeOrganization,
  saveOrganization,
  type Organization,
  type OrganizationView,
} from '../orgs/store.js';
import { verifyOrganization, type OrganizationCheck } from '../orgs/verify.js';
import { syncStatus } from '../sync/scheduler.js';
import { sendError } from './errors.js';

/**
 * Organization management: the admin realm's, and only the admin realm's.
 *
 * Mounted under `/api`, behind `requireAuth`, alongside the affiliate *admin*
 * router and nowhere near `/portal`. That is not incidental. An affiliate
 * portal session is a different cookie signed with a different key on a
 * different path, and this router would hand whoever reached it the ability to
 * point a Partner credential at an organization of their choosing.
 *
 * Two rules run through every handler:
 *
 *   1. **A token is never sent back.** `describeOrganization` is the only shape
 *      that leaves this file, and it carries four characters of hint. A token
 *      that is already stored can be replaced without ever being displayed —
 *      `PATCH` with no `token` field keeps it.
 *   2. **A credential is proved before it is stored.** Adding or changing a
 *      token runs it against the Partner API first and reports what it reached,
 *      because the organization id is in the endpoint path and a check that
 *      passes has therefore proved the *pairing* rather than the string.
 */

/** What the dashboard needs beside the row: is it syncing, and is it healthy? */
export interface OrganizationStatus extends OrganizationView {
  /** Apps attributed to this organization in the local store. */
  apps: number;
  /** Newest watermark write under `org:<id>:…`, which is its last real progress. */
  lastSyncAt: string | null;
  /** The phase in flight, when the run in front of you is on this organization. */
  phase: string | null;
  phaseStartedAt: string | null;
  /** The last failure the sync recorded against this organization. */
  syncError: string | null;
  syncErrorPhase: string | null;
  syncErrorAt: string | null;
  /** True when `PARTNER_ORG_<n>_*` names this organization right now. */
  inEnvironment: boolean;
  /**
   * True when the environment names this organization with a *different* token
   * from the stored one. Surfaced rather than resolved: the stored token is the
   * one in use, and an operator who rotated a secret in one place and not the
   * other is owed the fact, not a silent winner.
   */
  envDiffers: boolean;
}

function statusFor(db: Db, org: Organization, appCounts: Map<string, number>): OrganizationStatus {
  const envOrg = getConfig().partner.orgs.find((entry) => entry.organizationId === org.id);
  const sync = syncStatus();

  const watermark = db
    .prepare(`SELECT MAX(updated_at) AS at FROM sync_state WHERE key LIKE ?`)
    .get(`org:${org.id}:%`) as { at: string | null };

  // The scheduler tracks the phase by *label*, which is what the run reports.
  const onThisOrg = sync.phaseOrg !== null && sync.phaseOrg === (org.label || org.id);
  const failedHere = sync.lastErrorOrg !== null && sync.lastErrorOrg === (org.label || org.id);

  return {
    ...describeOrganization(org),
    apps: appCounts.get(org.id) ?? 0,
    lastSyncAt: watermark.at,
    phase: sync.running && onThisOrg ? sync.phase : null,
    phaseStartedAt: sync.running && onThisOrg ? sync.phaseStartedAt : null,
    syncError: failedHere ? sync.lastError : null,
    syncErrorPhase: failedHere ? sync.lastErrorPhase : null,
    syncErrorAt: failedHere ? sync.lastErrorAt : null,
    inEnvironment: envOrg !== undefined,
    envDiffers: envOrg !== undefined && org.token.length > 0 && envOrg.token !== org.token,
  };
}

/**
 * Apps per organization, counted off the index rather than the table.
 *
 * `idx_apps_org` covers this, and `apps` is a table of tens of rows rather than
 * millions — unlike `transactions`, which is deliberately *not* counted here.
 * The removal confirmation says the history is kept without saying how much of
 * it there is, because finding that out costs a 56-second table scan on the one
 * thread that also answers the health check.
 */
function appCounts(db: Db): Map<string, number> {
  const rows = db
    .prepare('SELECT org_id AS orgId, COUNT(*) AS n FROM apps GROUP BY org_id')
    .all() as Array<{ orgId: string; n: number }>;
  return new Map(rows.map((row) => [row.orgId, row.n]));
}

function payload(db: Db): { organizations: OrganizationStatus[] } {
  const counts = appCounts(db);
  return {
    organizations: listOrganizations(db).map((org) => statusFor(db, org, counts)),
  };
}

/** The organizations a reader may scope a report to. Used by the selector. */
export function organizationOptions(db: Db): Array<{ id: string; label: string }> {
  return listOrganizations(db).map((org) => ({ id: org.id, label: org.label || org.id }));
}

function text(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function organizationsRouter(): express.Router {
  const router = express.Router();

  router.get('/', (_request, response) => {
    try {
      response.json(payload(getDb()));
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Add an organization, having first proved the credential.
   *
   * `force` exists for the one case refusing would be wrong in: a check that
   * failed on the network rather than on the token. It is opt-in, it is named,
   * and the row it writes carries the failed check on it — so an organization
   * saved past a refusal looks different in the list from one that passed.
   */
  router.post('/', (request, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    const force = body?.force === true;

    let id: string;
    let token: string;
    try {
      id = assertOrganizationId(text(body, 'organizationId') ?? text(body, 'id') ?? '');
      token = (text(body, 'token') ?? '').trim();
      if (!token) {
        throw new OrganizationError(
          'Paste the Partner API access token for this organization. It is stored on the ' +
            'server and never shown again.',
        );
      }
      const existing = readOrganization(getDb(), id);
      // Present and not removed: this is an edit, and edits go through PATCH so
      // that "add" can never quietly overwrite a live credential. A *removed*
      // one may be added again — that is how an organization comes back, and it
      // resumes from its watermarks rather than re-walking history.
      if (existing && existing.disabledAt === null) {
        throw new OrganizationError(
          `Organization ${id} is already configured. Edit it instead of adding it again.`,
          409,
        );
      }
    } catch (error) {
      sendError(response, error);
      return;
    }

    verifyOrganization(candidateOrg(id, token))
      .then((check) => {
        if (!check.ok && !force) {
          response.status(400).json({
            error: check.error ?? 'The Partner API refused that credential.',
            check,
          });
          return;
        }

        const db = getDb();
        const saved = saveOrganization(db, {
          id,
          label: text(body, 'label') ?? '',
          token,
          source: 'manual',
        });
        recordCheck(db, saved.id, { note: check.note, error: check.error });
        response.status(201).json({ check, ...payload(db) });
      })
      .catch((error: unknown) => sendError(response, error));
  });

  /**
   * Edit one organization: its label, its token, or both.
   *
   * A body with no `token` keeps the stored one, which is what makes renaming an
   * organization possible without anybody having to see its credential. A body
   * *with* one replaces it, and is checked first on the same terms as an add.
   */
  router.patch('/:id', (request, response) => {
    const body = request.body as Record<string, unknown> | undefined;
    const force = body?.force === true;
    const id = request.params.id;
    const token = text(body, 'token')?.trim();

    try {
      const existing = readOrganization(getDb(), id);
      if (!existing) {
        response.status(404).json({ error: `No organization with id ${id}.` });
        return;
      }
      if (!token && !existing.token) {
        throw new OrganizationError(
          `Organization ${id} has no stored token — it was removed. Paste one to bring it back; ` +
            `its apps, history and sync watermarks are all still here.`,
        );
      }
    } catch (error) {
      sendError(response, error);
      return;
    }

    const save = (check: OrganizationCheck | null): void => {
      const db = getDb();
      const saved = saveOrganization(db, {
        id,
        label: text(body, 'label'),
        ...(token ? { token } : {}),
      });
      if (check) recordCheck(db, saved.id, { note: check.note, error: check.error });
      response.json({ ...(check ? { check } : {}), ...payload(db) });
    };

    // A label-only edit is not a reason to call the Partner API.
    if (!token) {
      try {
        save(null);
      } catch (error) {
        sendError(response, error);
      }
      return;
    }

    verifyOrganization(candidateOrg(id, token))
      .then((check) => {
        if (!check.ok && !force) {
          response.status(400).json({
            error: check.error ?? 'The Partner API refused that credential.',
            check,
          });
          return;
        }
        save(check);
      })
      .catch((error: unknown) => sendError(response, error));
  });

  /**
   * Remove an organization.
   *
   * Soft, and the response says exactly what that means so the UI does not have
   * to invent it: the credential is forgotten, the syncing stops, and every row
   * already collected stays where it is. See `removeOrganization` for why a
   * DELETE of the data would be the wrong answer to this request.
   */
  router.delete('/:id', (request, response) => {
    try {
      const db = getDb();
      const removed = removeOrganization(db, request.params.id);
      if (!removed) {
        response.status(404).json({ error: `No organization with id ${request.params.id}.` });
        return;
      }
      response.json({
        removed: describeOrganization(removed),
        kept: {
          apps: appCounts(db).get(removed.id) ?? 0,
          // Said in words rather than counted: counting the transactions behind
          // them is a full table scan of millions of rows on the request thread.
          history: 'transactions, events and sync watermarks are all kept',
        },
        ...payload(db),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Re-run the check against a stored credential, without displaying it. */
  router.post('/:id/check', (request, response) => {
    const db = getDb();
    const existing = readOrganization(db, request.params.id);
    if (!existing || !existing.token) {
      response
        .status(404)
        .json({ error: `No organization with id ${request.params.id} holds a token.` });
      return;
    }

    verifyOrganization(candidateOrg(existing.id, existing.token))
      .then((check) => {
        recordCheck(db, existing.id, { note: check.note, error: check.error });
        response.json({ check, ...payload(db) });
      })
      .catch((error: unknown) => sendError(response, error));
  });

  return router;
}

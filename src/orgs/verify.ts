import type { PartnerOrg } from '../config.js';
import { partnerQuery } from '../partner/client.js';
import { ORGANIZATION_PROBE_QUERY } from '../partner/queries.js';
import { normalizeAppId } from '../config.js';

/**
 * Prove a credential before it is stored, and say what it actually opens.
 *
 * ## Why this answers "which organization is it?" rather than trusting the form
 *
 * There is no Partner API query that asks a token to name its own organization.
 * There does not need to be: the organization id is part of the endpoint
 * **path**, so a token issued in organization A presented at organization B's
 * endpoint is rejected outright — 401 from the API, and `partnerQuery` turns
 * that into a message naming the organization it was refused for. A check that
 * comes back `ok` has therefore proved the pairing, not merely the token.
 *
 * What is left is the second half of the question, and it is the half an
 * operator can actually recognise: **which apps does this credential reach?**
 * The probe reads a handful of the newest transactions and reports the distinct
 * apps on them by name. Pasting the wrong organization's token is caught by the
 * 401; pasting the *right* token for an organization that is not the one you
 * meant to add is caught by a list of app names that are not yours. Nothing else
 * available over this API distinguishes those two mistakes.
 *
 * A brand-new organization with no transactions yet answers `ok` with no apps,
 * and says so. That is a real state, not a failure — the credential works and
 * there is simply nothing to have earned yet.
 */

export interface OrganizationCheck {
  ok: boolean;
  /** The organization the endpoint accepted the token for. */
  organizationId: string;
  /** Distinct apps seen on the sampled transactions, newest first. */
  apps: Array<{ id: string; name: string }>;
  /** How many transactions the probe saw. Zero is not an error. */
  transactions: number;
  error: string | null;
  /** The same outcome in one line, for the row and for the dashboard. */
  note: string | null;
}

interface ProbeNode {
  createdAt: string;
  app?: { id?: string | null; name?: string | null } | null;
}

interface ProbeResponse {
  transactions?: { edges?: Array<{ node?: ProbeNode | null } | null> | null } | null;
}

function summarise(apps: Array<{ id: string; name: string }>, transactions: number): string {
  if (transactions === 0) {
    return 'Credential accepted. No transactions yet, so no apps to name.';
  }
  if (apps.length === 0) return `Credential accepted. ${transactions} recent transaction(s).`;
  return `Credential accepted. Apps seen: ${apps.map((app) => app.name).join(', ')}.`;
}

export async function verifyOrganization(
  org: PartnerOrg,
  options: { signal?: AbortSignal } = {},
): Promise<OrganizationCheck> {
  try {
    const data = await partnerQuery<ProbeResponse>(
      org,
      ORGANIZATION_PROBE_QUERY,
      {},
      { signal: options.signal },
    );

    const edges = data.transactions?.edges ?? [];
    const apps = new Map<string, string>();
    for (const edge of edges) {
      const app = edge?.node?.app;
      if (!app?.id) continue;
      const id = normalizeAppId(app.id);
      if (!apps.has(id)) apps.set(id, app.name?.trim() || `App ${id}`);
    }

    const list = [...apps].map(([id, name]) => ({ id, name }));
    return {
      ok: true,
      organizationId: org.organizationId,
      apps: list,
      transactions: edges.length,
      error: null,
      note: summarise(list, edges.length),
    };
  } catch (cause) {
    return {
      ok: false,
      organizationId: org.organizationId,
      apps: [],
      transactions: 0,
      error: cause instanceof Error ? cause.message : String(cause),
      note: null,
    };
  }
}

import { endpointFor, getConfig, type PartnerOrg } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { listOrganizations, readOrganization, type Organization } from './store.js';

/**
 * The organizations this instance actually syncs, resolved from the table.
 *
 * One function, and everything that opens a Partner endpoint goes through it.
 * The environment is no longer consulted here at all: `getDb()` seeds the table
 * from it on every open, so by the time anything asks this question the two have
 * already been reconciled — see `seedOrganizationsFromEnv` for which way round.
 *
 * A `PartnerOrg` is the unit rather than an id, for the reason `partnerQuery`
 * states: the organization lives in the endpoint *path*, so a caller holding one
 * of these cannot pair one organization's id with another's token.
 */

function toPartnerOrg(row: Organization, apiVersion: string): PartnerOrg {
  return {
    organizationId: row.id,
    token: row.token,
    label: row.label || row.id,
    apiVersion,
    endpoint: endpointFor(row.id, apiVersion),
  };
}

/**
 * Every organization a sync should visit: not removed, and holding a token.
 *
 * May be empty, and that is a supported state rather than a failure. A fresh
 * install has no organization until somebody adds one, and it has to be able to
 * serve the page they add it on.
 */
export function activeOrgs(db: Db = getDb()): PartnerOrg[] {
  const { apiVersion } = getConfig().partner;
  return listOrganizations(db)
    .filter((row) => row.disabledAt === null && row.token.length > 0)
    .map((row) => toPartnerOrg(row, apiVersion));
}

/** Credentials for one organization id, or null. Never a guess at another. */
export function activeOrg(organizationId: string, db: Db = getDb()): PartnerOrg | null {
  const row = readOrganization(db, organizationId);
  if (!row || row.disabledAt !== null || !row.token) return null;
  return toPartnerOrg(row, getConfig().partner.apiVersion);
}

/**
 * The same shape for a credential that has not been stored yet.
 *
 * This is what makes "verify before saving" possible: the check runs against a
 * real endpoint built from what was typed, and nothing is written until it comes
 * back. The token never leaves this process either way.
 */
export function candidateOrg(organizationId: string, token: string): PartnerOrg {
  const { apiVersion } = getConfig().partner;
  return {
    organizationId,
    token,
    label: organizationId,
    apiVersion,
    endpoint: endpointFor(organizationId, apiVersion),
  };
}

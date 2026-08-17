/**
 * The portal's five pages, and the only thing its URL is allowed to carry.
 *
 * `ROUTES` is a closed list and `parseRoute` maps anything outside it to
 * `overview`. That is the security property, not a tidiness one: no view in this
 * app takes an identifier, so there is no URL a reader can edit to ask for
 * somebody else's data. Every request the portal makes is scoped server-side to
 * the session's affiliate and carries no id at all — see `src/server/portal.ts`.
 *
 * The hash is used rather than the path because the portal is served as a single
 * static bundle from `/portal`, and because `#/set-password/<token>` already
 * lives there — see `PortalApp`, which claims that route before this router runs.
 */

export const ROUTES = ['overview', 'programs', 'referrals', 'claims', 'payouts'] as const;

export type PortalRoute = (typeof ROUTES)[number];

export const ROUTE_LABELS: Record<PortalRoute, string> = {
  overview: 'Overview',
  programs: 'My programs',
  referrals: 'My referrals',
  // Next to referrals rather than at the end, because a claim is what an
  // affiliate files when a referral they expected is not on that page.
  claims: 'My claims',
  payouts: 'My payouts',
};

export function parseRoute(hash: string): PortalRoute {
  const name = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  return (ROUTES as readonly string[]).includes(name) ? (name as PortalRoute) : 'overview';
}

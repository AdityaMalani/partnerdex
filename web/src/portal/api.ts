/**
 * The portal's own fetch layer.
 *
 * Deliberately not an import from `../api`. That module talks to `/api`, which
 * an affiliate has no business reaching, and sharing it would put one edit away
 * from a portal page calling a dashboard endpoint and getting a 401 nobody
 * expected. Two audiences, two clients, no shared base URL.
 */

const BASE = '/portal/api';

/** Fired when the server says the session lapsed, so the shell returns to login. */
export const SIGNED_OUT_EVENT = 'partnerdex:portal-signed-out';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  // The auth routes answer 401 for a wrong password: that is an answer to a
  // question just asked, not a session that expired underneath the reader.
  if (response.status === 401 && !url.startsWith(`${BASE}/auth/`)) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

const getJson = <T,>(path: string): Promise<T> => request<T>(`${BASE}${path}`);

const sendJson = <T,>(path: string, body?: unknown): Promise<T> =>
  request<T>(`${BASE}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/* -------------------------------------------------------------------- auth */

export interface PortalSession {
  authenticated: boolean;
  name?: string;
  email?: string;
}

export const fetchSession = (): Promise<PortalSession> => getJson<PortalSession>('/auth/session');

export const login = (email: string, password: string, remember: boolean): Promise<{ ok: true }> =>
  sendJson('/auth/login', { email, password, remember });

export const logout = (): Promise<{ ok: true }> => sendJson('/auth/logout');

export const requestReset = (email: string): Promise<{ ok: true }> =>
  sendJson('/auth/request-reset', { email });

export const setPassword = (token: string, password: string): Promise<{ ok: true }> =>
  sendJson('/auth/set-password', { token, password });

/* ------------------------------------------------------------------ signup */

/**
 * A program somebody who is not yet an affiliate can apply to.
 *
 * Everything here is either public (the App Store listing) or a term of the
 * offer. The server decides that boundary — see `listOpenPrograms` — and this
 * type exists to make it obvious when something outside it starts arriving.
 */
export interface OpenProgram {
  id: string;
  name: string;
  /** A fraction — 0.2, not 20. */
  commissionRate: number;
  revenueComponents: string[];
  /** Null means for as long as the merchant keeps paying. */
  durationMonths: number | null;
  unassignAfterUninstallDays: number | null;
  /** True for Stoq today, false for Filemonk. Read from the program, never assumed. */
  requiresApproval: boolean;
  listingUrl: string;
}

export interface SignupOffer {
  programs: OpenProgram[];
  /** Empty when no terms document is configured, which is the state today. */
  termsUrl: string;
}

export const fetchSignupOffer = (): Promise<SignupOffer> =>
  getJson<SignupOffer>('/signup/programs');

/**
 * Apply to join.
 *
 * The response is deliberately uninformative and is the same for a brand-new
 * partner and for an address that is already an affiliate: the server refuses to
 * disclose which, so this client has nothing to branch on and should not invent
 * a way to. What comes back is a sentence to show the applicant.
 */
export const submitSignup = (application: {
  name: string;
  email: string;
  programIds: string[];
  acceptedTerms: boolean;
}): Promise<{ ok: true; message: string }> => sendJson('/signup', application);

/* --------------------------------------------------------------------- me */

export interface Membership {
  membershipId: string;
  program: string;
  handle: string;
  status: 'enrolled' | 'pending' | 'rejected';
  joinedAt: string;
  /** Null when the program has no App Store listing mapped yet. */
  referralUrl: string | null;
  /** A fraction — 0.2, not 20. */
  commissionRate: number;
  /** Null means lifetime. */
  durationMonths: number | null;
}

export interface Me {
  affiliate: {
    name: string;
    email: string;
    paypalEmail: string | null;
    payoutHold: boolean;
    memberSince: string;
  };
  memberships: Membership[];
}

export const fetchMe = (): Promise<Me> => getJson<Me>('/me');

/* -------------------------------------------------------------- referrals */

/**
 * Note what a referral does *not* carry: no merchant email, no domain, no
 * revenue. `shop` is a display name and nothing joins on it.
 */
export interface Referral {
  referralId: string;
  program: string;
  shop: string;
  referredAt: string;
  unassignedAt: string | null;
  commissionCount: number;
  earned: number;
  lastCommissionAt: string | null;
}

export const fetchReferrals = (): Promise<{ referrals: Referral[]; total: number }> =>
  getJson('/referrals');

/* --------------------------------------------------------------- earnings */

export interface Earnings {
  lifetime: number;
  paid: number;
  unpaid: number;
  cancelled: number;
  commissions: number;
  lastEarnedAt: string | null;
  currency: string;
  referrals: { total: number; active: number };
  byProgram: Array<{ program: string; amount: number; commissions: number }>;
  byMonth: Array<{ month: string; amount: number; commissions: number }>;
}

export const fetchEarnings = (): Promise<Earnings> => getJson<Earnings>('/earnings');

export interface Commission {
  commissionId: string;
  program: string;
  shop: string;
  amount: number;
  currency: string;
  rate: number | null;
  earnedAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export const fetchCommissions = (
  offset = 0,
  limit = 50,
): Promise<{ commissions: Commission[]; total: number; limit: number; offset: number }> =>
  getJson(`/commissions?limit=${limit}&offset=${offset}`);

/* --------------------------------------------------------------- programs */

/**
 * The membership record, with the program's terms attached.
 *
 * A superset of what `/me` returns per membership, and served by an endpoint
 * that landed after this page did. `fetchPrograms` therefore falls back to the
 * `/me` shape rather than failing — see below — so every field the fallback
 * cannot supply is optional here. A page that renders `revenueComponents` must
 * cope with not having it.
 */
export interface Program {
  programId: string;
  programName: string;
  appName?: string | null;
  handle: string;
  referralUrl: string | null;
  status: string;
  joinedAt: string;
  approvedAt?: string | null;
  /** A fraction — 0.2, not 20. */
  commissionRate: number;
  /** e.g. `['subscription']`. Absent when only `/me` was available. */
  revenueComponents?: string[] | null;
  /** Null means for as long as the merchant stays. */
  durationMonths: number | null;
  /**
   * Days after an uninstall before the referral is released.
   *
   * Optional for the same reason as `revenueComponents`: the `/me` fallback
   * below cannot supply it. `termsFor` falls back to the documented default when
   * it is absent, which is what the page did unconditionally before this field
   * existed.
   */
  unassignAfterUninstallDays?: number | null;
}

/**
 * Programs, from the endpoint that knows the terms, or from `/me` if it does
 * not exist yet.
 *
 * The fallback is not defensive padding: `/portal/api/programs` is newer than
 * this page, and a portal that shows an affiliate no programs at all because a
 * route 404s is worse than one that shows them the four fields `/me` has always
 * carried. What is lost in the fallback is `revenueComponents` and `approvedAt`,
 * both of which the UI treats as optional.
 */
export async function fetchPrograms(): Promise<Program[]> {
  try {
    const { programs } = await getJson<{ programs: Program[] }>('/programs');
    if (Array.isArray(programs)) return programs;
  } catch {
    // Fall through to `/me`.
  }
  const me = await fetchMe();
  return me.memberships.map((membership) => ({
    programId: membership.membershipId,
    programName: membership.program,
    handle: membership.handle,
    referralUrl: membership.referralUrl,
    status: membership.status,
    joinedAt: membership.joinedAt,
    commissionRate: membership.commissionRate,
    durationMonths: membership.durationMonths,
  }));
}

/* ----------------------------------------------------------------- claims */

/**
 * A claim this affiliate filed: "this merchant was mine".
 *
 * The manual half of attribution, and the origin of a large minority of the
 * imported referrals. A claim is a request, never a credit — it creates nothing
 * until an operator approves it.
 *
 * Note the shape the server chose and what it refuses to say. `merchant` is the
 * name the affiliate themselves typed, echoed back, so nothing about a store
 * arrives here that they did not send. `attributed` is a boolean rather than an
 * id, because the referral itself belongs on the referrals page. There is no
 * `decisionNotes`: the operator's reasoning is an internal record, not an answer
 * owed to the claimant. And there is no field at all describing whether the
 * merchant exists or who else claimed them — see `submitClaim` below.
 */
export interface Claim {
  id: string;
  programName: string;
  merchant: string;
  claimedAt: string;
  notes: string | null;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  attributed: boolean;
}

export interface ClaimPage {
  claims: Claim[];
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  /** True when the endpoint is not deployed — the page says so rather than erroring. */
  unavailable?: boolean;
}

/**
 * The claims this affiliate filed, or an honest blank.
 *
 * Same treatment as `fetchPayouts`: a route that is not deployed and an
 * affiliate who has never filed anything are different facts and read
 * differently on the page.
 */
export async function fetchClaims(): Promise<ClaimPage> {
  try {
    const page = await getJson<ClaimPage>('/claims');
    return {
      claims: Array.isArray(page.claims) ? page.claims : [],
      total: page.total ?? 0,
      hasNextPage: page.hasNextPage ?? false,
      hasPreviousPage: page.hasPreviousPage ?? false,
    };
  } catch {
    return { claims: [], total: 0, hasNextPage: false, hasPreviousPage: false, unavailable: true };
  }
}

/**
 * File a claim.
 *
 * There is no affiliate id in this call, as there is in no call this client
 * makes: scope comes from the session cookie, server-side.
 *
 * **The answer is the same whatever the merchant is.** A store we have never
 * heard of, one that is ours, and one already credited to another affiliate all
 * return this exact shape — deliberately, so that this endpoint cannot be used
 * to find out which shops are our customers or whose they are. The client must
 * not invent a distinction the server refuses to make: there is nothing here to
 * branch on, and anything that looked like a hint would be a bug on the server,
 * not a feature to render.
 *
 * `duplicate` says the affiliate had already filed this one and no second row
 * was written. That is a fact about their own claim list, which they can read in
 * full, and it says nothing about the merchant.
 */
export const submitClaim = (claim: {
  programId: string;
  merchant: string;
  notes?: string;
}): Promise<{ claim: { id: string; merchant: string; claimedAt: string; duplicate: boolean } }> =>
  sendJson('/claims', claim);

/* ---------------------------------------------------------------- payouts */

/**
 * A settled or in-flight payment, as recorded by whoever made it.
 *
 * Nothing here is actionable from this page: payouts are processed outside
 * PartnerDex entirely, so this is a statement, not a queue.
 */
export interface Payout {
  id: string;
  number?: string | number | null;
  programName?: string | null;
  status: string;
  amount: number;
  amountPaid?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
}

export interface PayoutPage {
  payouts: Payout[];
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  /** True when the endpoint is not deployed — the page says so rather than erroring. */
  unavailable?: boolean;
}

/**
 * Payout history, or an honest blank.
 *
 * A missing endpoint and an affiliate who has never been paid are different
 * facts and read differently on the page, so the 404 is carried through as
 * `unavailable` instead of being flattened into an empty list.
 */
export async function fetchPayouts(): Promise<PayoutPage> {
  try {
    const page = await getJson<PayoutPage>('/payouts');
    return {
      payouts: Array.isArray(page.payouts) ? page.payouts : [],
      total: page.total ?? 0,
      hasNextPage: page.hasNextPage ?? false,
      hasPreviousPage: page.hasPreviousPage ?? false,
    };
  } catch {
    return { payouts: [], total: 0, hasNextPage: false, hasPreviousPage: false, unavailable: true };
  }
}

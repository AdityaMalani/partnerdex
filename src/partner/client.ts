import type { PartnerOrg } from '../config.js';

export class PartnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errors: unknown = null,
  ) {
    super(message);
    this.name = 'PartnerApiError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

const MAX_ATTEMPTS = 6;

/**
 * The first retry's wait, doubling with each attempt after it.
 *
 * Read from the environment for the same two reasons the timeouts above are: a
 * test can shorten it rather than waiting out six real backoffs, and an operator
 * on a link that fails in bursts can lengthen it without a rebuild.
 */
function baseBackoffMs(): number {
  const raw = Number(process.env.PARTNER_RETRY_BACKOFF_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

/**
 * How long one Partner API request may take before it is treated as a hang.
 *
 * Not a latency budget — a page of a large connection can legitimately take a
 * while, and cutting one off would turn a slow sync into a failing one. This
 * exists only so a request that will *never* answer cannot park the pipeline.
 *
 * Read per call rather than captured once, so a test can shorten it without
 * waiting out the real value, and so an operator can raise it on a slow link
 * without a rebuild.
 */
function requestTimeoutMs(): number {
  const raw = Number(process.env.PARTNER_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

/**
 * The longest a `Retry-After` header may park this client.
 *
 * The header is honoured because the API is entitled to say how long to wait,
 * but not without a ceiling. A 429 carrying `Retry-After: 900` parks one attempt
 * for fifteen minutes; five of them is an hour and a quarter of a sync that has
 * not failed, has not progressed and has printed nothing. Reproduced against a
 * fake Partner API — see `scripts/stall-probe.ts`, mode `retry-after`.
 *
 * Waiting less than asked risks another 429, which costs one more round trip.
 * Waiting an unbounded amount costs the whole pass, and with it every figure on
 * the dashboard until someone restarts the machine. The cheaper mistake wins.
 */
function maxRetryAfterMs(): number {
  const raw = Number(process.env.PARTNER_MAX_RETRY_AFTER_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** A sleep an abort can cut short, so a deadline is not held up by a backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The signal one request runs under: this call's own hang timeout, plus any
 * deadline the caller is imposing on a larger unit of work.
 */
function requestSignal(caller?: AbortSignal): AbortSignal {
  const hang = AbortSignal.timeout(requestTimeoutMs());
  return caller ? AbortSignal.any([hang, caller]) : hang;
}

export interface PartnerRequestOptions {
  /**
   * A deadline larger than one request — an organization's pass, say. Aborting
   * it ends the retry loop rather than merely the request in flight, which is
   * the difference between a stalled organization yielding to the next one and
   * a stalled organization retrying its way through the whole sync window.
   */
  signal?: AbortSignal;
}

/**
 * The Partner API is throttled per organization and answers with 429 plus a
 * Retry-After when you exceed it. Everything goes through this one function so
 * backoff and error shaping live in a single place.
 *
 * `org` is the **first** parameter and has no default, on purpose. The
 * organization lives in the endpoint path, so every call is already a call to
 * one specific org — the only question is whether the code says which. An
 * optional trailing argument would answer "org 0" for any call site that forgot,
 * and against the wrong org an app id either 404s (loud, but far from the cause)
 * or, worse, resolves — writing one organization's rows under an app id that
 * belongs to the other. Required and first means a forgotten call site is a
 * compile error.
 */
export async function partnerQuery<T>(
  org: PartnerOrg,
  query: string,
  variables: Record<string, unknown> = {},
  options: PartnerRequestOptions = {},
): Promise<T> {
  // The compiler enforces this for TypeScript callers; the runtime check is for
  // the ones it cannot see — a JS import, a test double, `any` in the middle of
  // a chain — because a missing org here is a wrong-data bug, not a crash.
  if (!org?.endpoint || !org.token) {
    throw new PartnerApiError(
      'partnerQuery was called without an organization. Every Partner API call must name ' +
        'the organization it is for; there is no default.',
      null,
    );
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(org.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': org.token,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        // Without this, a connection the server accepts and then never answers
        // hangs here forever. Nothing above catches that: the retry loop below
        // handles errors and bad statuses, and a request that never settles is
        // neither. It froze a production backfill for over an hour — cursor
        // parked mid-pagination, no rows written, no error, and the sync's own
        // overlap guard meant no later run could start either. One dead socket
        // stopped the pipeline indefinitely.
        //
        // A timeout turns that into an ordinary network error, which the loop
        // already knows how to retry with backoff. Generous on purpose: a slow
        // page of a large connection is normal and must not be cut off, so this
        // is set to catch a hang, not to bound latency.
        signal: requestSignal(options.signal),
      });
    } catch (cause) {
      // A caller's deadline is not a transient error and must not be retried
      // through: it is the larger unit of work saying it has given up.
      if (options.signal?.aborted) throw options.signal.reason ?? cause;
      if (attempt === MAX_ATTEMPTS) {
        throw new PartnerApiError(`Network error calling the Partner API: ${String(cause)}`, null);
      }
      await sleep(baseBackoffMs() * 2 ** (attempt - 1), options.signal);
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new PartnerApiError(
          `Partner API returned ${response.status} after ${MAX_ATTEMPTS} attempts.`,
          response.status,
        );
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, maxRetryAfterMs())
        : baseBackoffMs() * 2 ** (attempt - 1);
      await sleep(waitMs, options.signal);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new PartnerApiError(
        `Partner API rejected the token for organization ${org.label} (${response.status}). ` +
          `Check that org's token and that the client has the "View financials" and ` +
          `"Manage apps" permissions.`,
        response.status,
      );
    }

    if (response.status === 404) {
      throw new PartnerApiError(
        `Partner API returned 404 for organization ${org.organizationId}. Check that ` +
          `organization id and PARTNER_API_VERSION.`,
        404,
      );
    }

    if (!response.ok) {
      throw new PartnerApiError(
        `Partner API returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
        response.status,
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors?.length) {
      const throttled = body.errors.some(
        (error) => (error.extensions?.code as string | undefined) === 'THROTTLED',
      );
      if (throttled && attempt < MAX_ATTEMPTS) {
        await sleep(baseBackoffMs() * 2 ** attempt, options.signal);
        continue;
      }
      throw new PartnerApiError(
        `Partner API GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
        response.status,
        body.errors,
      );
    }

    if (!body.data) {
      throw new PartnerApiError('Partner API returned no data.', response.status);
    }

    return body.data;
  }

  throw new PartnerApiError('Exhausted Partner API retries.', null);
}

export interface PageInfo {
  hasNextPage: boolean;
}

export interface Edge<T> {
  cursor: string;
  node: T;
}

export interface Connection<T> {
  pageInfo: PageInfo;
  edges: Array<Edge<T>>;
}

/**
 * Walks a Relay connection to exhaustion, yielding one page at a time so
 * callers can persist incrementally and keep a resumable cursor.
 */
export async function* paginate<TNode>(
  org: PartnerOrg,
  query: string,
  variables: Record<string, unknown>,
  select: (data: any) => Connection<TNode> | null | undefined,
  startCursor: string | null = null,
  options: PartnerRequestOptions = {},
): AsyncGenerator<{ nodes: TNode[]; endCursor: string | null }> {
  let after: string | null = startCursor;

  for (;;) {
    options.signal?.throwIfAborted();
    const data = await partnerQuery<unknown>(org, query, { ...variables, after }, options);
    const connection = select(data);
    if (!connection) return;

    const nodes = connection.edges.map((edge) => edge.node);
    const endCursor = connection.edges.at(-1)?.cursor ?? null;

    if (nodes.length > 0) {
      yield { nodes, endCursor };
    }

    if (!connection.pageInfo.hasNextPage || !endCursor) return;

    /*
     * A page that says "there is more" and hands back the cursor we just asked
     * from is not more — it is the same page again, forever. The loop stays
     * inside `for (;;)`, re-inserts the same idempotent rows, rewrites the same
     * cursor and never advances the watermark, so from outside it is
     * indistinguishable from a hang: no error, no progress, no end. Reproduced
     * against a fake Partner API at five thousand pages a second — see
     * `scripts/stall-probe.ts`, mode `same-cursor`.
     *
     * Thrown rather than returned. Returning would let the caller clear its
     * cursor and record the pass as clean, which would silently truncate the
     * connection at whatever page the API got stuck on. A failure that retries
     * next tick is the honest outcome.
     */
    if (endCursor === after) {
      throw new PartnerApiError(
        `Partner API paginated in place for organization ${org.label}: it reported another page ` +
          `but returned the same cursor. Refusing to loop.`,
        null,
      );
    }
    after = endCursor;
  }
}

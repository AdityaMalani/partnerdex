import crypto from 'node:crypto';

/**
 * Password hashing that cannot be used to stop the server answering.
 *
 * The portal login deliberately runs one scrypt on *every* attempt, including
 * attempts for addresses that are not ours — that decoy hash is what stops the
 * clock answering "is this one of your affiliates?" (see `verifyPassword`
 * in `portalAuth.ts`). The full application security review then showed the bill
 * for that decision: `scryptSync` is native, synchronous work on the one thread
 * that also serves `/api/health`, and the per-(address, account) login throttle
 * is keyed on the email, so a rotating email address is a fresh bucket every
 * time. 150 concurrent logins from a single unauthenticated IP took the health
 * probe from 1.6 ms to 2.8 s — measured — which is how Fly comes to pull a
 * perfectly healthy machine out of the load balancer.
 *
 * Two changes are needed and neither of them is "hash less often", because
 * hashing less often is the timing oracle coming back:
 *
 *   1. **Async scrypt.** `crypto.scrypt` runs on the libuv threadpool, so the
 *      event loop stays free to answer health probes and everything else while
 *      the hash is computed. This alone fixes the *stall*.
 *   2. **A global cap on in-flight hashes.** Async alone is not enough: the
 *      libuv pool is four threads by default, and filling all four with 20 ms
 *      scrypts starves every other threadpool user in the process — `fs`, DNS,
 *      zlib. So there is one counter for the whole process, and work past it
 *      waits in a *bounded* queue for a short time and is then refused with a
 *      429 rather than being buffered forever.
 *
 * The queue is the interesting part of the trade. An unbounded queue turns a
 * flood into unbounded memory plus unbounded latency — the requests all
 * eventually run, they just run long after the client gave up, and the process
 * dies of the backlog rather than of the CPU. A bounded queue converts overload
 * into an immediate, cheap, honest "too busy": the attacker gets a 429 for
 * roughly zero server cost, and a real affiliate arriving during a flood gets
 * either a slot or a fast error they can retry, never a hung page.
 *
 * What this does NOT defend against, stated so nobody over-trusts it: a flood
 * still costs real CPU up to the cap, so a sustained attack degrades login
 * latency for everyone. The property being bought is that login stops being
 * able to take the *rest of the server* down with it — health probes, the admin
 * API and every read path stay responsive. Bounding the damage to the login
 * flow is the goal; making login free is not achievable while the decoy hash
 * has to cost what a real hash costs.
 */

/** Raised when the process is already doing all the hashing it will do. */
export class HashCapacityError extends Error {
  constructor() {
    super('Too many sign-in attempts are being processed. Try again in a moment.');
  }
}

interface Limits {
  /**
   * Hashes computed at once, across the whole process.
   *
   * Four is the libuv threadpool's default size, and the point of matching it is
   * that scrypt is the only thing here big enough to matter: allowing more than
   * the pool has threads buys no extra throughput and only lengthens the queue
   * behind it. It is deliberately NOT larger — the cap exists to leave the pool
   * available to other work, and a number above the pool size cannot do that.
   *
   * INFERENCE, not measured: on a machine with UV_THREADPOOL_SIZE raised, this
   * could be raised with it. It is left conservative because the deployment is a
   * single small Fly machine.
   */
  maxInFlight: number;
  /**
   * How many attempts may be *waiting* for a slot.
   *
   * Sized as a couple of seconds of drain at the measured ~22 ms per hash, so a
   * burst of honest logins (a mail-out lands and forty affiliates click at once)
   * is absorbed, while a flood is refused rather than accumulated.
   */
  maxWaiting: number;
  /**
   * The longest an attempt waits before it is refused.
   *
   * Chosen against what a human tolerates rather than what the server can bear:
   * past about a second the affiliate has already decided the site is broken, so
   * queueing them longer converts a fast retryable error into a slow one and
   * helps nobody.
   */
  maxWaitMs: number;
}

const DEFAULTS: Limits = { maxInFlight: 4, maxWaiting: 64, maxWaitMs: 750 };

let limits: Limits = { ...DEFAULTS };

let inFlight = 0;
interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
const waiting: Waiter[] = [];

/** Test seam: shrink the pool so a test can reach its edges in milliseconds. */
export function configureScryptPool(next: Partial<Limits>): void {
  limits = { ...limits, ...next };
}

/** Test seam: back to the shipped numbers, and forget nothing is in flight. */
export function resetScryptPool(): void {
  limits = { ...DEFAULTS };
}

/** Observability seam — the server does not read this, tests do. */
export function scryptPoolState(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiting.length };
}

function release(): void {
  inFlight -= 1;
  const next = waiting.shift();
  if (!next) return;
  clearTimeout(next.timer);
  inFlight += 1;
  next.resolve();
}

function acquire(): Promise<void> {
  if (inFlight < limits.maxInFlight) {
    inFlight += 1;
    return Promise.resolve();
  }
  // Refused at the door rather than queued: a caller that would sit behind a
  // full queue is going to time out anyway, and telling it now costs nothing.
  if (waiting.length >= limits.maxWaiting) return Promise.reject(new HashCapacityError());

  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(new HashCapacityError());
      }, limits.maxWaitMs),
    };
    // `unref` so a pending refusal timer never keeps the process alive — this
    // module is loaded by the CLI too, which must be able to exit.
    waiter.timer.unref?.();
    waiting.push(waiter);
  });
}

/**
 * scrypt, off the event loop and behind the cap.
 *
 * Rejects with `HashCapacityError` when the process is saturated; callers turn
 * that into a 429. Every other rejection is a genuine crypto failure and is a
 * 500, because it means the parameters are wrong rather than the server busy.
 */
export async function scryptHash(
  password: string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  await acquire();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, keylen, (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      });
    });
  } finally {
    release();
  }
}

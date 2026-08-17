/**
 * Failed-attempt throttling, shared by every login this server has.
 *
 * Extracted from `auth.ts` when the affiliate portal arrived, because the second
 * realm needed the same thing and a second implementation of a lockout is a
 * second place for it to be subtly wrong. The behaviour is unchanged from the
 * dashboard's original: a few free attempts, then a lockout that lengthens with
 * every further try, so a script slows to a crawl while somebody who mistyped
 * twice never notices it exists.
 *
 * In-memory and per-process, which is the same trade the dashboard already made:
 * a restart forgets. Persisting it would mean a write on every wrong password —
 * a cheap denial-of-service against the database — to defend against an attacker
 * who can restart the server, and one who can do that has already won.
 *
 * Each realm holds its own instance. Sharing the *counters* would let failed
 * affiliate logins lock the operator out of the dashboard, and vice versa, which
 * turns a throttle into a weapon.
 *
 * Three properties were added after the pre-launch security review, and each is
 * here because the original shape had a way to be turned around and used against
 * the people it was defending:
 *
 *   1. **Failures decay.** The original counter only ever went up, and only a
 *      *successful* login cleared it — which a locked-out client cannot reach.
 *      An attacker who spent one wrong password per expired lockout therefore
 *      walked the penalty up 60s at a time with no ceiling and no way for the
 *      victim to wait it out. Now a failure ages out on its own, so the arms
 *      race needs sustained traffic rather than a request a minute, and an
 *      honest client who mistyped recovers by doing nothing at all.
 *   2. **The escalation has a ceiling.** Unbounded growth is indistinguishable
 *      from a permanent denial of service after a few hours of a cheap script.
 *      A capped lockout still costs a guesser essentially all of their attempt
 *      budget — see the arithmetic on `MAX_LOCKOUT_MS`.
 *   3. **The map is bounded and swept.** Keys are created by unauthenticated
 *      requests, so an unbounded map is a remote memory-exhaustion primitive
 *      against a single-threaded process. See `evict`.
 *
 * What none of this fixes, and what no per-key throttle can: whoever chooses the
 * key decides who shares a bucket. Callers key on the client address, so anyone
 * behind the same NAT shares a fate. `portalAuth.ts` narrows that by mixing the
 * account into the key; `auth.ts` cannot, because there is only one account.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;

/**
 * How long one failure survives before it ages out.
 *
 * Read as: a client that stops failing gets one attempt back every five minutes,
 * so a full bucket empties in half an hour of good behaviour. Long enough that a
 * script working through a wordlist never earns a meaningful number of extra
 * guesses (twelve an hour against a 2^40 space is not an attack, it is a
 * rounding error); short enough that a person who fat-fingered their password
 * before lunch is not still locked out after it.
 */
const DECAY_MS = 5 * 60_000;

/**
 * The longest a single lockout can last.
 *
 * The original penalty grew without bound, one minute per failure past the
 * threshold, which meant a determined attacker could hold a bucket shut for
 * hours — and buckets are shared. Capped at fifteen minutes the guesser still
 * gets at most ~4 attempts an hour once they have burned the free ones, which is
 * the property the lockout exists for, and the worst an attacker can inflict on
 * whoever shares their key is a quarter-hour at a time.
 */
const MAX_LOCKOUT_MS = 15 * 60_000;

/**
 * The ceiling on live keys.
 *
 * Sized for the real population — hundreds of affiliates plus one operator,
 * arriving from at most a few thousand addresses — with three orders of
 * magnitude of head room, and small enough that the whole map is a few
 * megabytes rather than the
 * 187 MB per million entries the review measured.
 */
const MAX_ENTRIES = 50_000;

/**
 * How often the expired-entry sweep may run.
 *
 * The sweep is O(n) and the map is written from a request handler, so sweeping
 * per request would turn the eviction fix into the denial of service it exists
 * to prevent: an attacker who can add keys would also be choosing how much work
 * every other request does. Rate-limited to once a minute, the cost is amortized
 * to roughly nothing per request no matter how fast keys arrive.
 */
const SWEEP_INTERVAL_MS = 60_000;

export interface Throttle {
  /** Remaining lockout in seconds, or 0 when the client may try again. */
  lockoutSeconds(key: string): number;
  recordFailure(key: string): void;
  /** Called on success: the client has proved it is not guessing. */
  clear(key: string): void;
  /** Live key count. A test seam — nothing in the server reads this. */
  size(): number;
}

interface Record_ {
  count: number;
  /** Locked until this instant. Zero when the key is merely warm. */
  until: number;
  /** When the decay clock last ticked. Reset by every fresh failure. */
  seenAt: number;
}

export function createThrottle(
  options: {
    maxAttempts?: number;
    lockoutMs?: number;
    decayMs?: number;
    maxLockoutMs?: number;
    maxEntries?: number;
  } = {},
): Throttle {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const lockoutMs = options.lockoutMs ?? LOCKOUT_MS;
  const decayMs = options.decayMs ?? DECAY_MS;
  const maxLockoutMs = options.maxLockoutMs ?? MAX_LOCKOUT_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;

  /**
   * The count that produces the longest lockout the cap allows.
   *
   * Counting past it would only make the key take longer to decay away without
   * making the lockout any longer — a penalty that outlives its own effect, and
   * the mechanism by which the original could be walked up to hours.
   */
  const maxCount = maxAttempts + Math.ceil(maxLockoutMs / lockoutMs);

  const failures = new Map<string, Record_>();
  let lastSweepAt = 0;

  /**
   * The record for a key with time applied, or null if there is nothing left.
   *
   * Decay is deliberately *not* applied while a lockout is running: the lockout
   * is a decision already taken and letting the clock erode it mid-flight would
   * end it early. Once it expires, the failures that caused it age out normally.
   * The remainder is kept (`seenAt` advances by whole steps, not to `now`) so a
   * client cannot reset its own decay clock by being read repeatedly.
   */
  function live(key: string, now: number): Record_ | null {
    const record = failures.get(key);
    if (!record) return null;
    if (record.until > now) return record;

    const steps = Math.floor((now - record.seenAt) / decayMs);
    if (steps > 0) {
      record.count = Math.max(0, record.count - steps);
      record.seenAt += steps * decayMs;
    }
    if (record.count === 0) {
      failures.delete(key);
      return null;
    }
    return record;
  }

  /** Fully decayed and not locked: the key is holding no information. */
  function spent(record: Record_, now: number): boolean {
    return record.until <= now && now - record.seenAt >= decayMs * record.count;
  }

  /**
   * Keep the map bounded, in two stages.
   *
   * The sweep is the honest one: entries that have decayed to nothing are gone
   * and deleting them loses nothing. The hard cap is the ugly one, and it is
   * chosen deliberately — when the map is full we drop the *oldest* keys, which
   * means an attacker who floods new keys can push out somebody else's counter
   * and hand them a fresh set of free attempts.
   *
   * That is a real weakening of the throttle under flood, and it is still the
   * right trade: the alternative, refusing new keys, means every client whose
   * key does not already exist is treated as unknown — either unthrottled
   * (identical outcome, more code) or locked out (an attacker with a few
   * thousand requests denies login to the entire population). Losing throttle
   * accuracy under attack is recoverable. Losing availability is the attack.
   */
  function evict(now: number): void {
    if (now - lastSweepAt >= SWEEP_INTERVAL_MS) {
      lastSweepAt = now;
      for (const [key, record] of failures) {
        if (spent(record, now)) failures.delete(key);
      }
    }
    // Map iterates in insertion order, so this is first-seen-first-out. Not
    // least-recently-used: tracking recency costs a write per read and buys
    // nothing here, because the cap is only ever reached while under attack.
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next();
      if (oldest.done) break;
      failures.delete(oldest.value);
    }
  }

  return {
    lockoutSeconds(key) {
      const now = Date.now();
      const record = live(key, now);
      if (!record || record.until <= now) return 0;
      return Math.ceil((record.until - now) / 1000);
    },

    recordFailure(key) {
      const now = Date.now();
      const record = live(key, now) ?? { count: 0, until: 0, seenAt: now };
      record.count = Math.min(record.count + 1, maxCount);
      record.seenAt = now;
      if (record.count >= maxAttempts) {
        record.until = now + Math.min(lockoutMs * (record.count - maxAttempts + 1), maxLockoutMs);
      }
      failures.set(key, record);
      evict(now);
    },

    clear(key) {
      failures.delete(key);
    },

    size() {
      return failures.size;
    },
  };
}

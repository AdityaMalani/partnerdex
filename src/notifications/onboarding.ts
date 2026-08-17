import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';
import { issueSetPasswordLink } from '../server/portalAuth.js';
import {
  recordEmailAttempt,
  resolveSender,
  sendSetPasswordEmail,
  SET_PASSWORD_EMAIL,
  type Sender,
} from './affiliateEmail.js';

/**
 * The bulk send: hundreds of partners, once, resumably.
 *
 * The failure this is built around is not "the relay refused a message". It is
 * "the run stopped at recipient 400 and the operator has no idea which 400".
 * Everything below exists to make that state recoverable without a spreadsheet:
 *
 *   - **Who is owed one is a query, not a list.** Membership of the batch is
 *     derived from the database every run — active, no password yet, no
 *     successful send on record — so a re-run after a crash naturally contains
 *     the remainder and nobody else. There is no cursor to lose.
 *   - **A recipient's failure is a recorded outcome, never an exception.** One
 *     bad address cannot end the run; it lands in `failures` with the relay's
 *     own words and the loop moves on.
 *   - **Rate limiting is in the loop.** A relay that gets hundreds of messages
 *     in ten seconds throttles, greylists or blocks; one every second or so
 *     arrives.
 *   - **A dry run is the same code.** It builds the same batch and reports it
 *     without minting a token or opening a socket, so what it shows is what the
 *     real run will do rather than a separate implementation's opinion.
 *
 * And one thing it deliberately refuses to do — see `sharedAddresses`.
 */

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface OnboardingCandidate {
  affiliateId: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface SharedAddress {
  email: string;
  affiliates: OnboardingCandidate[];
}

export interface OnboardingPlan {
  /** Who a real run would email. */
  recipients: OnboardingCandidate[];
  /** Already has a successful delivery on record. Skipped, and not a problem. */
  alreadyEmailed: OnboardingCandidate[];
  /** Already chose a password. Nothing to invite them to. */
  alreadyOnboarded: OnboardingCandidate[];
  /** No address at all, or one that is not an address. Nothing to be done here. */
  unreachable: OnboardingCandidate[];
  /** Two or more accounts on one address. Held back for a person to decide. */
  sharedAddresses: SharedAddress[];
  /** A previous attempt failed; this run will try again. Included in recipients. */
  retrying: OnboardingCandidate[];
}

export interface OnboardingOptions {
  /** Build and report the batch; mint nothing, send nothing. */
  dryRun?: boolean;
  /** Cap this pass. The rest stay owed and the next run picks them up. */
  limit?: number;
  /** Name specific affiliates instead of deriving the batch. */
  affiliateIds?: string[];
  /** Also email people who already have a successful delivery on record. */
  resend?: boolean;
  /** Override the pause between sends, in milliseconds. */
  spacingMs?: number;
  onProgress?: (message: string) => void;
}

export interface OnboardingSummary {
  dryRun: boolean;
  /** How many this pass intended to email. */
  planned: number;
  sent: number;
  failed: number;
  /** Everything that was held back, and why, so the numbers add up on screen. */
  skipped: {
    alreadyEmailed: number;
    alreadyOnboarded: number;
    unreachable: number;
    sharedAddresses: number;
    /** Beyond `limit`. Owed, and picked up by the next run. */
    deferred: number;
  };
  failures: Array<{ affiliateId: string; email: string; error: string; permanent: boolean }>;
  /** The shared-address groups in full, because this is a decision, not a stat. */
  sharedAddresses: SharedAddress[];
  /** Still owed an email after this pass, from this pass's own point of view. */
  remaining: number;
}

interface AffiliateRow {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  passwordSetAt: string | null;
  passwordHash: string | null;
  deliveryOk: number | null;
  deliveryError: string | null;
}

/**
 * Everything that could conceivably be in a batch, with the three facts that
 * decide whether it is.
 *
 * One query rather than a query per affiliate: hundreds of accounts each needing
 * a credential lookup and a delivery lookup is two round trips per affiliate
 * through better-sqlite3 to answer a question two LEFT JOINs answer once.
 */
function candidates(db: Db, affiliateIds?: string[]): AffiliateRow[] {
  const where = affiliateIds
    ? `a.id IN (${affiliateIds.map((_, i) => `@id${i}`).join(', ')})`
    : `a.status = 'active'`;
  const params: Record<string, unknown> = { kind: SET_PASSWORD_EMAIL };
  affiliateIds?.forEach((id, i) => {
    params[`id${i}`] = id;
  });

  // An explicitly named batch still refuses disabled accounts: naming an id is a
  // decision about which affiliate, not about whether a disabled one may be
  // invited into a portal that will not let them in.
  const scope = affiliateIds ? `${where} AND a.status = 'active'` : where;

  return db
    .prepare(
      `SELECT a.id, a.name, a.email, a.created_at AS createdAt,
              c.password_set_at AS passwordSetAt, c.password_hash AS passwordHash,
              d.ok AS deliveryOk, d.error AS deliveryError
         FROM affiliates a
         LEFT JOIN affiliate_credentials c ON c.affiliate_id = a.id
         LEFT JOIN affiliate_email_deliveries d
                ON d.affiliate_id = a.id AND d.kind = @kind
        WHERE ${scope}
        ORDER BY a.created_at, a.id`,
    )
    .all(params) as AffiliateRow[];
}

/** Enough of an address to be worth handing to a relay. Not a validator. */
function looksLikeAnAddress(email: string): boolean {
  const trimmed = email.trim();
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(trimmed);
}

function toCandidate(row: AffiliateRow): OnboardingCandidate {
  return { affiliateId: row.id, name: row.name, email: row.email, createdAt: row.createdAt };
}

/**
 * Work out who gets one, and who is held back.
 *
 * The shared-address rule is the interesting one and it is a refusal, not a
 * heuristic. The imported data has one address belonging to two different
 * affiliate accounts — two separate ledgers, two separate handles, both with
 * referrals in the wild — and email login resolves that address to the older
 * account. A bulk send would put two links to two *different* accounts in one
 * inbox, minutes apart, and whichever the person clicked second would be the one
 * they end up with, which is a coin flip over which of two balances they can
 * see.
 *
 * There is no correct automatic answer to that: merging the accounts is a
 * decision with money in it, and it would have to keep both handles live because
 * links using each are already out there. So both are held back and both are
 * reported by name. Naming the ids explicitly overrides this, because at that
 * point a human has made the decision the report asked for.
 */
export function planOnboarding(db: Db, options: OnboardingOptions = {}): OnboardingPlan {
  const rows = candidates(db, options.affiliateIds);

  const plan: OnboardingPlan = {
    recipients: [],
    alreadyEmailed: [],
    alreadyOnboarded: [],
    unreachable: [],
    sharedAddresses: [],
    retrying: [],
  };

  // Shared addresses are found across *every* active affiliate, not just the
  // rows in this batch: a batch of one is still one half of a shared inbox.
  const shared = new Set<string>();
  if (!options.affiliateIds) {
    const groups = db
      .prepare(
        `SELECT LOWER(TRIM(email)) AS key, COUNT(*) AS n
           FROM affiliates
          WHERE status = 'active' AND TRIM(email) <> ''
          GROUP BY key HAVING n > 1`,
      )
      .all() as Array<{ key: string; n: number }>;
    for (const group of groups) shared.add(group.key);
  }

  const sharedGroups = new Map<string, OnboardingCandidate[]>();

  for (const row of rows) {
    const candidate = toCandidate(row);
    const key = row.email.trim().toLowerCase();

    if (!looksLikeAnAddress(row.email)) {
      plan.unreachable.push(candidate);
      continue;
    }
    if (shared.has(key)) {
      const group = sharedGroups.get(key);
      if (group) group.push(candidate);
      else sharedGroups.set(key, [candidate]);
      continue;
    }
    // A password already set means they are in. Re-inviting them would be a
    // password-reset mail nobody asked for, which is indistinguishable from the
    // phishing we are asking them not to fall for.
    if (row.passwordSetAt && row.passwordHash) {
      plan.alreadyOnboarded.push(candidate);
      continue;
    }
    if (row.deliveryOk === 1 && !options.resend) {
      plan.alreadyEmailed.push(candidate);
      continue;
    }
    if (row.deliveryOk === 0) plan.retrying.push(candidate);
    plan.recipients.push(candidate);
  }

  plan.sharedAddresses = [...sharedGroups.entries()].map(([email, affiliates]) => ({
    email,
    affiliates,
  }));

  return plan;
}

/**
 * Deliberately not unref'd, for the reason `dispatch.ts` gives: a one-off CLI
 * process has nothing else holding the loop open, and an unref'd spacing timer
 * would let it exit between two sends — delivering the first, dropping the rest,
 * and leaving no error to explain it.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let inFlight: Promise<OnboardingSummary> | null = null;

/**
 * Send the batch.
 *
 * Never runs twice at once. Two concurrent passes would read the same "not yet
 * emailed" set before either had written a delivery record, which is the one way
 * this design could mail somebody twice.
 */
export function runOnboarding(
  db: Db = getDb(),
  options: OnboardingOptions = {},
): Promise<OnboardingSummary> {
  if (inFlight) {
    return Promise.reject(
      new OnboardingError('An onboarding send is already running. Wait for it to finish.', 409),
    );
  }
  inFlight = execute(db, options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function execute(db: Db, options: OnboardingOptions): Promise<OnboardingSummary> {
  const dryRun = options.dryRun === true;
  const sender: Sender = resolveSender();

  // Refused rather than reported as a batch of successes. A no-op sender that
  // quietly
  // walked the batch would write a delivery record for every affiliate and make
  // the whole population look onboarded, which is worse than not running: the
  // ledger is what a later run trusts.
  if (!dryRun && sender.kind === 'noop') {
    throw new OnboardingError(
      `Refusing to run: there is no mail sender configured, so nothing would be delivered. ` +
        `${sender.reason}`,
    );
  }

  const plan = planOnboarding(db, options);
  const limit = options.limit && options.limit > 0 ? options.limit : plan.recipients.length;
  const batch = plan.recipients.slice(0, limit);
  const spacingMs = options.spacingMs ?? getConfig().email.spacingMs;
  const progress = options.onProgress ?? ((): void => undefined);

  const summary: OnboardingSummary = {
    dryRun,
    planned: batch.length,
    sent: 0,
    failed: 0,
    skipped: {
      alreadyEmailed: plan.alreadyEmailed.length,
      alreadyOnboarded: plan.alreadyOnboarded.length,
      unreachable: plan.unreachable.length,
      sharedAddresses: plan.sharedAddresses.reduce((n, group) => n + group.affiliates.length, 0),
      deferred: plan.recipients.length - batch.length,
    },
    failures: [],
    sharedAddresses: plan.sharedAddresses,
    remaining: plan.recipients.length,
  };

  if (dryRun) return summary;

  for (const [index, candidate] of batch.entries()) {
    try {
      // Minted inside the loop, one at a time. Minting them all up front would
      // start a 24-hour clock on the last recipient's link at the same instant
      // as the first, and a run that takes a quarter of an hour would be handing
      // out links that are already partly spent.
      const link = issueSetPasswordLink(db, candidate.affiliateId);
      if (!link) {
        // Between the plan and now, the account stopped being active. Rare, and
        // not a failure of anything — record nothing and carry on.
        summary.skipped.unreachable += 1;
        continue;
      }

      const outcome = await sendSetPasswordEmail(db, link, sender);
      if (outcome.ok) {
        summary.sent += 1;
        summary.remaining -= 1;
        progress(`  sent ${index + 1}/${batch.length}  ${candidate.email}`);
      } else {
        summary.failed += 1;
        summary.failures.push({
          affiliateId: candidate.affiliateId,
          email: candidate.email,
          error: outcome.error ?? 'unknown error',
          permanent: outcome.permanent,
        });
        progress(`  FAILED ${index + 1}/${batch.length}  ${candidate.email}: ${outcome.error}`);
      }
    } catch (cause) {
      /*
       * The catch-all that makes the run survivable.
       *
       * `sendMail` returns its failures rather than throwing, so nothing routine
       * arrives here — which is exactly why it must still be caught. What lands
       * here is the unforeseen: a database write that failed, a bug in the
       * template, an out-of-memory on one enormous name. None of those are a
       * reason to abandon the other 613 people, and every one of them would be
       * without this.
       */
      const error = cause instanceof Error ? cause.message : String(cause);
      summary.failed += 1;
      summary.failures.push({
        affiliateId: candidate.affiliateId,
        email: candidate.email,
        error,
        permanent: false,
      });
      // Recorded as a failed attempt so the ledger shows a try rather than a
      // silence, and so the next run retries this person rather than skipping.
      try {
        recordEmailAttempt(db, {
          affiliateId: candidate.affiliateId,
          email: candidate.email,
          ok: false,
          error,
        });
      } catch {
        // If even the ledger write fails there is nothing useful left to do
        // about this recipient, and the run still has to reach the next one.
      }
      progress(`  FAILED ${index + 1}/${batch.length}  ${candidate.email}: ${error}`);
    }

    if (index < batch.length - 1 && spacingMs > 0) await sleep(spacingMs);
  }

  return summary;
}

/** The run, as an operator wants to read it at a terminal. */
export function formatOnboardingSummary(summary: OnboardingSummary): string {
  const lines: string[] = [];
  lines.push(
    summary.dryRun
      ? `Dry run: ${summary.planned} affiliate(s) would be emailed a set-password link.`
      : `Sent ${summary.sent} of ${summary.planned} attempted; ${summary.failed} failed.`,
  );

  const skipped = summary.skipped;
  lines.push(
    `Skipped: ${skipped.alreadyOnboarded} already have a password, ` +
      `${skipped.alreadyEmailed} already emailed, ` +
      `${skipped.unreachable} with no usable address, ` +
      `${skipped.sharedAddresses} on a shared address, ` +
      `${skipped.deferred} deferred past this run's limit.`,
  );

  if (summary.sharedAddresses.length > 0) {
    lines.push('');
    lines.push(
      `Held back — one address, more than one account. Email login resolves each of these`,
    );
    lines.push(
      `addresses to the oldest account, so sending both links would let the wrong one win.`,
    );
    lines.push(`Decide per address, then invite the chosen account by id:`);
    for (const group of summary.sharedAddresses) {
      lines.push(`  ${group.email}`);
      for (const affiliate of group.affiliates) {
        lines.push(
          `    ${affiliate.affiliateId}  ${affiliate.name}  (created ${affiliate.createdAt.slice(0, 10)})`,
        );
      }
    }
  }

  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`Failures (${summary.failures.length}) — re-run to retry these:`);
    for (const failure of summary.failures) {
      lines.push(`  ${failure.email}: ${failure.error}`);
    }
  }

  if (!summary.dryRun && summary.remaining > 0) {
    lines.push('');
    lines.push(`${summary.remaining} still owed an email. Run the command again to continue.`);
  }

  return lines.join('\n');
}

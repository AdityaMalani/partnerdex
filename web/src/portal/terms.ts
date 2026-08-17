import type { Program } from './api';

/**
 * The words the portal uses for the two things an affiliate most needs stated
 * plainly: what state their membership is in, and what they get paid.
 *
 * Kept in one file because both are claims about money that the company has to
 * stand behind, and a claim phrased three different ways on three pages is a
 * claim nobody has checked. An affiliate reading these sentences should be able
 * to predict their own earnings; if they cannot, the sentence is wrong.
 */

export interface StatusCopy {
  /** The word on the pill. */
  label: string;
  /** The pill's class suffix, borrowed from the dashboard's palette. */
  tone: 'paying' | 'trialing' | 'churned';
  /** What the state means for the affiliate's money, said in full. */
  meaning: string;
  /** Whether a link for this membership can actually earn anything. */
  earning: boolean;
}

export function statusCopy(status: string): StatusCopy {
  switch (status) {
    case 'enrolled':
      return {
        label: 'Active',
        tone: 'paying',
        meaning: 'Installs that follow your link are credited to you.',
        earning: true,
      };
    case 'pending':
      return {
        label: 'Awaiting approval',
        tone: 'trialing',
        // Said this bluntly on purpose. A pending affiliate who is handed a link
        // will promote it, and installs it brings in are not credited to
        // anybody. Better they read that here than work it out from a balance
        // that never moves.
        meaning:
          'Your application has not been approved yet, so there is no link to share and installs cannot be credited to you.',
        earning: false,
      };
    case 'rejected':
      return {
        label: 'Not approved',
        tone: 'churned',
        meaning:
          'This application was not approved. Installs cannot be credited to you for this program. Get in touch if you think that is a mistake.',
        earning: false,
      };
    default:
      return {
        label: status || 'Unknown',
        tone: 'trialing',
        meaning: 'This membership is not active, so installs cannot be credited to you.',
        earning: false,
      };
  }
}

/** `0.2` → `20%`. Trailing zeroes dropped: nobody writes their rate as 20.00%. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(rate * 100)}%`;
}

/*
 * There is deliberately no `UNASSIGN_AFTER_UNINSTALL_DAYS` constant here.
 *
 * There was one, set to 30, surviving as a fallback for the caller that
 * degrades to `/me` when `/portal/api/programs` is not deployed. A hardcoded
 * copy of a per-program column is only ever right by coincidence — it was
 * right for the deployment it was written in and wrong for every other — and a
 * number shown to the person being paid is not a place to be right by
 * coincidence. When the value does not arrive, the claim is not made: see
 * `sharedTerms`, which states only what every program in front of the reader
 * agrees on.
 */

/** `subscription` → `Subscription`, `one_time` → `One-off`. */
function componentLabel(component: string): string {
  if (component === 'one_time') return 'one-off';
  return component;
}

/**
 * The per-program terms, as cells rather than sentences.
 *
 * Every value is checkable against the ledger: the 20%-of-gross rule was
 * re-derived from every imported historical commission row rather than read
 * off a settings screen.
 *
 * These were five bullet points of prose until the portal was tightened. Every
 * fact survived the move into a table; the qualifiers did the shrinking. The one
 * that must never be dropped is `from` on the duration — the clock starts at the
 * first commission on a merchant, not at their install, and an affiliate who
 * reads it the other way will expect the cap to expire months early.
 */
export interface ProgramTerms {
  /** What fraction of the merchant's charge is earned. */
  rate: string;
  /** Which charges count. */
  earnsOn: string;
  /** How long it runs, and what the clock starts from. */
  duration: string;
  /** The qualifier under `duration`, when there is a cap to qualify. */
  durationFrom: string | null;
}

export function termsFor(program: Program): ProgramTerms {
  // Every component this program pays on, named. Previously `subscription` was
  // compared as a string and anything else was printed verbatim, which put the
  // raw column value in front of an affiliate and — worse — sat beside a shared
  // bullet asserting that usage charges earn nothing, which stopped being true
  // the moment a program could be set up to pay on them.
  const components = (
    program.revenueComponents?.length ? program.revenueComponents : ['subscription']
  ).map(componentLabel);
  const listed =
    components.length === 1
      ? `${components[0]} charges only`
      : `${components.slice(0, -1).join(', ')} and ${components[components.length - 1]} charges`;

  return {
    rate: `${formatRate(program.commissionRate)} of gross`,
    earnsOn: listed.replace(/^./, (first) => first.toUpperCase()),
    duration: program.durationMonths ? `${program.durationMonths} months` : 'No cut-off',
    durationFrom: program.durationMonths ? 'from your first commission' : null,
  };
}

/**
 * The terms below the table, derived from the programs actually shown.
 *
 * A function rather than a constant, because two of these sentences are claims
 * about a *program* and were being asserted over all of them. "Usage and
 * one-off charges earn nothing" is false for a program set up to pay on usage,
 * and the release window is a per-program column that was being printed from a
 * hardcoded 30. Both are money claims shown to the person being paid, so both
 * are now read from the programs in front of them, and a claim that does not
 * hold for every program on the page is not made at all.
 */
export function sharedTerms(programs: Program[]): string[] {
  const lines = ['Gross means the full charge, before Shopify’s cut and before ours.'];

  const releaseDays = new Set(
    programs.map((program) =>
      typeof program.unassignAfterUninstallDays === 'number'
        ? program.unassignAfterUninstallDays
        : null,
    ),
  );
  if (releaseDays.size === 1) {
    const days = [...releaseDays][0];
    if (typeof days === 'number') {
      lines.push(
        `A referral is released ${days} days after the merchant uninstalls and stops earning; ` +
          `reinstalling inside those ${days} days keeps it yours.`,
      );
    }
  }

  /*
   * This line used to read "If a charge is refunded, the commission on it is
   * withdrawn." It was false, and it was false in the direction that matters:
   * the engine declines to write a negative commission at all — refunds and
   * downgrade adjustments arrive as sales with a negative gross and are skipped
   * as `non_positive_gross` — because the platform this replaced never wrote
   * one, and introducing a clawback would be a policy change rather than a fix.
   *
   * So the system promised a clawback it does not perform, on the page where it
   * tells people what they will be paid. Replaced with what actually happens.
   */
  lines.push(
    'A refunded or credited charge earns no commission. It does not reduce one you have ' +
      'already earned.',
    'Rates are the same for everyone on a program, and are worked out automatically from the ' +
      'charges Shopify reports. There is nothing to submit.',
  );
  return lines;
}

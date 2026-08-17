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

/**
 * The uninstall rule used to be the one term here not carried in the API
 * response: `unassign_after_uninstall_days` is a per-program column that no
 * endpoint returned, so it was a constant. `/portal/api/programs` returns it
 * now.
 *
 * The constant survives as a fallback for one caller — `fetchPrograms`
 * degrades to `/me` when the newer endpoint is not deployed, and `/me` does
 * not carry the field. It is 30 for both programs today, so the fallback and
 * the data agree, which is exactly the condition under which a hardcoded copy
 * later goes wrong in silence.
 */
export const UNASSIGN_AFTER_UNINSTALL_DAYS = 30;

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
  const components = program.revenueComponents?.length
    ? program.revenueComponents.join(', ')
    : 'subscription';

  return {
    rate: `${formatRate(program.commissionRate)} of gross`,
    earnsOn:
      components === 'subscription'
        ? 'Subscription charges only'
        : components.replace(/^./, (first) => first.toUpperCase()),
    duration: program.durationMonths ? `${program.durationMonths} months` : 'No cut-off',
    durationFrom: program.durationMonths ? 'from your first commission' : null,
  };
}

/**
 * The terms that are not per-program: they hold for every program today, and
 * every one of them reduces what gets paid. Kept where an affiliate predicting
 * their earnings will see them, and worded short rather than softened.
 */
export const SHARED_TERMS: string[] = [
  'Gross means the full charge, before Shopify’s cut and before ours.',
  'Usage and one-off charges earn nothing.',
  `A referral is released ${UNASSIGN_AFTER_UNINSTALL_DAYS} days after the merchant uninstalls and stops earning; reinstalling inside those ${UNASSIGN_AFTER_UNINSTALL_DAYS} days keeps it yours.`,
  'If a charge is refunded, the commission on it is withdrawn.',
  'Rates are the same for everyone on a program, and are worked out automatically from the charges Shopify reports. There is nothing to submit.',
];

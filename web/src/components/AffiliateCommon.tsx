import { useEffect, useState, type ReactNode } from 'react';
import type { Merchant } from '../api';
import { formatValue } from '../format';

/**
 * The small pieces the affiliate pages share: a figure tile, the status pills,
 * a merchant cell and a copy control.
 *
 * They live here rather than being repeated per page so that "enrolled" is the
 * same word in the same colour on the list, on the detail and in the approval
 * queue. A status that reads differently in two places is read as two statuses.
 */

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/*
 * Membership status carries a colour, but the word is always there — the pill
 * rules in the stylesheet were written on that basis and this follows them.
 * 'pending' deliberately takes the brand rather than a warning colour: an
 * application waiting on a decision is work to do, not a fault.
 */
const MEMBERSHIP_PILL: Record<string, string> = {
  enrolled: 'pill-paying',
  pending: 'pill-trialing',
  rejected: 'pill-churned',
};

export const MEMBERSHIP_LABEL: Record<string, string> = {
  enrolled: 'Enrolled',
  pending: 'Pending',
  rejected: 'Rejected',
};

export function MembershipPill({ status }: { status: string }) {
  return (
    <span className={`pill ${MEMBERSHIP_PILL[status] ?? ''}`.trim()}>
      {MEMBERSHIP_LABEL[status] ?? status}
    </span>
  );
}

/**
 * Whether a referral still stands.
 *
 * Unassigned is not "deleted": the commissions earned under it are real money
 * and stay on the ledger. The pill says "Unassigned" for that reason, and the
 * date it happened is shown beside it wherever there is room.
 *
 * **Live is the quiet one.** Nearly every referral is live, and a column of
 * green pills is a column that says nothing — the eye stops separating them
 * from the background, and the few that are *not* live stop being visible at a
 * glance. So the ordinary state takes the neutral pill and the exception keeps
 * the colour. Same reasoning as `PayoutPill` below.
 */
export function ReferralPill({ unassignedAt }: { unassignedAt: string | null }) {
  return unassignedAt ? (
    <span className="pill pill-churned">Unassigned</span>
  ) : (
    <span className="pill">Live</span>
  );
}

/**
 * Where a referral came from. Only `ga4` is automated; `manual` is an admin
 * assigning a merchant retroactively, and `imported` came across from Mantle
 * carrying whatever it was there. The distinction is the reason this column
 * exists, so it is a pill rather than a word in a run of grey text.
 */
const SOURCE_PILL: Record<string, string> = {
  ga4: 'pill-trialing',
  manual: 'pill-sub-pending',
  imported: 'pill-sub-replaced',
};

export function SourcePill({ source, label }: { source: string; label: string }) {
  return <span className={`pill ${SOURCE_PILL[source] ?? ''}`.trim()}>{label}</span>;
}

/* ------------------------------------------------------------- merchants
 *
 * How a store is named wherever it appears in the affiliate admin: the referral
 * feed, an affiliate's referrals, the claim queue and a payout's itemisation.
 *
 * The shape is the Customers page's, deliberately and not by coincidence — name
 * on the first line, myshopify domain on the second, the whole cell a link to
 * that merchant's page when we have one. An operator moving between Customers
 * and Referrals should not have to learn a second way of reading the same
 * store, and an affiliate referral that reads differently from the customer
 * record it points at invites the question of whether they are the same store.
 *
 * These components are the *only* place the admin renders a merchant, so the
 * unknown-handling below cannot be quietly bypassed by one page.
 */

/**
 * The name and domain of a store, linked to it where the link exists.
 *
 * Two things are load-bearing.
 *
 * **The domain is always shown.** It is the durable identity — a sizeable share
 * of referrals have one and no shop id — and it is what an operator pastes into
 * the Partner dashboard. The name is what they recognise; showing only one of
 * the two is what made this queue unworkable.
 *
 * **A merchant not in `shops` says so, and says nothing else.** "Not synced
 * yet" is the true statement. Rendering them as an ordinary row with blanks
 * would read as a store we know and have nothing to say about, which is a
 * different and wrong claim.
 */
export function MerchantCell({
  merchant,
  /** Used when the server predates the merchant read model. */
  fallbackDomain,
  fallbackName,
}: {
  merchant?: Merchant;
  fallbackDomain?: string | null;
  fallbackName?: string | null;
}) {
  const domain = merchant?.myshopifyDomain ?? fallbackDomain ?? null;
  const name = merchant?.name ?? fallbackName ?? null;
  const shopId = merchant?.shopId ?? null;

  // Nothing at all identifies this merchant. Rare, and shown as an em dash
  // rather than as an empty cell that reads as a rendering fault.
  if (!domain && !name) return <span className="muted-cell">—</span>;

  // A domain is longer than any column that also has to hold nine others, so
  // the cell is capped and truncates — with the whole of it on the title, since
  // the domain is what an operator copies out of here.
  const title = [name, domain].filter(Boolean).join(' · ');

  const body = (
    <>
      <span className="customer-name">{name ?? domain}</span>
      {/* "Not synced yet" used to be repeated here. It is now said once, in the
          merchant-state column beside this one, so a row does not carry the
          same sentence twice. */}
      <span className="customer-domain">{name && domain ? domain : ''}</span>
    </>
  );

  if (shopId) {
    return (
      <a className="customer-link" href={`#/customers/${shopId}`} title={title}>
        {body}
      </a>
    );
  }
  return (
    <span className="customer-link" title={title}>
      {body}
    </span>
  );
}

/**
 * What we know about the merchant themselves: installed or not, and what they
 * pay — in one cell, because today we usually know neither.
 *
 * This was two columns, "Plan" and "App", and on most rows both read "Not
 * synced yet": `subscriptions` and `install_intervals` are rebuilt after the
 * transaction backfill. Two columns of the same sentence pushed the columns an
 * operator came for — standing, earnings, the decide buttons — off the right
 * edge. One column states the same fact once.
 *
 * What it must never do is round the unknown down. `unknown` is "Not synced
 * yet", never "Free", "None" or "$0.00": showing a zero would state, in the
 * same typeface as a real figure, that a merchant who pays us every month pays
 * us nothing. The tooltip carries the why, so no page has to print it.
 */
export function MerchantState({ merchant }: { merchant?: Merchant }) {
  const install = merchant && merchant.install !== 'unknown' ? merchant.install : null;
  const plan = merchant && merchant.plan !== 'unknown' ? merchant.plan : null;

  // Neither half known, which is the common case today. Said once, quietly.
  if (!install && !plan) {
    return (
      <span
        className="muted-cell"
        title="Plan and install state are rebuilt after the transaction backfill. Unknown, not zero."
      >
        Not synced yet
      </span>
    );
  }

  return (
    <span className="merchant-state">
      {install ? (
        install === 'installed' ? (
          <span className="pill pill-installed">Installed</span>
        ) : (
          <span className="pill pill-gone">Uninstalled</span>
        )
      ) : null}
      <span className="cell-note">
        {plan === null
          ? 'Plan not synced'
          : plan === 'free'
            ? 'No paid plan'
            : `${formatValue(merchant?.monthlyAmount ?? 0, 'money', merchant?.currency ?? null)} · ${
                merchant?.planName ?? 'Paid plan'
              }`}
      </span>
    </span>
  );
}

/**
 * Payout status.
 *
 * Inverted against the obvious reading, for the same reason `ReferralPill` is:
 * nearly every payout on record is paid, so a green "Paid" on every row is
 * decoration and the one row that is *not* settled — the only row anybody has
 * anything to do about — is the one that disappears into it. Settled is the
 * neutral pill; anything still owed or refused carries the colour.
 */
const PAYOUT_PILL: Record<string, string> = {
  paid: '',
  processing: 'pill-trialing',
  pending: 'pill-trialing',
  scheduled: 'pill-trialing',
  requested: 'pill-trialing',
  failed: 'pill-churned',
  cancelled: 'pill-churned',
};

export function PayoutPill({ status }: { status: string }) {
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
  return <span className={`pill ${PAYOUT_PILL[status] ?? ''}`.trim()}>{label}</span>;
}

/**
 * Copy one string, and say that it worked.
 *
 * The confirmation is the whole point: a referral link that may or may not be
 * on the clipboard is one the operator pastes into an email to find out, and
 * `navigator.clipboard` is absent over plain HTTP, where the fallback is to
 * select the text by hand.
 */
export function CopyButton({
  value,
  label = 'Copy',
  title,
}: {
  value: string;
  label?: string;
  title?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setState('failed');
      return;
    }
    clipboard.writeText(value).then(
      () => setState('copied'),
      () => setState('failed'),
    );
  };

  return (
    <button type="button" className="link-button" onClick={copy} title={title ?? value}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it by hand' : label}
    </button>
  );
}

/**
 * The state every one of these pages needs and none of them should invent
 * twice: loading, failed, or empty.
 *
 * Empty is **one line**. It used to be a bordered notice with a heading and a
 * paragraph explaining what would have appeared here and why it had not, on
 * every page, and a reader who can see an empty table already knows the first
 * half of that. Where the absence has a cause worth acting on — a route that is
 * not deployed, a filter that is too narrow — the line says that instead.
 *
 * A failure keeps its notice: it is the one state the reader cannot diagnose
 * from what is on screen.
 */
export function LoadState({
  loading,
  error,
  empty,
  emptyMessage,
  loadingLabel = 'Loading…',
  errorTitle = 'Could not load',
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  /** One short line. Not a paragraph, and never a heading plus a paragraph. */
  emptyMessage: ReactNode;
  loadingLabel?: string;
  errorTitle?: string;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div className="notice error">
        <h2>{errorTitle}</h2>
        <p>{error}</p>
      </div>
    );
  }
  // Loading is only allowed to replace the page when there is nothing to
  // replace: a refresh after an approval updates the figures in place rather
  // than blanking the table the operator is reading.
  if (loading && empty) return <div className="skeleton">{loadingLabel}</div>;
  if (empty) return <p className="empty-line">{emptyMessage}</p>;
  return <>{children}</>;
}

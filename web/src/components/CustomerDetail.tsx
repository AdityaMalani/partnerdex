import { useEffect, useRef, useState } from 'react';
import {
  fetchCustomer,
  type CustomerApp,
  type CustomerDetail as Detail,
  type CustomerEventRecord,
  type CustomerSubscription,
} from '../api';
import { formatCalendarDate, formatFullDate, formatValue } from '../format';
import { StatusPill } from './Customers';
import { Stars } from './Reviews';

/**
 * One merchant, end to end: what they run today, what they have paid, and
 * everything that has ever happened to them.
 *
 * The timeline is the compiled lifecycle, not the raw feed — so an upgrade
 * reads as one upgrade rather than as a cancellation followed by a signup, and
 * the churn shown here is the same churn the reports count.
 */

const EVENT_LABEL: Record<string, string> = {
  installed: 'Installed',
  reinstalled: 'Reinstalled',
  uninstalled: 'Uninstalled',
  deactivated: 'Store deactivated',
  reactivated: 'Store reactivated',
  subscribed: 'Subscribed',
  resubscribed: 'Resubscribed',
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
  unsubscribed: 'Cancelled',
  subscription_frozen: 'Billing frozen',
  subscription_unfrozen: 'Billing resumed',
  charge_abandoned: 'Never approved the charge',
  trial_started: 'Trial started',
  trial_converted: 'Trial converted',
  trial_abandoned: 'Cancelled during trial',
  trial_expired: 'Trial ended',
  payment: 'Payment',
  refund: 'Refund',
  review_posted: 'Left a review',
  review_edited: 'Rewrote their review',
  review_removed: 'Review removed',
};

/** Groups the vocabulary into the three things a reader is scanning for. */
const EVENT_TONE: Record<string, 'good' | 'bad' | 'neutral'> = {
  installed: 'good',
  reinstalled: 'good',
  subscribed: 'good',
  resubscribed: 'good',
  upgraded: 'good',
  trial_converted: 'good',
  subscription_unfrozen: 'good',
  reactivated: 'good',
  payment: 'good',
  uninstalled: 'bad',
  unsubscribed: 'bad',
  downgraded: 'bad',
  subscription_frozen: 'bad',
  trial_expired: 'bad',
  trial_abandoned: 'bad',
  charge_abandoned: 'bad',
  deactivated: 'bad',
  refund: 'bad',
};

const SUB_STATUS_LABEL: Record<CustomerSubscription['status'], string> = {
  active: 'Active',
  trialing: 'On trial',
  frozen: 'Frozen',
  churned: 'Cancelled',
  replaced: 'Replaced',
  pending: 'Not yet billing',
};

/** Shopify bills every 30 days or annually, and nothing else. */
function cadence(interval: string | null): string {
  return interval === 'ANNUAL' ? 'per year' : 'per 30 days';
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | null;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

function EventRow({ event, currency }: { event: CustomerEventRecord; currency: string | null }) {
  const detail = event.detail ?? {};
  const churnReason = typeof detail.churnReason === 'string' ? detail.churnReason : null;
  const rating = typeof detail.rating === 'number' ? detail.rating : null;

  // Reviews are the one family whose tone is not settled by the type: the same
  // event is the best or worst news of the month depending on a number that
  // sits in the payload rather than in the vocabulary.
  const tone =
    event.type === 'review_removed'
      ? 'bad'
      : rating !== null
        ? rating >= 4
          ? 'good'
          : rating <= 2
            ? 'bad'
            : 'neutral'
        : (EVENT_TONE[event.type] ?? 'neutral');

  const label = EVENT_LABEL[event.type] ?? event.type;

  // Each event says the one thing that matters about it: cash for a payment,
  // the plan for a subscription move, the stars for a review.
  let figure: string | null = null;
  if (event.amount !== null) {
    figure = formatValue(event.amount, 'money', event.currency ?? currency);
  } else if (event.netChange !== null && event.netChange !== 0) {
    const sign = event.netChange > 0 ? '+' : '−';
    figure = `${sign}${formatValue(Math.abs(event.netChange), 'money', event.currency ?? currency)} MRR`;
  } else if (rating !== null) {
    figure = `${rating}★`;
  }

  const body = typeof detail.body === 'string' ? detail.body : null;

  return (
    <li className={`event event-${tone}`}>
      <div className="event-marker" aria-hidden="true" />
      <div className="event-body">
        <div className="event-head">
          <span className="event-label">{label}</span>
          {figure ? <span className="event-figure">{figure}</span> : null}
        </div>
        {/* The merchant's own words, which is the whole reason a review is on
            this timeline rather than only in the count. */}
        {body ? <p className="event-quote">{body}</p> : null}
        <div className="event-meta">
          {/* A posted review carries a day and no time, so it is read as the
              date it is rather than converted out of a timezone it never had.
              Everything else on this timeline is a real instant. */}
          <span>
            {event.type === 'review_posted'
              ? formatCalendarDate(event.occurredAt.slice(0, 10))
              : formatFullDate(event.occurredAt)}
          </span>
          {event.appName ? <span>{event.appName}</span> : null}
          {event.planName ? <span>{event.planName}</span> : null}
          {churnReason === 'uninstalled' ? <span>ended by uninstall</span> : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The link that opens the App Store's own "write a review" dialog.
 *
 * The fragment is what the listing page uses to open the modal on load, so a
 * merchant who follows it lands in the form rather than on the page with the
 * review section somewhere below the fold.
 */
function writeReviewLink(listingUrl: string): string {
  return `${listingUrl}#modal-show=WriteReviewModal`;
}

/**
 * The review this merchant left for this app, or a way to ask for one.
 *
 * Only the stars and whether it still stands are shown inline — a table row is
 * the wrong shape for a paragraph of prose, and the rating is the part that is
 * scannable down a column. The text is a click away.
 */
function ReviewCell({ app }: { app: CustomerApp }) {
  const [at, setAt] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const cell = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = at !== null;

  /**
   * Opening measures the button and pins the panel to the viewport.
   *
   * It cannot simply be absolutely positioned inside the cell: this table sits
   * in a `.table-wrap`, and an `overflow-x: auto` ancestor clips on *both* axes,
   * so a panel anchored in the row would be cut off at the table's edge —
   * exactly where the last column puts it.
   */
  const openAt = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;

    const right = Math.max(window.innerWidth - rect.right, 8);
    const below = window.innerHeight - rect.bottom;

    // A review near the foot of a short window would open off the bottom of it.
    // Flip above when there is more room there; the panel caps its own height,
    // so neither direction can run past the edge.
    setAt(
      below < 200 && rect.top > below
        ? { bottom: window.innerHeight - rect.top + 6, right }
        : { top: rect.bottom + 6, right },
    );
  };

  // A popover that survives a click anywhere else is one the reader has to hunt
  // for a way to close. Scrolling closes it too — pinned to the viewport, it
  // would otherwise stay put while the row it belongs to slid away.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!cell.current?.contains(target) && !document.querySelector('.review-popover')?.contains(target)) {
        setAt(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAt(null);
        trigger.current?.focus();
      }
    };
    const close = () => setAt(null);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    // Capture, so the table's own horizontal scroll is caught as well.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const copy = async () => {
    if (!app.listingUrl) return;
    const link = writeReviewLink(app.listingUrl);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access needs a secure context and can be refused outright.
      // Showing the link beats a button that silently does nothing.
      window.prompt('Copy this link', link);
    }
  };

  if (!app.review) {
    if (!app.listingUrl) {
      return (
        <span className="muted-cell" title="Map this app to its App Store listing to ask for one.">
          —
        </span>
      );
    }
    return (
      <button type="button" className="link-button" onClick={copy}>
        {copied ? 'Link copied' : 'Copy review link'}
      </button>
    );
  }

  const review = app.review;
  const removed = review.removedAt !== null;

  return (
    <div className="review-cell" ref={cell}>
      <button
        ref={trigger}
        type="button"
        className="review-stars-button"
        onClick={() => (open ? setAt(null) : openAt())}
        aria-expanded={open}
        title="Read the review"
      >
        <Stars rating={review.rating} />
      </button>
      {removed ? (
        <span
          className="pill pill-removed"
          title="No longer on the listing. Whether Shopify removed it, the merchant deleted it, or the store closed is not observable from outside."
        >
          Removed
        </span>
      ) : (
        <span className="pill pill-published">Published</span>
      )}

      {at ? (
        <div
          className="review-popover"
          role="dialog"
          aria-label="Review"
          style={at}
        >
          <div className="review-head">
            <Stars rating={review.rating} />
            <span className="review-meta">{formatCalendarDate(review.postedOn)}</span>
            {review.editedAt ? (
              <span className="pill pill-edited">
                {review.priorRating !== null && review.priorRating !== review.rating
                  ? `Edited · was ${review.priorRating}★`
                  : 'Edited'}
              </span>
            ) : null}
          </div>
          {review.body ? (
            <p className="review-body">{review.body}</p>
          ) : (
            <p className="review-meta">They rated it without writing anything.</p>
          )}
          {review.replyBody ? (
            <div className="review-reply">
              <span className="review-meta">
                You replied
                {review.replyOn ? ` ${formatCalendarDate(review.replyOn)}` : ''}
              </span>
              <p>{review.replyBody}</p>
            </div>
          ) : null}
          {removed ? (
            <p className="review-meta">
              Kept locally — once the listing drops a review this is the only copy left.
            </p>
          ) : review.permalink ? (
            <a
              className="link-button"
              href={review.permalink}
              target="_blank"
              rel="noreferrer noopener"
            >
              View on the App Store
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every app this merchant has, not only the ones they pay for.
 *
 * Leading with live subscriptions answered "what are they paying for" and
 * silently dropped every app they installed and never bought — which on a
 * customer's page is the population most worth looking at.
 */
function AppsTable({ rows, currency }: { rows: CustomerApp[]; currency: string | null }) {
  return (
    <div className="card full">
      <div className="card-head">
        <span className="card-label">Apps</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Plan</th>
              <th>Price</th>
              <th>MRR</th>
              <th>Status</th>
              <th>Since</th>
              <th>Payments</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.appId}>
                <td>{row.appName ?? row.appId}</td>
                <td>{row.planName ?? '—'}</td>
                <td>
                  {row.amount === null ? (
                    '—'
                  ) : (
                    <>
                      {formatValue(row.amount, 'money', row.currency ?? currency)}
                      <span className="cadence"> {cadence(row.billingInterval)}</span>
                    </>
                  )}
                </td>
                {/* Zero is the honest answer for an app that earns nothing
                    today, and an em dash reads as "unknown" rather than "none". */}
                <td>{formatValue(row.mrr, 'money', row.currency ?? currency)}</td>
                <td>
                  <StatusPill status={row.status} />
                </td>
                <td>{row.since ? formatFullDate(row.since) : '—'}</td>
                <td>
                  {row.paymentCount}
                  {row.paymentCount > 0 ? (
                    <span className="cell-note">
                      {formatValue(row.paidGross, 'money', row.currency ?? currency)}
                    </span>
                  ) : null}
                </td>
                <td>
                  <ReviewCell app={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SubscriptionTable({
  rows,
  currency,
  caption,
}: {
  rows: CustomerSubscription[];
  currency: string | null;
  caption: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="card full">
      <div className="card-head">
        <span className="card-label">{caption}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>App</th>
              <th>Plan</th>
              <th>Price</th>
              <th>MRR</th>
              <th>Status</th>
              <th>Since</th>
              <th>Payments</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.chargeId}>
                <td>{row.appName ?? row.appId}</td>
                <td>{row.planName ?? '—'}</td>
                <td>
                  {formatValue(row.amount, 'money', row.currency ?? currency)}
                  <span className="cadence"> {cadence(row.billingInterval)}</span>
                </td>
                <td>{formatValue(row.monthlyAmount, 'money', row.currency ?? currency)}</td>
                <td>
                  <span className={`pill pill-sub-${row.status}`}>
                    {SUB_STATUS_LABEL[row.status]}
                  </span>
                </td>
                <td>{row.activatedAt ? formatFullDate(row.activatedAt) : '—'}</td>
                <td>{row.paidSaleCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CustomerDetail({
  shopId,
  appId,
  orgId = '',
}: {
  shopId: string;
  appId: string;
  orgId?: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    fetchCustomer(shopId, appId, orgId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shopId, appId, orgId]);

  if (loading) return <div className="skeleton">Loading merchant…</div>;

  if (error || !detail) {
    return (
      <div className="notice error">
        <h2>Could not load this merchant</h2>
        <p>{error ?? 'Not found.'}</p>
        <p>
          <a href="#/customers">Back to customers</a>
        </p>
      </div>
    );
  }

  // Charge history: what the per-app view above cannot show, which is the tiers
  // they moved between on the way to whatever they are on now.
  const past = detail.subscriptions.filter(
    (sub) => sub.status !== 'active' && sub.status !== 'trialing' && sub.status !== 'frozen',
  );
  const payingApps = detail.apps.filter((app) => app.status === 'paying').length;
  const share = detail.lifetimeGross - detail.lifetimeNet;

  return (
    <>
      <div className="customer-head">
        <div>
          <a className="back-link" href="#/customers">
            ← All customers
          </a>
          <h2 className="customer-title">
            {detail.name ?? detail.domain ?? detail.shopId} <StatusPill status={detail.status} />
          </h2>
          {detail.domain ? (
            <a
              className="customer-domain-link"
              href={`https://${detail.domain}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              {detail.domain}
            </a>
          ) : null}
        </div>
      </div>

      <div className="stat-row">
        <Stat
          label="Current MRR"
          value={formatValue(detail.mrr, 'money', detail.currency)}
          note={`${payingApps} paying app${payingApps === 1 ? '' : 's'}`}
        />
        <Stat
          label="Paid to date"
          value={formatValue(detail.lifetimeGross, 'money', detail.currency)}
          note={`${detail.paymentCount} charge(s)`}
        />
        <Stat
          label="Net of revenue share"
          value={formatValue(detail.lifetimeNet, 'money', detail.currency)}
          note={`${formatValue(share, 'money', detail.currency)} to Shopify`}
        />
        <Stat
          label="Customer since"
          value={detail.firstSeenAt ? formatFullDate(detail.firstSeenAt) : '—'}
          note={detail.lastEventAt ? `Last seen ${formatFullDate(detail.lastEventAt)}` : null}
        />
      </div>

      <AppsTable rows={detail.apps} currency={detail.currency} />

      {/* Kept below the per-app view because it answers a different question:
          Apps says where the relationship stands, this says how it got there —
          every tier they moved between, each as its own charge. */}
      <SubscriptionTable rows={past} currency={detail.currency} caption="Past subscriptions" />

      <div className="card full">
        {/* A merchant of any age has hundreds of events, and they are history
            rather than the answer to "how is this account doing" — so the card
            folds, and the count on the toggle says what is behind it. */}
        <button
          type="button"
          className="card-collapse"
          onClick={() => setTimelineOpen((current) => !current)}
          aria-expanded={timelineOpen}
        >
          <span className="card-label">Timeline</span>
          <span className="card-collapse-meta">
            {detail.events.length.toLocaleString()} event
            {detail.events.length === 1 ? '' : 's'}
            <svg
              className={timelineOpen ? 'chevron chevron-open' : 'chevron'}
              viewBox="0 0 20 20"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 8l4 4 4-4" fill="none" strokeWidth="1.7" />
            </svg>
          </span>
        </button>
        {!timelineOpen ? null : detail.events.length === 0 ? (
          <p className="footnote">No events recorded for this merchant.</p>
        ) : (
          <ol className="timeline">
            {detail.events.map((event) => (
              <EventRow key={event.eventId} event={event} currency={detail.currency} />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

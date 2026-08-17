import { formatCalendarDate, formatFullDate, formatValue } from '../format';
import type { Earnings, PayoutPage } from './api';
import { Stat } from './Overview';

/**
 * What has actually been sent.
 *
 * Payout processing is out of scope for PartnerDex — the money moves through
 * whatever channel it always did, and this system only records that it moved.
 * That used to be a bordered card of two paragraphs above the table; it is now
 * one line under it. The fact still has to be there — affiliates must not wait
 * for a "request payout" button that will never exist — but it is a thing read
 * once, and it was sitting on top of the thing read every month.
 *
 * The endpoint behind this page arrived after the page did, so a 404 is a state
 * this view renders rather than an error it throws — and it is kept distinct
 * from "you have never been paid", which is a different sentence for a different
 * reader.
 */

const money = (value: number, currency: string): string =>
  formatValue(value, 'money', currency || 'USD');

/** Payout statuses come from an external system; render the word, colour a guess. */
function tone(status: string): string {
  const value = (status || '').toLowerCase();
  if (value.includes('paid') || value.includes('complete') || value.includes('sent'))
    return 'paying';
  if (value.includes('fail') || value.includes('cancel') || value.includes('reject'))
    return 'churned';
  return 'trialing';
}

/**
 * A payout date, read as whichever kind of date it is.
 *
 * A payout period is a calendar range — "June" — with no instant behind it, so
 * `2026-06-01` pushed through the browser's timezone renders as 31 May for every
 * reader west of UTC and the statement covers the wrong month. A `paidAt` is a
 * real instant and belongs to whatever day it fell on for the reader. The two
 * need opposite treatment, and the shape of the string is what tells them apart.
 */
function day(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatCalendarDate(value) : formatFullDate(value);
}

function period(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `${day(start)} – ${day(end)}`;
  if (end) return `to ${day(end)}`;
  if (start) return `from ${day(start)}`;
  return '—';
}

export function Payouts({ page, earnings }: { page: PayoutPage; earnings: Earnings }) {
  const currency = earnings.currency;
  const settled = page.payouts.filter((payout) => payout.paidAt).length;
  const lastPaid = page.payouts.reduce<string | null>((latest, payout) => {
    if (!payout.paidAt) return latest;
    return !latest || payout.paidAt > latest ? payout.paidAt : latest;
  }, null);

  return (
    <section className="portal-section">
      <div className="portal-stats">
        <Stat label="Outstanding" value={money(earnings.unpaid, currency)} />
        <Stat label="Already paid" value={money(earnings.paid, currency)} />
        <Stat label="Earned all time" value={money(earnings.lifetime, currency)} />
        <Stat
          label="Payments"
          value={formatValue(page.unavailable ? 0 : page.total, 'count', null)}
          note={lastPaid ? `Last ${day(lastPaid)}` : settled === 0 ? 'None sent yet' : undefined}
        />
      </div>

      {page.unavailable ? (
        <p className="portal-hint portal-note">
          Payout history is not available here yet. The balances above are up to date.
        </p>
      ) : page.payouts.length === 0 ? (
        <p className="portal-hint portal-note">
          {earnings.lifetime > 0
            ? 'No payment recorded yet. Payments appear here once they have been sent.'
            : 'Nothing paid out yet, because nothing has been earned yet.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Program</th>
                <th>Amount</th>
                <th>Paid</th>
                <th>Method</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {page.payouts.map((payout) => (
                <tr key={payout.id}>
                  <td data-label="Period">
                    {period(payout.periodStart, payout.periodEnd)}
                    {payout.number ? <span className="row-hint">#{payout.number}</span> : null}
                  </td>
                  <td data-label="Program">{payout.programName || '—'}</td>
                  <td data-label="Amount">{money(payout.amount, currency)}</td>
                  <td data-label="Paid">
                    {payout.paidAt ? day(payout.paidAt) : 'Not yet'}
                    {/* Shown only when it differs from the amount, so a partial
                        payment is visible and a normal one is not noise. */}
                    {typeof payout.amountPaid === 'number' && payout.amountPaid !== payout.amount ? (
                      <span className="row-hint">{money(payout.amountPaid, currency)} sent</span>
                    ) : null}
                  </td>
                  <td data-label="Method">{payout.paymentMethod || '—'}</td>
                  <td data-label="Status">
                    <span className={`pill pill-${tone(payout.status)}`}>
                      {payout.status || 'Unknown'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page.hasNextPage ? (
        <p className="footnote">
          Most recent {formatValue(page.payouts.length, 'count', null)} of{' '}
          {formatValue(page.total, 'count', null)}.
        </p>
      ) : null}

      {/* The two facts the removed card existed to carry, at the size they are
          worth: payments are not made from here, and nothing on this page can
          change one. */}
      <p className="footnote">
        Payments are made outside this portal — this page is the record. If one looks wrong or has
        not arrived, reply to the email it came from.
      </p>
    </section>
  );
}

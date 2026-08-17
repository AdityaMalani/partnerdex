import { useMemo, useState } from 'react';
import { formatFullDate, formatValue } from '../format';
import type { Referral } from './api';
import { Stat } from './Overview';

/**
 * Who this affiliate referred.
 *
 * The columns are the whole design decision, so they are written down: merchant
 * name, program, the date, and whether the referral is still credited. That is
 * what an affiliate has a legitimate interest in — they introduced these people
 * and are entitled to know the introduction was recorded.
 *
 * What is deliberately **not** here:
 *
 * - No email, no myshopify domain, no contact detail of any kind. The merchant
 *   did not agree to be listed to a third party beyond the fact of the referral.
 * - **No money, per row.** This is the less obvious one. Showing the commission
 *   earned on a merchant hands over that merchant's subscription revenue for
 *   free: the commission rate is published on the programs page, so
 *   `gross = commission / rate` is one division away. `basis_amount` — the
 *   merchant's gross — is excluded from the API's SELECT for exactly this
 *   reason, and rendering the commission per merchant would have reconstructed
 *   it on the client. The affiliate's own totals are on the overview, and what
 *   was actually paid is on the payouts page; neither is attributable to a
 *   single store.
 *
 * The response still carries an `earned` field per referral. It is read and
 * dropped here, on purpose. The tiles at the top count referrals, never money,
 * for the same reason.
 */

/** Whether the referral is still earning, and why not when it is not. */
function state(referral: Referral): { label: string; tone: string; hint: string } {
  if (referral.unassignedAt) {
    return {
      label: 'Released',
      tone: 'churned',
      // Two causes, both stated, because the response carries the date a
      // referral was released and not the reason. Naming only the uninstall
      // rule would be a guess presented as a fact to somebody whose money it
      // is; naming both is true whichever one applied.
      hint: `Not credited since ${formatFullDate(referral.unassignedAt)}. A referral is released 30 days after the merchant uninstalls, or if their install is later credited elsewhere.`,
    };
  }
  if (referral.commissionCount > 0) {
    return {
      label: 'Earning',
      tone: 'paying',
      hint: `${formatValue(referral.commissionCount, 'count', null)} commission${referral.commissionCount === 1 ? '' : 's'} so far.`,
    };
  }
  return {
    label: 'No charges yet',
    tone: 'trialing',
    hint: 'Credited to you. You will earn once they start paying for a subscription.',
  };
}

export function Referrals({ referrals }: { referrals: Referral[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return referrals;
    return referrals.filter((referral) => referral.shop.toLowerCase().includes(needle));
  }, [referrals, query]);

  const live = referrals.filter((referral) => !referral.unassignedAt);
  const earning = live.filter((referral) => referral.commissionCount > 0).length;

  return (
    <section className="portal-section">
      {/* The counts lead even when they are all zero, which is the common case:
          most of the list has never referred anybody, and a row of zeroes is a
          truthful starting point rather than an error. */}
      <div className="portal-stats">
        <Stat label="Referred" value={formatValue(referrals.length, 'count', null)} />
        <Stat label="Still credited" value={formatValue(live.length, 'count', null)} />
        <Stat label="Earning" value={formatValue(earning, 'count', null)} />
        <Stat
          label="Released"
          value={formatValue(referrals.length - live.length, 'count', null)}
        />
      </div>

      {referrals.length === 0 ? (
        <p className="portal-hint portal-note">
          No installs through your link yet. They appear here within a day — the install has to
          follow your link, so sharing the App Store listing directly is not credited to you.
        </p>
      ) : (
        <>
          {referrals.length > 10 ? (
            <div className="control control-search">
              <label htmlFor="referral-search">Find a merchant</label>
              <input
                id="referral-search"
                type="search"
                value={query}
                placeholder="Search by name"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Program</th>
                  <th>Referred</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((referral) => {
                  const current = state(referral);
                  return (
                    <tr key={referral.referralId}>
                      {/* Merchant names come from Shopify and are not ours. They
                          go through React as text — never
                          `dangerouslySetInnerHTML`, never into an href. */}
                      <td data-label="Merchant">{referral.shop}</td>
                      <td data-label="Program">{referral.program}</td>
                      <td data-label="Referred">{formatFullDate(referral.referredAt)}</td>
                      <td data-label="Status">
                        <span className={`pill pill-${current.tone}`} title={current.hint}>
                          {current.label}
                        </span>
                        <span className="row-hint">{current.hint}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 ? (
            <p className="portal-hint portal-note">No merchant matches “{query}”.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  assignAttribution,
  decideMembership,
  fetchAffiliate,
  fetchPayouts,
  mintSetPasswordLink,
  unassignAttribution,
  type AffiliateDetail as Detail,
  type Payout,
  type SetPasswordLink,
} from '../api';
import { formatDateTime, formatFullDate, formatValue } from '../format';
import {
  CopyButton,
  LoadState,
  MembershipPill,
  MerchantCell,
  MerchantState,
  PayoutPill,
  ReferralPill,
  SourcePill,
  Stat,
} from './AffiliateCommon';
import { invalidateReferralFeed, referralLink, sourceLabel } from './AffiliateData';

/**
 * One affiliate, end to end — and the only page in the dashboard where an
 * operator can move money.
 *
 * Three actions here have consequences that outlive the click, and each keeps
 * one line saying so where the button is. Everything else that used to explain
 * a card is gone: the card labels and the column headings say it.
 *
 *   - **Approving** an application also rewinds the app's attribution watermark.
 *   - **Assigning** a merchant displaces whoever held the referral before —
 *     softly; their earnings to date stand.
 *   - **Minting a link** hands out a live credential, and minting again
 *     invalidates the last one.
 *
 * Merchants appear by name and myshopify domain and nothing else. That is
 * enough to identify the store in a support thread and is where the identity
 * stops: no email, no tokens.
 */

const COMMISSION_PAGE = 50;

function MembershipRow({
  membership,
  onDecided,
}: {
  membership: Detail['memberships'][number];
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    decideMembership(membership.id, decision)
      .then(onDecided)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  const link = referralLink(membership.handle);

  return (
    <tr>
      <td data-label="Program">
        <span className="customer-name">{membership.programName}</span>
        <span className="cell-note">
          {membership.requiresApproval ? 'Approval required' : 'Open to join'}
        </span>
      </td>
      <td data-label="Handle">
        <code>{membership.handle}</code>
      </td>
      <td data-label="Status">
        <MembershipPill status={membership.status} />
        {error ? <span className="cell-note channel-status bad">{error}</span> : null}
      </td>
      <td className="num" data-label="Joined">
        {formatFullDate(membership.joinedAt)}
      </td>
      <td className="link-cell" data-label="Referral link">
        {/* The live code, in full. It is what a merchant typed or clicked, so
            it is shown rather than hidden behind a copy button alone. */}
        <span className="muted-cell">{link}</span>
        <CopyButton value={link} label="Copy link" />
      </td>
      <td data-label="Decision">
        {membership.status === 'pending' ? (
          <span className="channel-actions">
            <button type="button" onClick={() => decide('approve')} disabled={busy}>
              {busy ? 'Saving…' : 'Approve'}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => decide('reject')}
              disabled={busy}
            >
              Reject
            </button>
          </span>
        ) : membership.status === 'rejected' && membership.rejectedAt ? (
          <span className="muted-cell">Rejected {formatFullDate(membership.rejectedAt)}</span>
        ) : membership.approvedAt ? (
          <span className="muted-cell">Approved {formatFullDate(membership.approvedAt)}</span>
        ) : (
          <span className="muted-cell">—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Assign a merchant to this affiliate by hand.
 *
 * Not an escape hatch: GA4 attribution cannot see a merchant who clicked on a
 * phone and installed on a laptop, or one whose browser blocks analytics. The
 * form takes a myshopify domain because that is what a support thread contains,
 * and a merchant the sync has never seen is still assignable — the domain is
 * stored and the shop is attached when it arrives.
 */
function AssignForm({
  affiliateId,
  memberships,
  onAssigned,
}: {
  affiliateId: string;
  memberships: Detail['memberships'];
  onAssigned: () => void;
}) {
  const enrolled = memberships.filter((row) => row.status === 'enrolled');
  const [programId, setProgramId] = useState(enrolled[0]?.programId ?? '');
  const [domain, setDomain] = useState('');
  const [referredAt, setReferredAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  if (enrolled.length === 0) {
    return (
      <p className="empty-line">
        Not enrolled in any program, so there is no handle to assign against.
      </p>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    assignAttribution(affiliateId, {
      programId,
      myshopifyDomain: domain.trim(),
      // A date-only value is read as UTC midnight, which is what the ledger
      // stores; sending the bare date would be a different instant per reader.
      referredAt: referredAt ? new Date(`${referredAt}T00:00:00Z`).toISOString() : undefined,
    })
      .then((response) => {
        invalidateReferralFeed();
        setDomain('');
        setReferredAt('');
        setResult(
          response.attribution.replaced
            ? 'Assigned. It displaced a live referral held by someone else — their earnings to date stand.'
            : 'Assigned, and commissions recomputed.',
        );
        onAssigned();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="field-row">
        <div className="control">
          <label htmlFor="assign-program">Program</label>
          <select
            id="assign-program"
            value={programId}
            onChange={(event) => setProgramId(event.target.value)}
          >
            {enrolled.map((row) => (
              <option key={row.programId} value={row.programId}>
                {row.programName}
              </option>
            ))}
          </select>
        </div>

        <div className="control control-grow">
          <label htmlFor="assign-domain">Merchant</label>
          <input
            id="assign-domain"
            type="text"
            placeholder="store.myshopify.com"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            autoComplete="off"
            required
          />
        </div>

        <div className="control control-narrow">
          <label htmlFor="assign-date">Referred on</label>
          <input
            id="assign-date"
            type="date"
            value={referredAt}
            onChange={(event) => setReferredAt(event.target.value)}
          />
        </div>

        <div className="channel-actions">
          <button type="submit" disabled={busy || !domain.trim()}>
            {busy ? 'Assigning…' : 'Assign merchant'}
          </button>
        </div>
      </div>

      {/* The date is the only field whose default costs money, so it keeps its
          line. Blank dates the referral now; a backdated one picks up every
          charge since. */}
      <p className="field-hint">Blank dates it now. Backdating earns on every charge since.</p>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {result ? <p className="channel-status good">{result}</p> : null}
    </form>
  );
}

/** The onboarding link. Live credential, shown once, never stored. */
function SetPasswordLinkAction({ affiliateId }: { affiliateId: string }) {
  const [link, setLink] = useState<SetPasswordLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = () => {
    setBusy(true);
    setError(null);
    mintSetPasswordLink(affiliateId)
      .then((response) => setLink(response.link))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="affiliate-link-action">
      <span className="channel-actions">
        <button type="button" onClick={mint} disabled={busy}>
          {busy ? 'Minting…' : link ? 'Mint a new link' : 'Mint portal link'}
        </button>
      </span>

      {error ? <p className="channel-status bad">{error}</p> : null}

      {/* A live credential, so the warning stays — but as one line. One click
          signs in as this affiliate; that is why the address is named. */}
      {link ? (
        <div className="banner banner-attention">
          <div>
            <strong>Signs in as this affiliate. Send to {link.email} only.</strong>
            <p>Expires {formatDateTime(link.expiresAt)}. Minting another invalidates it.</p>
            <p className="channel-hint">{link.url}</p>
          </div>
          <CopyButton value={link.url} label="Copy link" title="Copy the set-password link" />
        </div>
      ) : null}
    </div>
  );
}

function ReferralsCard({
  detail,
  onChanged,
}: {
  detail: Detail;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unassign = (id: string) => {
    setBusy(id);
    setError(null);
    unassignAttribution(id)
      .then(() => {
        invalidateReferralFeed();
        onChanged();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(null));
  };

  return (
    <section className="card full">
      <div className="card-label">Referrals</div>

      {error ? <p className="channel-status bad">{error}</p> : null}

      {detail.referrals.length === 0 ? (
        <p className="empty-line">No merchant credited to this affiliate yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="customer-table affiliate-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Merchant state</th>
                <th>Program</th>
                <th className="num">Referred</th>
                <th>Source</th>
                <th>Status</th>
                <th className="num">Commissions</th>
                <th className="num">Earned</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.referrals.map((row) => (
                <tr key={row.id}>
                  {/* The same two cells as the referral feed and the claim
                      queue, from the same components — one merchant reads the
                      same way wherever the operator meets it. */}
                  <td data-label="Merchant">
                    <MerchantCell
                      merchant={row.merchant}
                      fallbackDomain={row.myshopifyDomain}
                      fallbackName={row.shopName}
                    />
                  </td>
                  <td data-label="Merchant state">
                    <MerchantState merchant={row.merchant} />
                  </td>
                  <td data-label="Program">{row.programName}</td>
                  <td className="num" data-label="Referred">
                    {formatFullDate(row.referredAt)}
                  </td>
                  <td data-label="Source">
                    <SourcePill source={row.source} label={sourceLabel(row.source)} />
                  </td>
                  <td data-label="Status">
                    <ReferralPill unassignedAt={row.unassignedAt} />
                    {row.unassignedAt ? (
                      <span className="cell-note">{formatFullDate(row.unassignedAt)}</span>
                    ) : null}
                  </td>
                  <td className="num" data-label="Commissions">
                    {row.commissions}
                  </td>
                  <td className="num" data-label="Earned">
                    {formatValue(row.earned, 'money', 'USD')}
                  </td>
                  <td>
                    {row.unassignedAt ? null : (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => unassign(row.id)}
                        disabled={busy !== null}
                      >
                        {busy === row.id ? 'Unassigning…' : 'Unassign'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* What the Unassign button does not show: it is soft. */}
      <p className="footnote">
        Unassigning stops the referral earning from now. Commission already booked stays payable.
      </p>
    </section>
  );
}

function CommissionsCard({ detail }: { detail: Detail }) {
  const [page, setPage] = useState(0);
  const rows = detail.commissions;
  const shown = rows.slice(page * COMMISSION_PAGE, (page + 1) * COMMISSION_PAGE);
  const lastPage = Math.max(Math.ceil(rows.length / COMMISSION_PAGE) - 1, 0);

  return (
    <section className="card full">
      {/* "Basis" is the gross the rate was applied to, stored as of the
          computation so a statement still explains itself after terms change.
          That belongs in this comment, not over the table. */}
      <div className="card-label">Commission history</div>

      {rows.length === 0 ? (
        <p className="empty-line">Nothing earned yet.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="customer-table affiliate-table">
              <thead>
                <tr>
                  <th className="num">Earned</th>
                  <th>Merchant</th>
                  <th className="num">Basis</th>
                  <th className="num">Commission</th>
                  <th>Status</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id} className={row.cancelledAt ? 'muted-cell' : undefined}>
                    <td className="num" data-label="Earned">
                      {formatFullDate(row.earnedAt)}
                    </td>
                    <td data-label="Merchant">
                      {row.myshopifyDomain || <span className="muted-cell">—</span>}
                    </td>
                    <td className="num" data-label="Basis">
                      {row.basisAmount === null
                        ? '—'
                        : formatValue(row.basisAmount, 'money', row.currency)}
                    </td>
                    <td className="num" data-label="Commission">
                      {formatValue(row.amount, 'money', row.currency)}
                    </td>
                    <td data-label="Status">
                      {row.cancelledAt ? (
                        <span className="pill pill-churned">Cancelled</span>
                      ) : row.paidAt ? (
                        <span className="pill pill-paying">Paid</span>
                      ) : (
                        <span className="pill">Owed</span>
                      )}
                      {row.paidAt ? (
                        <span className="cell-note">{formatFullDate(row.paidAt)}</span>
                      ) : null}
                    </td>
                    <td className="muted-cell" data-label="Reference">
                      {row.paymentReference ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > COMMISSION_PAGE ? (
            <div className="pager">
              <button type="button" onClick={() => setPage((n) => n - 1)} disabled={page === 0}>
                Previous
              </button>
              <span>
                {page * COMMISSION_PAGE + 1}–{Math.min((page + 1) * COMMISSION_PAGE, rows.length)}{' '}
                of {rows.length.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPage((n) => n + 1)}
                disabled={page >= lastPage}
              >
                Next
              </button>
            </div>
          ) : null}

          {/* The endpoint stops at 500. Saying so is the difference between a
              truncated statement and one that looks complete and is not. */}
          {rows.length >= 500 ? (
            <p className="footnote">
              Most recent 500 only. Older rows are on the ledger and in the totals above.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function PayoutsCard({ affiliateId }: { affiliateId: string }) {
  const [payouts, setPayouts] = useState<Payout[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPayouts({ affiliateId, limit: 100 })
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setAvailable(false);
          setPayouts([]);
          return;
        }
        setPayouts(result.payouts);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [affiliateId]);

  return (
    <section className="card full">
      <div className="card-label">Payouts</div>

      {error ? <p className="channel-status bad">{error}</p> : null}

      {!available ? (
        <p className="empty-line">Payouts are not deployed on this server.</p>
      ) : payouts === null ? (
        <div className="skeleton">Loading payouts…</div>
      ) : payouts.length === 0 ? (
        <p className="empty-line">No payout recorded.</p>
      ) : (
        <div className="table-wrap">
          <table className="customer-table affiliate-table">
            <thead>
              <tr>
                <th>Payout</th>
                <th>Program</th>
                <th className="num">Period</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th className="num">Paid</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((row) => (
                <tr key={row.id}>
                  <td data-label="Payout">
                    <a className="customer-link" href={`#/payouts/${row.id}`}>
                      <span className="customer-name">#{row.number ?? row.id}</span>
                    </a>
                  </td>
                  <td data-label="Program">{row.programName ?? '—'}</td>
                  <td className="num" data-label="Period">
                    {row.periodStart && row.periodEnd
                      ? `${formatFullDate(row.periodStart)} – ${formatFullDate(row.periodEnd)}`
                      : '—'}
                  </td>
                  <td data-label="Status">
                    <PayoutPill status={row.status} />
                  </td>
                  <td className="num" data-label="Amount">
                    {formatValue(row.amount, 'money', 'USD')}
                  </td>
                  <td className="num" data-label="Paid">
                    {row.paidAt ? formatFullDate(row.paidAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AffiliateDetail({ affiliateId }: { affiliateId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchAffiliate(affiliateId)
      .then((result) => {
        setDetail(result);
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, [affiliateId]);

  useEffect(load, [load]);

  const liveReferrals = useMemo(
    () => detail?.referrals.filter((row) => !row.unassignedAt).length ?? 0,
    [detail],
  );

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load this affiliate</h2>
        <p>{error}</p>
        <p>
          <a className="back-link" href="#/affiliates">
            ← All affiliates
          </a>
        </p>
      </div>
    );
  }

  if (!detail) return <div className="skeleton">{loading ? 'Loading affiliate…' : ''}</div>;

  const { affiliate } = detail;
  const currency = detail.commissions[0]?.currency ?? 'USD';

  return (
    <>
      <header className="customer-head">
        <a className="back-link" href="#/affiliates">
          ← All affiliates
        </a>
        <h2 className="customer-title">
          {affiliate.name || affiliate.email}
          <span className={`pill ${affiliate.status === 'active' ? 'pill-paying' : 'pill-gone'}`}>
            {affiliate.status === 'active' ? 'Active' : 'Disabled'}
          </span>
          {affiliate.payoutHold ? <span className="pill pill-churned">Payout hold</span> : null}
        </h2>
        <p className="cadence">
          {affiliate.email}
          {affiliate.paypalEmail && affiliate.paypalEmail !== affiliate.email
            ? ` · paid via ${affiliate.paypalEmail}`
            : ''}{' '}
          · joined {formatFullDate(affiliate.createdAt)} · {affiliate.source}
        </p>
      </header>

      <div className="stat-row">
        <Stat
          label="Lifetime earned"
          value={formatValue(affiliate.earned, 'money', currency)}
          note={`${detail.commissions.length.toLocaleString()} commissions`}
        />
        <Stat label="Paid" value={formatValue(affiliate.paid, 'money', currency)} />
        <Stat
          label="Outstanding"
          value={formatValue(affiliate.outstanding, 'money', currency)}
          note={affiliate.outstanding < 0 ? 'Paid more than the ledger says they earned' : null}
        />
        <Stat
          label="Referrals"
          value={liveReferrals.toLocaleString()}
          note={
            detail.referrals.length > liveReferrals
              ? `${detail.referrals.length - liveReferrals} unassigned`
              : null
          }
        />
      </div>

      <section className="card full">
        <div className="card-label">Memberships</div>

        <div className="table-wrap">
          <table className="customer-table affiliate-table">
            <thead>
              <tr>
                <th>Program</th>
                <th>Handle</th>
                <th>Status</th>
                <th className="num">Joined</th>
                <th>Referral link</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {detail.memberships.map((membership) => (
                <MembershipRow key={membership.id} membership={membership} onDecided={load} />
              ))}
            </tbody>
          </table>
        </div>

        <SetPasswordLinkAction affiliateId={affiliate.id} />
      </section>

      <ReferralsCard detail={detail} onChanged={load} />

      <section className="card full">
        <div className="card-label">Assign a merchant</div>
        <AssignForm
          affiliateId={affiliate.id}
          memberships={detail.memberships}
          onAssigned={load}
        />
      </section>

      <CommissionsCard detail={detail} />

      <PayoutsCard affiliateId={affiliate.id} />
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAffiliatePrograms,
  fetchPayout,
  fetchPayouts,
  type AffiliateProgram,
  type Payout,
  type PayoutDetailResult,
} from '../api';
import { formatFullDate, formatValue } from '../format';
import { useResetOnChange } from '../hooks';
import { LoadState, MerchantCell, MerchantState, PayoutPill, Stat } from './AffiliateCommon';

/**
 * What has actually been sent.
 *
 * Payout processing happens outside this system — these are records of
 * payments, not instructions to make them — which is why nothing on this page
 * is an action. Its job is reconciliation: a payout says an amount left the
 * building for a period, and clicking it shows the commissions that amount was
 * supposed to settle.
 *
 * The endpoint may not exist on an older server, so every read here answers
 * null on a 404 and the page says so in a line rather than showing an error the
 * reader cannot act on.
 */

const PAGE_SIZE = 50;

const STATUSES = [
  { value: 'all', label: 'Any status' },
  { value: 'paid', label: 'Paid' },
  { value: 'pending', label: 'Pending' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
];

/** The one line this page needs when the route is not deployed. */
function NotDeployed() {
  return (
    <p className="empty-line">
      <code>/api/affiliates/payouts</code> is not deployed on this server. What each affiliate is
      owed is unaffected — it comes from the commission ledger.
    </p>
  );
}

/**
 * How the money was sent, as a person would write it.
 *
 * The column carries whatever the source platform stored — `paypal` — and a
 * lower-case machine token set at 20px beside three figures reads as a bug.
 * Only the one value is spelled properly, because it is the only one the
 * migrated data contains; anything else keeps its own name with a capital.
 */
function methodLabel(method: string | null | undefined): string {
  if (!method) return '—';
  if (method.toLowerCase() === 'paypal') return 'PayPal';
  return method.charAt(0).toUpperCase() + method.slice(1);
}

function period(payout: Payout): string {
  if (!payout.periodStart && !payout.periodEnd) return '—';
  if (payout.periodStart && payout.periodEnd) {
    return `${formatFullDate(payout.periodStart)} – ${formatFullDate(payout.periodEnd)}`;
  }
  return formatFullDate((payout.periodStart ?? payout.periodEnd)!);
}

export function AffiliatePayouts() {
  const [payouts, setPayouts] = useState<Payout[] | null>(null);
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [programs, setPrograms] = useState<AffiliateProgram[]>([]);
  const [programId, setProgramId] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);

  // A new filter starts at the beginning, and during render rather than in an
  // effect so the fetch below goes out once — see `useResetOnChange`.
  useResetOnChange(`${programId} ${status}`, () => setPage(0));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPayouts({ programId, status, page: page + 1, limit: PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        if (result === null) {
          setAvailable(false);
          setPayouts([]);
          return;
        }
        setPayouts(result.payouts);
        setTotal(result.total ?? result.payouts.length);
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
  }, [programId, status, page]);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliatePrograms()
      .then((result) => {
        if (!cancelled) setPrograms(result.programs);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    const rows = payouts ?? [];
    const settled = rows.map((row) => row.paidAt).filter((at): at is string => Boolean(at));
    return {
      amount: rows.reduce((sum, row) => sum + (row.amount ?? 0), 0),
      paid: rows.filter((row) => row.status === 'paid').length,
      latest: settled.length === 0 ? null : settled.sort().at(-1)!,
    };
  }, [payouts]);

  if (!available) return <NotDeployed />;

  return (
    <>
      <div className="stat-row">
        <Stat
          label="Payouts"
          value={loading && payouts === null ? '…' : total.toLocaleString()}
          note={programId || status !== 'all' ? 'Matching the filters' : null}
        />
        <Stat
          label="Settled"
          value={payouts ? totals.paid.toLocaleString() : '—'}
          note="On this page"
        />
        <Stat
          label="Amount"
          value={payouts ? formatValue(totals.amount, 'money', 'USD') : '—'}
          note="On this page"
        />
        {/* Payment happens outside this system, so the most recent one is the
            answer to "are these records current?" — the question a reader
            actually has about a table they cannot act on. */}
        <Stat
          label="Last settled"
          value={totals.latest ? formatFullDate(totals.latest) : '—'}
        />
      </div>

      <div className="controls">
        <div className="control">
          <label htmlFor="payout-program">Program</label>
          <select
            id="payout-program"
            value={programId}
            onChange={(event) => setProgramId(event.target.value)}
          >
            <option value="">All programs</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </select>
        </div>

        <div className="control">
          <label htmlFor="payout-status">Status</label>
          <select
            id="payout-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            {STATUSES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <LoadState
        loading={loading}
        error={error}
        empty={(payouts?.length ?? 0) === 0}
        loadingLabel="Loading payouts…"
        errorTitle="Could not load payouts"
        emptyMessage="No payouts on record. They are recorded here after a payment is made."
      >
        <div className="card full">
          <div className="table-wrap">
            <table className="customer-table affiliate-table">
              <thead>
                <tr>
                  <th>Payout</th>
                  <th>Affiliate</th>
                  <th>Program</th>
                  <th className="num">Period</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {(payouts ?? []).map((row) => (
                  <tr key={row.id}>
                    <td data-label="Payout">
                      <a className="customer-link" href={`#/payouts/${row.id}`}>
                        <span className="customer-name">#{row.number ?? row.id}</span>
                        <span className="customer-domain">
                          {row.commissionCount === null || row.commissionCount === undefined
                            ? 'commissions unknown'
                            : `${row.commissionCount} commission${row.commissionCount === 1 ? '' : 's'}`}
                        </span>
                      </a>
                    </td>
                    <td data-label="Affiliate">
                      <a className="customer-link" href={`#/affiliates/${row.affiliateId}`}>
                        <span className="customer-name">
                          {row.affiliateName ?? row.affiliateId}
                        </span>
                        <span className="customer-domain">{row.affiliateEmail ?? ''}</span>
                      </a>
                    </td>
                    <td data-label="Program">{row.programName ?? '—'}</td>
                    <td className="num" data-label="Period">
                      {period(row)}
                    </td>
                    <td data-label="Status">
                      <PayoutPill status={row.status} />
                    </td>
                    <td className="num" data-label="Amount">
                      {formatValue(row.amount, 'money', 'USD')}
                      {row.amountPaid !== null &&
                      row.amountPaid !== undefined &&
                      row.amountPaid !== row.amount ? (
                        <span className="cell-note">
                          {formatValue(row.amountPaid, 'money', 'USD')} paid
                        </span>
                      ) : null}
                    </td>
                    <td className="num" data-label="Paid">
                      {row.paidAt ? formatFullDate(row.paidAt) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE ? (
            <div className="pager">
              <button type="button" onClick={() => setPage((n) => n - 1)} disabled={page === 0}>
                Previous
              </button>
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{' '}
                {total.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPage((n) => n + 1)}
                disabled={(page + 1) * PAGE_SIZE >= total}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </LoadState>
    </>
  );
}

/** One payout, and the commissions it settled. */
export function AffiliatePayoutDetail({ payoutId }: { payoutId: string }) {
  const [result, setResult] = useState<PayoutDetailResult | null>(null);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPayout(payoutId)
      .then((response) => {
        if (cancelled) return;
        if (response === null) {
          setAvailable(false);
          return;
        }
        setResult(response);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [payoutId]);

  if (!available) return <NotDeployed />;

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load this payout</h2>
        <p>{error}</p>
        <p>
          <a className="back-link" href="#/payouts">
            ← All payouts
          </a>
        </p>
      </div>
    );
  }

  if (!result) return <div className="skeleton">Loading payout…</div>;

  const { payout, commissions } = result;
  const currency = commissions[0]?.currency ?? 'USD';

  /*
   * A column nothing fills is not shown.
   *
   * On an imported payout every row carries "—" under Basis and under
   * Reference, so two of seven columns hold nothing while the table is already
   * scrolling sideways. They are real columns on a computed payout, so they are
   * dropped per payout rather than deleted — and their absence is stated in a
   * line under the table instead of drawn as a wall of dashes.
   */
  const hasBasis = commissions.some((row) => row.basisAmount !== null && row.basisAmount !== undefined);
  const hasReference = commissions.some((row) => Boolean(row.paymentReference));

  return (
    <>
      <header className="customer-head">
        <a className="back-link" href="#/payouts">
          ← All payouts
        </a>
        <h2 className="customer-title">
          Payout #{payout.number ?? payout.id}
          <PayoutPill status={payout.status} />
        </h2>
        <p className="cadence">
          <a className="customer-domain-link" href={`#/affiliates/${payout.affiliateId}`}>
            {payout.affiliateName ?? payout.affiliateId}
          </a>
          {payout.programName ? ` · ${payout.programName}` : ''} · {period(payout)}
        </p>
      </header>

      <div className="stat-row">
        <Stat label="Amount" value={formatValue(payout.amount, 'money', currency)} />
        <Stat
          label="Paid"
          value={
            payout.amountPaid === null || payout.amountPaid === undefined
              ? '—'
              : formatValue(payout.amountPaid, 'money', currency)
          }
          note={payout.paidAt ? formatFullDate(payout.paidAt) : 'Not yet settled'}
        />
        <Stat label="Method" value={methodLabel(payout.paymentMethod)} />
        <Stat
          label="Commissions settled"
          value={(payout.commissionCount ?? commissions.length).toLocaleString()}
          note={
            payout.commissionCount !== null &&
            payout.commissionCount !== undefined &&
            payout.commissionCount !== commissions.length
              ? `${commissions.length} returned with this payout`
              : null
          }
        />
      </div>

      {/* No card heading: the tiles above name the payout, and the columns
          below name themselves. "What this payout settled" over a table of
          commissions was the third statement of the same thing. */}
      <section className="card full">
        {commissions.length === 0 ? (
          <p className="empty-line">
            No commission rows linked. An imported payout may carry only its total.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="customer-table affiliate-table">
              <thead>
                <tr>
                  <th className="num">Earned</th>
                  <th>Merchant</th>
                  <th>Merchant state</th>
                  {hasBasis ? <th className="num">Basis</th> : null}
                  <th className="num">Commission</th>
                  {hasReference ? <th>Reference</th> : null}
                </tr>
              </thead>
              <tbody>
                {commissions.map((row) => (
                  <tr key={row.id}>
                    <td className="num" data-label="Earned">
                      {formatFullDate(row.earnedAt)}
                    </td>
                    {/* Named the same way as on the referral feed. Reconciling a
                        payment means knowing which store each line is, and a
                        bare domain in a column of money was not enough. */}
                    <td data-label="Merchant">
                      <MerchantCell
                        merchant={row.merchant}
                        fallbackDomain={row.myshopifyDomain}
                        fallbackName={row.shop}
                      />
                    </td>
                    <td data-label="Merchant state">
                      <MerchantState merchant={row.merchant} />
                    </td>
                    {hasBasis ? (
                      <td className="num" data-label="Basis">
                        {row.basisAmount === null || row.basisAmount === undefined
                          ? '—'
                          : formatValue(row.basisAmount, 'money', row.currency)}
                      </td>
                    ) : null}
                    <td className="num" data-label="Commission">
                      {formatValue(row.amount, 'money', row.currency)}
                    </td>
                    {hasReference ? (
                      <td className="muted-cell" data-label="Reference">
                        {row.paymentReference ?? '—'}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Said once under the table rather than drawn as a column of identical
            em dashes. Both are genuinely absent on imported rows — the basis
            was never exported, and the reference is this payout. */}
        {commissions.length > 0 && (!hasBasis || !hasReference) ? (
          <p className="footnote">
            Imported rows carry no{' '}
            {!hasBasis && !hasReference
              ? 'gross basis and no payment reference'
              : !hasBasis
                ? 'gross basis'
                : 'payment reference'}
            .
          </p>
        ) : null}
      </section>
    </>
  );
}

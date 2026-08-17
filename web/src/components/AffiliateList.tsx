import { useCallback, useEffect, useState } from 'react';
import {
  decideMembership,
  fetchAffiliates,
  fetchPendingMemberships,
  fetchReconciliation,
  type AffiliateSort,
  type AffiliateSummary,
  type PendingMembership,
  type Reconciliation,
} from '../api';
import { formatFullDate, formatValue } from '../format';
import { useDebounced, useResetOnChange } from '../hooks';
import { LoadState, MembershipPill, Stat } from './AffiliateCommon';
import { AffiliateInvite } from './AffiliateInvite';

/**
 * The affiliate population.
 *
 * Paged on the server exactly as the customer list is: search, sort and offset
 * all go over the wire and fifty rows come back.
 *
 * The approval queue sits on this page rather than on one of its own, because
 * it is a view of the same population: a queue you have to go looking for is a
 * queue that does not get worked. It is a segment of this list, one click away,
 * counted on a tile and on its own tab, and announced by a banner when there is
 * anything in it.
 */

const PAGE_SIZE = 50;

const SORTS: Array<{ value: AffiliateSort; label: string }> = [
  { value: 'outstanding', label: 'Most outstanding' },
  { value: 'earned', label: 'Most earned' },
  { value: 'paid', label: 'Most paid' },
  { value: 'referrals', label: 'Most referrals' },
  { value: 'name', label: 'Name' },
  { value: 'newest', label: 'Newest' },
];

/**
 * The approval queue.
 *
 * Both decisions are real. A rejection is recorded rather than deleted —
 * without the row the same applicant reappears as new next week and the
 * decision gets made again from nothing — so the button says "Reject" and means
 * it, and the row leaves the queue either way.
 */
function ApprovalQueue({
  memberships,
  loading,
  error,
  onDecided,
}: {
  memberships: PendingMembership[];
  loading: boolean;
  error: string | null;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const decide = (id: string, decision: 'approve' | 'reject') => {
    setBusy(id);
    setFailure(null);
    decideMembership(id, decision)
      .then(onDecided)
      .catch((cause: Error) => setFailure(cause.message))
      .finally(() => setBusy(null));
  };

  return (
    <LoadState
      loading={loading}
      error={error}
      empty={memberships.length === 0}
      loadingLabel="Loading the approval queue…"
      errorTitle="Could not load the approval queue"
      emptyMessage="Nothing waiting on a decision."
    >
      <div className="card full">
        {failure ? (
          <div className="notice error">
            <h2>That decision did not save</h2>
            <p>{failure}</p>
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="customer-table affiliate-table roomy">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Program</th>
                <th>Handle</th>
                <th className="num">Applied</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((row) => (
                <tr key={row.id}>
                  <td data-label="Applicant">
                    <a className="customer-link" href={`#/affiliates/${row.affiliateId}`}>
                      <span className="customer-name">{row.affiliateName}</span>
                      <span className="customer-domain">{row.affiliateEmail}</span>
                    </a>
                  </td>
                  <td data-label="Program">{row.programName}</td>
                  <td data-label="Handle">
                    <code>{row.handle}</code>
                  </td>
                  <td className="num" data-label="Applied">
                    {formatFullDate(row.joinedAt)}
                  </td>
                  <td data-label="Decision">
                    <span className="channel-actions">
                      <button
                        type="button"
                        onClick={() => decide(row.id, 'approve')}
                        disabled={busy !== null}
                      >
                        {busy === row.id ? 'Saving…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => decide(row.id, 'reject')}
                        disabled={busy !== null}
                      >
                        Reject
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* One consequence that is not visible from the button, so it stays. */}
        <p className="footnote">
          Approving rewinds the attribution watermark, so the next sync picks up clicks sent while
          they waited.
        </p>
      </div>
    </LoadState>
  );
}

export function AffiliateList() {
  const [tab, setTab] = useState<'all' | 'pending' | 'add'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<AffiliateSort>('outstanding');
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<AffiliateSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<PendingMembership[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const [totals, setTotals] = useState<Reconciliation['totals'] | null>(null);

  const debounced = useDebounced(search, 250);

  // A new search starts at the beginning, and during render rather than in an
  // effect so the fetch below goes out once — see `useResetOnChange`.
  useResetOnChange(`${debounced} ${sort}`, () => setPage(0));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAffiliates({ search: debounced, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => {
        if (cancelled) return;
        setRows(result.affiliates);
        setTotal(result.total);
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
  }, [debounced, sort, page]);

  const loadPending = useCallback(() => {
    setPendingLoading(true);
    fetchPendingMemberships()
      .then((result) => {
        setPending(result.memberships);
        setPendingError(null);
      })
      .catch((cause: Error) => setPendingError(cause.message))
      .finally(() => setPendingLoading(false));
  }, []);

  useEffect(loadPending, [loadPending]);

  // The money totals are the ledger's own position, not this page's slice of
  // it, so they do not move when the reader searches or turns a page.
  useEffect(() => {
    let cancelled = false;
    fetchReconciliation()
      .then((result) => {
        if (!cancelled) setTotals(result.totals);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /** A decision changes both the queue and the affiliate's own membership count. */
  const afterDecision = useCallback(() => {
    loadPending();
    fetchAffiliates({ search: debounced, sort, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((result) => {
        setRows(result.affiliates);
        setTotal(result.total);
      })
      .catch(() => undefined);
  }, [debounced, sort, page, loadPending]);

  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);

  return (
    <>
      <div className="stat-row">
        {/* Follows the search rather than staying fixed, and the note says so:
            a count that ignores the filter under it invites the reader to
            subtract two figures that do not describe the same set. */}
        <Stat
          label="Affiliates"
          value={loading && rows.length === 0 ? '…' : total.toLocaleString()}
          note={debounced ? `Matching “${debounced}”` : null}
        />
        {/* One of the two figures an operator opens this page to action. */}
        <Stat
          label="Awaiting approval"
          value={pendingLoading ? '…' : pending.length.toLocaleString()}
        />
        <Stat
          label="Lifetime earned"
          value={totals ? formatValue(totals.earned, 'money', totals.currencies[0] ?? 'USD') : '—'}
          note={totals ? `${totals.commissions.toLocaleString()} commissions` : null}
        />
        <Stat
          label="Outstanding"
          value={
            totals ? formatValue(totals.outstanding, 'money', totals.currencies[0] ?? 'USD') : '—'
          }
          note={totals ? `${totals.owed.toLocaleString()} owed` : null}
        />
      </div>

      {/* Only when there is something in it, and one line: a banner that is
          always on screen stops being read, and one that argues its case is
          read once and skipped after. The consequence it used to spell out is
          on the queue itself. */}
      {!pendingLoading && pending.length > 0 && tab !== 'pending' ? (
        <div className="banner banner-attention">
          <strong>
            {pending.length} application{pending.length === 1 ? '' : 's'} waiting — nobody in the
            queue is earning
          </strong>
          <button type="button" className="link-button" onClick={() => setTab('pending')}>
            Work the queue
          </button>
        </div>
      ) : null}

      <div className="funnel-views" role="tablist" aria-label="Affiliate view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={tab === 'all' ? 'active' : undefined}
          onClick={() => setTab('all')}
        >
          All affiliates
        </button>
        {/* A third tab rather than a button above the table: adding an
            affiliate is a different task from reading the list, and a form
            permanently open above a list is a form somebody submits by
            accident on their way to the search box. */}
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'add'}
          className={tab === 'add' ? 'active' : undefined}
          onClick={() => setTab('add')}
        >
          Add
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pending'}
          className={tab === 'pending' ? 'active' : undefined}
          onClick={() => setTab('pending')}
        >
          Pending approval{pendingLoading ? '' : ` (${pending.length})`}
        </button>
      </div>

      {tab === 'add' ? (
        <AffiliateInvite onCreated={afterDecision} />
      ) : tab === 'pending' ? (
        <ApprovalQueue
          memberships={pending}
          loading={pendingLoading}
          error={pendingError}
          onDecided={afterDecision}
        />
      ) : (
        <>
          <div className="controls">
            <div className="control control-search">
              <label htmlFor="affiliate-search">Find an affiliate</label>
              <input
                id="affiliate-search"
                type="search"
                placeholder="Name, email or handle"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="control">
              <label htmlFor="affiliate-sort">Order by</label>
              <select
                id="affiliate-sort"
                value={sort}
                onChange={(event) => setSort(event.target.value as AffiliateSort)}
              >
                {SORTS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            {/* The count that used to sit here is the first tile above. */}
          </div>

          <LoadState
            loading={loading}
            error={error}
            empty={rows.length === 0}
            loadingLabel="Loading affiliates…"
            errorTitle="Could not load affiliates"
            emptyMessage={
              debounced
                ? 'No affiliate matches that name, email or handle.'
                : 'No affiliates yet.'
            }
          >
            <div className="card full">
              <div className="table-wrap">
                <table className="customer-table affiliate-table">
                  <thead>
                    <tr>
                      <th>Affiliate</th>
                      <th>Handles</th>
                      <th className="num">Memberships</th>
                      <th className="num">Referrals</th>
                      <th className="num">Lifetime earned</th>
                      <th className="num">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td data-label="Affiliate">
                          <a className="customer-link" href={`#/affiliates/${row.id}`}>
                            <span className="customer-name">{row.name || row.email}</span>
                            <span className="customer-domain">{row.email}</span>
                          </a>
                        </td>
                        {/* Handles are codes, so they sit beside the name they
                            belong to rather than out in the money columns. */}
                        <td className="handle-cell" data-label="Handles">
                          {row.handles.length === 0 ? (
                            <span className="muted-cell">—</span>
                          ) : (
                            row.handles.map((handle) => <code key={handle}>{handle}</code>)
                          )}
                        </td>
                        <td className="num" data-label="Memberships">
                          {row.memberships}
                          {row.pendingMemberships > 0 ? (
                            <span className="cell-note">
                              <MembershipPill status="pending" />
                            </span>
                          ) : null}
                        </td>
                        <td className="num" data-label="Referrals">
                          {row.referrals || <span className="muted-cell">0</span>}
                        </td>
                        <td className="num" data-label="Lifetime earned">
                          {formatValue(row.earned, 'money', 'USD')}
                        </td>
                        <td className="num" data-label="Outstanding">
                          {formatValue(row.outstanding, 'money', 'USD')}
                          {row.payoutHold ? <span className="cell-note">On payout hold</span> : null}
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
                    disabled={page >= lastPage}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
          </LoadState>
        </>
      )}
    </>
  );
}

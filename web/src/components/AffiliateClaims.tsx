import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  decideClaim,
  fetchAffiliatePrograms,
  fetchClaims,
  type AffiliateProgram,
  type Claim,
} from '../api';
import { formatFullDate } from '../format';
import { useDebounced, useResetOnChange } from '../hooks';
import { LoadState, MerchantCell, MerchantState, SourcePill, Stat } from './AffiliateCommon';

/**
 * The claim queue: the decisions nobody has made yet.
 *
 * An attribution claim is an affiliate asserting that a merchant was theirs —
 * the manual half of attribution, the half the GA4 pipeline structurally cannot
 * see. The queue presents facts and stops.
 *
 * Three of the columns are the design:
 *
 * - **The merchant, with the domain under the name.** The domain is what
 *   everything joins on, and an operator checking a claim checks the domain.
 * - **Currently credited.** The single piece of context without which a
 *   decision is guesswork: approving a claim on a merchant somebody else holds
 *   *displaces* their referral — soft, so their earned commission stands, but
 *   they stop earning from that instant. Who holds it, since when, and by which
 *   source, before the button rather than after it.
 * - **The claimant's own note**, under the row.
 *
 * What it deliberately does not show: no score, no confidence, no risk flag, no
 * highlighted row meaning "look at this one". These rows are undecided because
 * a person is meant to read them, and a computed opinion printed beside a row
 * stops being a suggestion the moment somebody works a queue at speed.
 */

const PAGE_SIZE = 50;

const STATUS_PILL: Record<string, string> = {
  pending: 'pill-trialing',
  approved: 'pill-paying',
  rejected: 'pill-churned',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

function ClaimPill({ status }: { status: string }) {
  return (
    <span className={`pill ${STATUS_PILL[status] ?? ''}`.trim()}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/**
 * How the claimed merchant's current credit reads, in words.
 *
 * Three states, and the middle one is the interesting one: some claims name a
 * merchant already credited to the *same* affiliate who is claiming them. That
 * is not a duplicate to collapse and not a claim to auto-approve — it usually
 * means the referral arrived by another path after the claim was filed, and the
 * decision is about the paperwork rather than about who the merchant belongs
 * to. So it is stated and left alone.
 */
function credit(claim: Claim): { text: string; own: boolean } | null {
  if (!claim.attributedAffiliateId) return null;
  const own = claim.attributedAffiliateId === claim.affiliateId;
  const when = claim.attributedAt ? ` since ${formatFullDate(claim.attributedAt)}` : '';
  return {
    own,
    text: own
      ? `Already credited to this claimant${when}`
      : `Credited to ${claim.attributedAffiliateName ?? 'another affiliate'}${when}`,
  };
}

export function AffiliateClaims() {
  const [page, setPage] = useState<{ claims: Claim[]; total: number } | null>(null);
  const [programs, setPrograms] = useState<AffiliateProgram[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Default to the queue, because that is what this page is opened for. Every
  // other status is one select away.
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('pending');
  const [affiliateId, setAffiliateId] = useState('');
  const [programId, setProgramId] = useState('');
  const [pageNumber, setPageNumber] = useState(1);

  const debounced = useDebounced(search, 250);

  // A new filter or search starts at the beginning, and during render rather
  // than in an effect so `load` runs once — see `useResetOnChange`. It used to
  // sit in an effect *below* the fetch, which made the doubling certain rather
  // than merely likely.
  useResetOnChange(`${status} ${affiliateId} ${programId} ${debounced}`, () => setPageNumber(1));

  /**
   * Which query the table is currently showing. Bumped by every read, so a
   * response that has been superseded — by a filter change, or by a refresh
   * after a decision — is discarded instead of overwriting a newer one.
   */
  const generation = useRef(0);

  const load = useCallback(() => {
    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine;
    // Filtering server-side, unlike the referral feed: the imported claims are
    // few today but the endpoint already pages and filters, so there is no reason
    // to pull the lot into the browser and re-implement it here.
    return fetchClaims({
      status: status || undefined,
      affiliateId: affiliateId || undefined,
      programId: programId || undefined,
      search: debounced || undefined,
      page: pageNumber,
      limit: PAGE_SIZE,
    })
      .then((result) => {
        if (stale()) return;
        setPage({ claims: result.claims, total: result.total });
      })
      .catch((cause: Error) => {
        if (!stale()) setError(cause.message);
      });
  }, [status, affiliateId, programId, debounced, pageNumber]);

  useEffect(() => {
    // The guard has to reach the writes themselves, which is what the
    // generation above is for. It used to be a `cancelled` flag read in a
    // `.then` chained *after* the one that calls `setPage` — so a slow response
    // for one status could still land on top of a fast response for another and
    // overwrite the table the operator was reading.
    setError(null);
    void load();
  }, [load]);

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

  const claims = page?.claims ?? [];

  /** The affiliates that actually appear, so the picker has no dead options. */
  const affiliates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const claim of claims) seen.set(claim.affiliateId, claim.affiliateName || claim.affiliateEmail);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [claims]);

  const counts = useMemo(() => {
    let contested = 0;
    let held = 0;
    for (const claim of claims) {
      if (!claim.attributedAffiliateId) continue;
      if (claim.attributedAffiliateId === claim.affiliateId) held += 1;
      else contested += 1;
    }
    return { contested, held };
  }, [claims]);

  const decide = (claim: Claim, decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(claim.id);
    setNote(null);
    setError(null);
    decideClaim(claim.id, decision)
      .then((result) => {
        // The displacement is reported rather than left to be noticed: an
        // approval that took a merchant off somebody else is the consequence
        // most worth stating out loud, and it has already happened by now.
        setNote(
          decision === 'approve'
            ? result.claim.replaced
              ? `Approved. ${claim.merchant} moved to ${claim.affiliateName}; the previous referral was unassigned.`
              : `Approved. ${claim.merchant} is credited to ${claim.affiliateName}.`
            : `Rejected. Nothing was created, and ${claim.merchant} is unchanged.`,
        );
        return load();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(null));
  };

  const total = page?.total ?? 0;
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const filtering = Boolean(status || affiliateId || programId || debounced);

  return (
    <>
      <div className="stat-row three">
        {/* The queue depth leads, and says which queue it is: on a page whose
            filter defaults to Pending, a tile labelled "Claims" carrying the
            pending count is read as the size of the whole table. */}
        <Stat
          label={status === 'pending' ? 'Waiting on a decision' : 'Claims'}
          value={page ? total.toLocaleString() : '—'}
          note={status !== 'pending' && filtering ? 'Matching the filters' : null}
        />
        {/* Two counts of ledger state, not two verdicts. "Held by someone else"
            means the merchant is currently credited to somebody other than the
            claimant, which is where approving costs something. Both count the
            rows on this page, and the note says so once. */}
        <Stat
          label="Held by someone else"
          value={page ? counts.contested.toLocaleString() : '—'}
          note="On this page"
        />
        <Stat
          label="Already theirs"
          value={page ? counts.held.toLocaleString() : '—'}
          note="On this page"
        />
      </div>

      <div className="controls">
        <div className="control control-search">
          <label htmlFor="claim-search">Find a merchant</label>
          {/* Matches the store name, the domain, and the name the affiliate
              typed — which for a merchant the sync has never met is the only
              name on the screen. In SQL beside the paging, never over the page
              already fetched. */}
          <input
            id="claim-search"
            type="search"
            placeholder="Store name or myshopify domain"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control">
          <label htmlFor="claim-status">Status</label>
          <select id="claim-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="">Every status</option>
          </select>
        </div>

        <div className="control">
          <label htmlFor="claim-affiliate">Affiliate</label>
          <select
            id="claim-affiliate"
            value={affiliateId}
            onChange={(event) => setAffiliateId(event.target.value)}
            disabled={affiliates.length === 0}
          >
            <option value="">All affiliates</option>
            {affiliates.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="control">
          <label htmlFor="claim-program">Program</label>
          <select
            id="claim-program"
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
      </div>

      {note ? (
        <p className="footnote" role="status">
          {note}
        </p>
      ) : null}

      <LoadState
        loading={page === null}
        error={error}
        empty={claims.length === 0}
        loadingLabel="Loading claims…"
        errorTitle="Could not load claims"
        emptyMessage={
          filtering ? 'No claim matches those filters.' : 'No claims filed.'
        }
      >
        <div className="card full">
          <div className="table-wrap">
            <table className="customer-table affiliate-table roomy">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Merchant state</th>
                  <th>Claimed by</th>
                  <th>Program</th>
                  <th className="num">Filed</th>
                  <th>Currently credited</th>
                  <th>Status</th>
                  <th>Decide</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((claim) => {
                  const held = credit(claim);
                  return (
                    <Fragment key={claim.id}>
                    <tr>
                      {/* The same two cells as the referral feed and the payout
                          itemisation, from the same components. "Not synced
                          yet" is a gap in what we know, not a merchant who pays
                          nothing, and a decision to move money must not be made
                          as though it were the latter. */}
                      <td data-label="Merchant">
                        <MerchantCell
                          merchant={claim.merchantRecord}
                          fallbackDomain={claim.myshopifyDomain}
                          fallbackName={claim.merchant}
                        />
                      </td>
                      <td data-label="Merchant state">
                        <MerchantState merchant={claim.merchantRecord} />
                      </td>
                      <td data-label="Claimed by">
                        <a className="customer-link" href={`#/affiliates/${claim.affiliateId}`}>
                          <span className="customer-name">{claim.affiliateName}</span>
                          <span className="customer-domain">{claim.affiliateEmail}</span>
                        </a>
                      </td>
                      <td data-label="Program">{claim.programName}</td>
                      <td className="num" data-label="Filed">
                        {formatFullDate(claim.claimedAt)}
                      </td>
                      <td data-label="Currently credited">
                        {held ? (
                          <span className="customer-link">
                            <span className="customer-name">
                              {held.own ? 'This claimant' : held.text.replace(/ since .*/, '')}
                            </span>
                            <span className="customer-domain">
                              {claim.attributedAt
                                ? `Since ${formatFullDate(claim.attributedAt)}`
                                : 'Live referral'}
                            </span>
                          </span>
                        ) : (
                          <span className="customer-domain">Nobody</span>
                        )}
                        {claim.attributedSource ? (
                          <SourcePill
                            source={claim.attributedSource}
                            label={claim.attributedSource === 'ga4' ? 'GA4' : claim.attributedSource}
                          />
                        ) : null}
                      </td>
                      <td data-label="Status">
                        <ClaimPill status={claim.status} />
                        {claim.decidedAt ? (
                          <span className="customer-domain">
                            {formatFullDate(claim.decidedAt)}
                            {claim.decidedBy ? ` · ${claim.decidedBy}` : ''}
                          </span>
                        ) : null}
                      </td>
                      <td data-label="Decide">
                        {claim.status === 'pending' ? (
                          <span className="claim-actions">
                            <button
                              type="button"
                              className="primary"
                              disabled={busy !== null}
                              onClick={() => decide(claim, 'approve')}
                            >
                              {busy === claim.id ? '…' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => decide(claim, 'reject')}
                            >
                              Reject
                            </button>
                          </span>
                        ) : (
                          // Decided claims are not re-decidable here, and the
                          // server refuses it too. Reversing a decision is
                          // unassigning the referral and saying why, which is a
                          // different act with a different record.
                          <span className="customer-domain">Decided</span>
                        )}
                      </td>
                    </tr>
                    {/*
                      The claimant's own words, under their row rather than in a
                      column of their own.

                      As a column it was unworkable in both directions: given
                      the width to be read it pushed the two buttons this page
                      exists for off the right edge of a laptop, and squeezed
                      into what was left it made a single claim taller than a
                      screen. Underneath, it costs nothing on the many claims
                      that carry no note and the row above stays a scannable
                      line of facts. Clamped to one line with the rest on the
                      tooltip: this is the claimant's prose, not ours, and a
                      queue is scanned before any one row is read. Through React
                      as text.
                    */}
                    {claim.notes ? (
                      <tr className="claim-note-row">
                        <td className="claim-note" colSpan={8} data-label="Their note">
                          <span className="claim-note-body" title={claim.notes}>
                            {claim.notes}
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE ? (
            <div className="pager">
              <button
                type="button"
                onClick={() => setPageNumber((n) => n - 1)}
                disabled={pageNumber <= 1}
              >
                Previous
              </button>
              <span>
                {(pageNumber - 1) * PAGE_SIZE + 1}–
                {Math.min(pageNumber * PAGE_SIZE, total)} of {total.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPageNumber((n) => n + 1)}
                disabled={pageNumber >= lastPage}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </LoadState>

      {/* What approving actually does. One line, because it is the one
          consequence the two buttons do not show. */}
      <p className="footnote">
        Approving credits the merchant from the claim date and unassigns any other live referral on
        it; commission already earned stands. Rejecting creates nothing.
      </p>
    </>
  );
}

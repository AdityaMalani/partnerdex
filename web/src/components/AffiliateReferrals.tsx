import { useEffect, useState } from 'react';
import {
  fetchAffiliatePrograms,
  fetchAffiliates,
  fetchReferrals,
  type AffiliateProgram,
  type AffiliateSummary,
  type ReferralFeedResult,
} from '../api';
import { formatFullDate, formatValue } from '../format';
import { useDebounced, useResetOnChange } from '../hooks';
import { sourceLabel } from './AffiliateData';
import {
  LoadState,
  MerchantCell,
  MerchantState,
  ReferralPill,
  SourcePill,
  Stat,
} from './AffiliateCommon';

/**
 * Every referral, across every affiliate.
 *
 * The source column is the reason this page exists. Only `ga4` is automated — a
 * click on a referral link followed by an install. Everything a click-based
 * pipeline structurally cannot see (cross-device installs, analytics-blocked
 * merchants) arrives as `manual` or `imported`, and a figure that mixed the two
 * would make the automated pipeline look better or worse than it is.
 *
 * **Filtering, searching and paging all run on the server**, and so do the
 * figures above the table: they are computed over the whole filtered set in
 * SQL, so "commission earned" is not quietly the sum of one page.
 */

const PAGE_SIZE = 50;

export function AffiliateReferrals() {
  const [result, setResult] = useState<ReferralFeedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [programs, setPrograms] = useState<AffiliateProgram[]>([]);
  const [affiliates, setAffiliates] = useState<AffiliateSummary[]>([]);

  const [search, setSearch] = useState('');
  const [programId, setProgramId] = useState('');
  const [affiliateId, setAffiliateId] = useState('');
  const [source, setSource] = useState('');
  const [standing, setStanding] = useState('all');
  const [page, setPage] = useState(1);

  const debounced = useDebounced(search, 250);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliatePrograms()
      .then((response) => {
        if (!cancelled) setPrograms(response.programs);
      })
      .catch(() => undefined);
    // The affiliate picker is read from the affiliate list rather than derived
    // from the rows on screen: with paging on the server, the current page is no
    // longer the population, so deriving options from it would offer whichever
    // handful of affiliates happen to appear on page one.
    fetchAffiliates({ sort: 'name', limit: 500 })
      .then((response) => {
        if (!cancelled) setAffiliates(response.affiliates);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // A new filter or search starts at the beginning; keeping the page would
  // silently show page four of a result set the reader has not seen page one of.
  // During render rather than in an effect, so the fetch below goes out once —
  // see `useResetOnChange`.
  useResetOnChange(`${debounced} ${programId} ${affiliateId} ${source} ${standing}`, () =>
    setPage(1),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchReferrals({
      programId,
      affiliateId,
      source,
      standing,
      search: debounced,
      page,
      limit: PAGE_SIZE,
    })
      .then((response) => {
        if (cancelled) return;
        setMissing(response === null);
        setResult(response);
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
  }, [programId, affiliateId, source, standing, debounced, page]);

  const rows = result?.referrals ?? [];
  const counts = result?.counts ?? null;
  const total = result?.total ?? 0;
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const filtering = Boolean(programId || affiliateId || source || standing !== 'all' || debounced);

  // GA4 is the only automated source; everything else was recorded by a person,
  // and the two are read as one figure and one note rather than as a list.
  const automated = counts?.bySource.find((row) => row.source === 'ga4')?.n ?? 0;
  const byHand = (counts?.bySource ?? []).filter((row) => row.source !== 'ga4');

  return (
    <>
      <div className="stat-row">
        <Stat
          label="Referrals"
          value={result ? total.toLocaleString() : '—'}
          note={filtering ? 'Matching the filters' : null}
        />
        <Stat
          label="Live"
          value={counts ? counts.live.toLocaleString() : '—'}
          note={
            counts && counts.unassigned > 0
              ? `${counts.unassigned.toLocaleString()} unassigned`
              : null
          }
        />
        <Stat
          label="Commission earned"
          value={counts ? formatValue(counts.earned, 'money', 'USD') : '—'}
        />
        {/* The split, and the figure this page is for. It is a tile, so the
            value is one number — the automated one — and the rest of the split
            goes in the note as counts, not as a sentence. */}
        <Stat
          label="Automated (GA4)"
          value={counts ? formatValue(automated, 'count', null) : '—'}
          note={
            counts && byHand.length > 0
              ? byHand
                  .map((row) => `${row.n.toLocaleString()} ${sourceLabel(row.source).toLowerCase()}`)
                  .join(' · ')
              : null
          }
        />
      </div>

      <div className="controls">
        <div className="control control-search">
          <label htmlFor="referral-search">Find a merchant</label>
          {/* One box for both, because an operator working from a support
              thread has the store name or the domain and does not know which. */}
          <input
            id="referral-search"
            type="search"
            placeholder="Store name or myshopify domain"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control">
          <label htmlFor="referral-program">Program</label>
          <select
            id="referral-program"
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
          <label htmlFor="referral-affiliate">Affiliate</label>
          <select
            id="referral-affiliate"
            value={affiliateId}
            onChange={(event) => setAffiliateId(event.target.value)}
            disabled={affiliates.length === 0}
          >
            <option value="">All affiliates</option>
            {affiliates.map((affiliate) => (
              <option key={affiliate.id} value={affiliate.id}>
                {affiliate.name || affiliate.email}
              </option>
            ))}
          </select>
        </div>

        <div className="control">
          <label htmlFor="referral-source">Source</label>
          <select
            id="referral-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">Any source</option>
            <option value="ga4">{sourceLabel('ga4')}</option>
            <option value="manual">{sourceLabel('manual')}</option>
            <option value="imported">{sourceLabel('imported')}</option>
          </select>
        </div>

        <div className="control">
          <label htmlFor="referral-live">Standing</label>
          <select
            id="referral-live"
            value={standing}
            onChange={(event) => setStanding(event.target.value)}
          >
            <option value="all">Live and unassigned</option>
            <option value="live">Live only</option>
            <option value="unassigned">Unassigned only</option>
          </select>
        </div>
      </div>

      <LoadState
        loading={loading}
        error={error}
        empty={rows.length === 0}
        loadingLabel="Loading referrals…"
        errorTitle="Could not load referrals"
        emptyMessage={
          missing ? (
            <>
              <code>/api/affiliates/referrals</code> is not deployed on this server.
            </>
          ) : filtering ? (
            'No referral matches those filters.'
          ) : (
            'No referrals yet.'
          )
        }
      >
        <div className="card full">
          <div className="table-wrap">
            <table className="customer-table affiliate-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Merchant state</th>
                  <th>Affiliate</th>
                  <th>Program</th>
                  <th className="num">Referred</th>
                  <th>Source</th>
                  <th>Standing</th>
                  <th className="num">Commissions</th>
                  <th className="num">Earned</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
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
                    <td data-label="Affiliate">
                      <a className="customer-link" href={`#/affiliates/${row.affiliateId}`}>
                        <span className="customer-name">{row.affiliateName}</span>
                        <span className="customer-domain">
                          <code>{row.handle}</code>
                        </span>
                      </a>
                    </td>
                    <td data-label="Program">{row.programName}</td>
                    <td className="num" data-label="Referred">
                      {formatFullDate(row.referredAt)}
                    </td>
                    <td data-label="Source">
                      <SourcePill source={row.source} label={sourceLabel(row.source)} />
                    </td>
                    <td data-label="Standing">
                      <ReferralPill unassignedAt={row.unassignedAt} />
                    </td>
                    <td className="num" data-label="Commissions">
                      {row.commissions}
                    </td>
                    <td className="num" data-label="Earned">
                      {formatValue(row.earned, 'money', 'USD')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE ? (
            <div className="pager">
              <button type="button" onClick={() => setPage((n) => n - 1)} disabled={page <= 1}>
                Previous
              </button>
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{' '}
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
      {/* The paragraph explaining "Not synced yet" is now the tooltip on the
          cell that says it — see `MerchantState`. */}
    </>
  );
}

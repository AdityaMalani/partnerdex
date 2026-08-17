import { useEffect, useMemo, useState } from 'react';
import {
  fetchAffiliatePrograms,
  fetchListings,
  type AffiliateProgram,
  type AppListing,
} from '../api';
import { formatValue } from '../format';
import { formatDuration, formatRate, loadReferralFeed, type ReferralFeed } from './AffiliateData';
import { LoadState, Stat } from './AffiliateCommon';

/**
 * The programs and their terms.
 *
 * A handful of programs, so each is a card rather than a row: the question is
 * never "which of these has the highest rate", it is "what exactly did we
 * promise the people in this one". That answer is the terms table, and it is
 * the one thing on this page that may not be shortened away — an operator has
 * to be able to read what a program pays without opening the source.
 *
 * Every term is a cell. None of them is a sentence.
 *
 * The listing URL is not on the program record. It comes from `/api/listings`,
 * the same mapping the referral redirect follows.
 */

function Term({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

/** Absent rather than empty: a term the API does not report is not "none". */
const NOT_REPORTED = <span className="muted-cell">Not reported</span>;

function ProgramCard({
  program,
  listing,
  feed,
}: {
  program: AffiliateProgram;
  listing: AppListing | undefined;
  feed: ReferralFeed | null;
}) {
  const stats = useMemo(() => {
    if (!feed) return null;
    const rows = feed.rows.filter((row) => row.programId === program.id);
    return {
      referrals: rows.length,
      live: rows.filter((row) => !row.unassignedAt).length,
      earned: rows.reduce((sum, row) => sum + row.earned, 0),
      commissions: rows.reduce((sum, row) => sum + row.commissions, 0),
    };
  }, [feed, program.id]);

  return (
    <section className="card full">
      {/* The program's name is the title of the card, not a field label on it.
          No subtitle under it: the rate and the duration were repeated there
          and are two rows of the terms table below. */}
      <div className="card-label program-name">
        {program.name}{' '}
        <span className={`pill ${program.status === 'active' ? 'pill-paying' : ''}`.trim()}>
          {program.status === 'active' ? 'Active' : 'Closed'}
        </span>
      </div>

      <div className="stat-row">
        <Stat label="Enrolled" value={program.affiliates.toLocaleString()} />
        <Stat
          label="Referrals"
          value={stats ? stats.referrals.toLocaleString() : '—'}
          note={stats ? `${stats.live.toLocaleString()} live` : null}
        />
        <Stat
          label="Lifetime commission"
          value={stats ? formatValue(stats.earned, 'money', 'USD') : '—'}
          note={stats ? `${stats.commissions.toLocaleString()} commissions` : null}
        />
        <Stat label="Approval" value={program.requiresApproval ? 'Required' : 'Automatic'} />
      </div>

      {/*
        The terms. Load-bearing, and the reason this page is not just four
        tiles: an operator answering "what does this program pay" needs the
        rate, what it applies to, how long it runs and from when, when a
        referral is released after an uninstall, and what a refund does. All
        six are here as values, and the refund rule is the one that is the same
        for every program — stated once, in its own row, rather than left off
        because it never varies.
      */}
      <div className="table-wrap">
        <table className="program-terms">
          <tbody>
            <Term label="Rate" value={`${formatRate(program.commissionRate)} of gross`} />
            <Term
              label="Earns on"
              value={
                program.revenueComponents?.length
                  ? `${program.revenueComponents.join(', ')} charges`
                  : NOT_REPORTED
              }
            />
            <Term
              label="Duration"
              value={
                program.durationMonths === null
                  ? 'No cut-off'
                  : `${formatDuration(program.durationMonths)} from the first commission on a merchant`
              }
            />
            <Term
              label="Released after uninstall"
              value={
                program.unassignAfterUninstallDays === undefined
                  ? NOT_REPORTED
                  : program.unassignAfterUninstallDays === null
                    ? 'Never'
                    : `${program.unassignAfterUninstallDays} days`
              }
            />
            {/* Said as what the engine does, not as what a programme sounds
                like it should do. A refund arrives as a sale with negative
                gross and is skipped; no negative commission is ever written,
                and no earned commission is reversed. The previous wording
                promised a clawback this system deliberately does not perform. */}
            <Term label="Refunds" value="Earn nothing; earned commission is not reversed" />
            <Term
              label="Listing"
              value={
                listing ? (
                  <a
                    className="customer-domain-link"
                    href={listing.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {listing.url}
                  </a>
                ) : (
                  <span className="muted-cell" title="Add one under Settings → App listings.">
                    None mapped — referral links have nowhere to send a click
                  </span>
                )
              }
            />
            <Term
              label="App"
              value={
                program.appId ? (
                  <code>{program.appId}</code>
                ) : (
                  <span className="muted-cell">Not linked yet</span>
                )
              }
            />
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AffiliatePrograms() {
  const [programs, setPrograms] = useState<AffiliateProgram[] | null>(null);
  const [listings, setListings] = useState<AppListing[]>([]);
  const [feed, setFeed] = useState<ReferralFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliatePrograms()
      .then((result) => {
        if (!cancelled) setPrograms(result.programs);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });

    // The listing mapping is a nicety, not the page: an install with none still
    // has programs worth reading, so a failure here is silent.
    fetchListings()
      .then((result) => {
        if (!cancelled) setListings(result.listings);
      })
      .catch(() => undefined);

    // Referral and commission counts per program. Shared with the Referrals
    // page, so whichever is opened first pays for both.
    loadReferralFeed()
      .then((result) => {
        if (!cancelled) setFeed(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const byApp = useMemo(() => {
    const map = new Map<string, AppListing>();
    for (const listing of listings) map.set(listing.appId, listing);
    return map;
  }, [listings]);

  return (
    <LoadState
      loading={programs === null}
      error={error}
      empty={(programs?.length ?? 0) === 0}
      loadingLabel="Loading programs…"
      errorTitle="Could not load programs"
      emptyMessage="No programs yet — they arrive with the affiliate import."
    >
      {(programs ?? []).map((program) => (
        <ProgramCard
          key={program.id}
          program={program}
          listing={byApp.get(program.appId)}
          feed={feed}
        />
      ))}
    </LoadState>
  );
}

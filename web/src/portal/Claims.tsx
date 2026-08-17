import { useMemo, useState } from 'react';
import { formatFullDate, formatValue } from '../format';
import { submitClaim, type Claim, type ClaimPage, type Program } from './api';
import { Stat } from './Overview';

/**
 * Claims: an affiliate saying "this merchant was mine", and where each one got to.
 *
 * This is the manual half of attribution. The automated half is a click on a
 * referral link followed by an install, which the GA4 pipeline sees; everything
 * it cannot see — a cross-device install, a merchant whose browser blocks
 * analytics, a partner who set the store up before the link existed — arrives
 * here instead. A large minority of the referrals carried over from the previous
 * platform were created this way, so this is not an exception path.
 *
 * ## What this page does not say, and why
 *
 * Nothing on it reveals anything about the merchant. Filing a claim for a store
 * that is not our customer, one that is, and one already credited to a different
 * affiliate all produce the same message, because the server produces the same
 * response — deliberately, so that this cannot be used to find out which shops
 * use our apps or which partner owns them. There is no "that merchant is already
 * taken" state to render and this file must not invent one.
 *
 * ## The shape
 *
 * Figures first, then the form, then the list — the dashboard idiom PR #14
 * settled on. What used to be an explanatory card is one line under the form:
 * claims are read by a person, so the honest thing to say is how the decision
 * gets made, once, in a sentence.
 */

/** Status as the affiliate reads it, with the decision date where there is one. */
function state(claim: Claim): { label: string; tone: string; hint: string } {
  if (claim.status === 'approved') {
    return {
      label: 'Approved',
      tone: 'paying',
      hint: claim.attributed
        ? `Approved ${claim.decidedAt ? formatFullDate(claim.decidedAt) : ''}. The merchant is credited to you — they are on your referrals page.`.replace(
            '  ',
            ' ',
          )
        : // Approved but with no referral against it. Some imported approvals
          // are in this state, so it is a real one and saying "approved" alone
          // would be misleading about what it earned.
          'Approved, but no referral is currently credited to you for it. Get in touch and we will look at it.',
    };
  }
  if (claim.status === 'rejected') {
    return {
      label: 'Not approved',
      tone: 'churned',
      hint: claim.decidedAt
        ? `Decided ${formatFullDate(claim.decidedAt)}. Reply to any email from us if you think that is wrong.`
        : 'Reply to any email from us if you think that is wrong.',
    };
  }
  return {
    label: 'Waiting',
    tone: 'trialing',
    hint: 'Filed and waiting to be read. Nothing is credited until it is approved.',
  };
}

export function Claims({
  page,
  programs,
  onFiled,
}: {
  page: ClaimPage;
  programs: Program[];
  /** Re-read the list, because the server owns what a claim looks like. */
  onFiled: () => void;
}) {
  // Only an enrolled membership may claim, and the server enforces that. The
  // picker matches it so a pending applicant is not offered a program they will
  // be refused on — the refusal is correct but the offer would not have been.
  const claimable = useMemo(
    () => programs.filter((program) => program.status === 'enrolled'),
    [programs],
  );

  const [programId, setProgramId] = useState(() => claimable[0]?.programId ?? '');
  const [merchant, setMerchant] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const counts = useMemo(() => {
    const by = { pending: 0, approved: 0, rejected: 0 };
    for (const claim of page.claims) by[claim.status] += 1;
    return by;
  }, [page.claims]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !programId || !merchant.trim()) return;

    setBusy(true);
    setError(null);
    setDone(null);
    submitClaim({ programId, merchant: merchant.trim(), notes: notes.trim() || undefined })
      .then((result) => {
        // Two outcomes, and both are about this affiliate's own claims — never
        // about the merchant. `duplicate` means they had already filed it.
        setDone(
          result.claim.duplicate
            ? 'You had already claimed that merchant, so nothing new was filed. It is in the list below.'
            : 'Claim filed. It is in the list below, waiting to be read.',
        );
        setMerchant('');
        setNotes('');
        onFiled();
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="portal-section">
      <div className="portal-stats">
        <Stat label="Claims filed" value={formatValue(page.total, 'count', null)} />
        <Stat label="Waiting" value={formatValue(counts.pending, 'count', null)} />
        <Stat label="Approved" value={formatValue(counts.approved, 'count', null)} />
        <Stat label="Not approved" value={formatValue(counts.rejected, 'count', null)} />
      </div>

      {claimable.length === 0 ? (
        <p className="portal-hint portal-note">
          You can claim a merchant once you are enrolled in a program.
        </p>
      ) : (
        <form className="claim-form" onSubmit={submit}>
          <div className="controls">
            <div className="control">
              <label htmlFor="claim-program">Program</label>
              <select
                id="claim-program"
                value={programId}
                onChange={(event) => setProgramId(event.target.value)}
                disabled={busy}
              >
                {claimable.map((program) => (
                  <option key={program.programId} value={program.programId}>
                    {program.programName}
                  </option>
                ))}
              </select>
            </div>

            <div className="control claim-merchant">
              <label htmlFor="claim-merchant">Merchant</label>
              <input
                id="claim-merchant"
                type="text"
                value={merchant}
                maxLength={120}
                placeholder="their-store.myshopify.com"
                onChange={(event) => setMerchant(event.target.value)}
                disabled={busy}
              />
            </div>
          </div>

          <div className="control claim-notes">
            <label htmlFor="claim-notes">Anything that helps (optional)</label>
            <textarea
              id="claim-notes"
              value={notes}
              rows={2}
              maxLength={1000}
              placeholder="How you know they came from you."
              onChange={(event) => setNotes(event.target.value)}
              disabled={busy}
            />
          </div>

          <div className="claim-submit">
            <button type="submit" className="primary" disabled={busy || !merchant.trim()}>
              {busy ? 'Filing…' : 'File claim'}
            </button>
            {/* One line, not a card. The two facts worth carrying: a person
                reads these, and filing one credits nothing by itself. */}
            <span className="portal-hint portal-note">
              Every claim is read by hand. Filing one does not credit the merchant to you.
            </span>
          </div>

          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          {done ? (
            <p className="portal-hint portal-note" role="status">
              {done}
            </p>
          ) : null}
        </form>
      )}

      {page.unavailable ? (
        <p className="portal-hint portal-note">Claims are not available here yet.</p>
      ) : page.claims.length === 0 ? (
        <p className="portal-hint portal-note">
          No claims yet. Claim a merchant when an install was yours but is not on your referrals
          page — a cross-device install, or one that never followed your link.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Program</th>
                <th>Filed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {page.claims.map((claim) => {
                const current = state(claim);
                return (
                  <tr key={claim.id}>
                    {/* The merchant as the affiliate themselves typed it — the
                        server echoes it back rather than resolving it, so this
                        is their own text going through React as text. */}
                    <td data-label="Merchant">
                      {claim.merchant}
                      {claim.notes ? <span className="row-hint">{claim.notes}</span> : null}
                    </td>
                    <td data-label="Program">{claim.programName}</td>
                    <td data-label="Filed">{formatFullDate(claim.claimedAt)}</td>
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
      )}

      {page.hasNextPage ? (
        <p className="footnote">
          Most recent {formatValue(page.claims.length, 'count', null)} of{' '}
          {formatValue(page.total, 'count', null)}.
        </p>
      ) : null}
    </section>
  );
}

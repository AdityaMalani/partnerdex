import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchReviewCandidates,
  fetchReviews,
  linkReviewToShop,
  type ReviewCandidate,
  type ReviewSummary,
} from '../api';
import { formatCalendarDate } from '../format';
import { useDebounced } from '../hooks';

/**
 * The reviews we could not attribute to a customer, and the way to fix that.
 *
 * A review publishes the merchant's store name and never their myshopify
 * domain, so the match is a guess and is only trusted when exactly one shop
 * that installed the app answers to that name. Everything else lands here —
 * and it matters, because an unattributed review is a hole in every figure on
 * the page: the charts count it, and no customer owns it.
 *
 * Only the partner can close that hole. They recognise the store name; we do
 * not. So this is a prompt with the work attached rather than a statistic.
 */

/**
 * The rating, as stars and as a label.
 *
 * The label is not decoration: five glyphs at small sizes are genuinely hard to
 * count, and it is what a screen reader announces.
 */
export function Stars({ rating }: { rating: number }) {
  const whole = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className={`stars stars-${whole}`} aria-label={`${whole} out of 5 stars`} role="img">
      <span aria-hidden="true">{'★'.repeat(whole)}</span>
      <span aria-hidden="true" className="stars-empty">
        {'★'.repeat(5 - whole)}
      </span>
    </span>
  );
}

/**
 * Choosing which merchant a review belongs to.
 *
 * Candidates come from the server already ordered with the app's own installers
 * first — the reviewer is necessarily among them, and a partner scanning the
 * list should not have to wade past shops that could not have written it.
 */
function LinkPicker({
  review,
  onLinked,
}: {
  review: ReviewSummary;
  onLinked: () => void;
}) {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounced = useDebounced(search, 250);

  useEffect(() => {
    let cancelled = false;
    fetchReviewCandidates(review.reviewId, debounced)
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, review.reviewId]);

  const link = (shopId: string) => {
    setBusy(true);
    setError(null);
    linkReviewToShop(review.reviewId, shopId)
      .then(onLinked)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="review-picker">
      <label htmlFor={`picker-${review.reviewId}`}>
        Which merchant is <strong>{review.storeName || 'this store'}</strong>?
      </label>
      <input
        id={`picker-${review.reviewId}`}
        type="search"
        placeholder="Store name, myshopify domain, or shop id"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />

      {error ? <p className="review-picker-error">{error}</p> : null}

      <ul className="review-candidates">
        {candidates.map((candidate) => (
          <li key={candidate.shopId}>
            <button type="button" disabled={busy} onClick={() => link(candidate.shopId)}>
              <span className="candidate-name">
                {candidate.name ?? candidate.domain ?? candidate.shopId}
              </span>
              <span className="candidate-meta">
                {candidate.domain ?? `Shop ${candidate.shopId}`}
                {/* The reviewer necessarily installed the app, so this is the
                    single most useful thing to know about a candidate. */}
                {candidate.installedThisApp ? ' · installed this app' : ''}
              </span>
            </button>
          </li>
        ))}
        {candidates.length === 0 ? <li className="candidate-empty">No merchants match.</li> : null}
      </ul>
    </div>
  );
}

/** The longest excerpt shown before a review is trusted to speak for itself. */
const EXCERPT = 220;

function UnmatchedRow({ review, onLinked }: { review: ReviewSummary; onLinked: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="review">
      <div className="review-head">
        <Stars rating={review.rating} />
        <span className="review-store">{review.storeName || 'Unknown store'}</span>
        {review.country ? <span className="review-meta">{review.country}</span> : null}
        <span className="review-meta">{formatCalendarDate(review.postedOn)}</span>
        {review.appName ? <span className="review-meta">{review.appName}</span> : null}
        {/* Why it is here, rather than leaving the reader to wonder whether the
            matcher simply failed. */}
        {review.matchMethod === 'ambiguous' ? (
          <span className="pill" title="More than one installer answers to this store name.">
            Ambiguous
          </span>
        ) : null}
      </div>

      {review.body ? (
        <p className="review-body">
          {review.body.length > EXCERPT ? `${review.body.slice(0, EXCERPT)}…` : review.body}
        </p>
      ) : null}

      <div className="review-foot">
        <span className="review-meta">
          {review.usageDuration ?? 'No matching customer'}
        </span>
        {!open ? (
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            Link to a customer
          </button>
        ) : (
          <button type="button" className="link-button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>

      {open ? <LinkPicker review={review} onLinked={onLinked} /> : null}
    </li>
  );
}

export function UnmatchedReviews({ appId }: { appId: string }) {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  /**
   * The one place this list is read from, and the one place the guard lives.
   *
   * The refresh after a link used to re-inline the identical request, so the
   * query existed twice and neither copy could tell a superseded response from
   * a current one — switching app twice in quick succession could leave the
   * first app's unmatched reviews on screen. Resolves to the new total, or to
   * null when the response has been superseded and was thrown away.
   */
  const generation = useRef(0);
  const load = useCallback((): Promise<number | null> => {
    const mine = (generation.current += 1);
    return fetchReviews({ appId, linked: 'unmatched', sort: 'newest', limit: 100 })
      .then((result) => {
        if (generation.current !== mine) return null;
        setReviews(result.reviews);
        setTotal(result.total);
        return result.total;
      })
      .catch(() => {
        // A banner that cannot load is not worth an error of its own: the page
        // it sits on has its own, and there is nothing here to act on.
        if (generation.current !== mine) return null;
        setReviews([]);
        setTotal(0);
        return null;
      });
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A native `<dialog>` rather than a hand-rolled overlay.
   *
   * `showModal` brings the focus trap, the inert background, Escape-to-close and
   * the top layer with it — all of which a div pretending to be a dialog has to
   * reimplement, usually incompletely.
   */
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  /**
   * Escape, handled rather than assumed.
   *
   * `showModal` is supposed to bring this with it, but the dialog's native
   * `cancel` does not fire in every engine the dashboard might be opened in —
   * and a modal a reader cannot dismiss from the keyboard is a trap. Three lines
   * to not depend on it.
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Linking the last one empties the dialog, so close it rather than leaving an
  // empty box open over the page.
  const handleLinked = useCallback(() => {
    void load().then((total) => {
      if (total === null) return;
      if (total === 0) setOpen(false);
      // The row that was just linked is gone, and the button inside it that had
      // focus went with it — leaving focus on `<body>`, outside the dialog,
      // where Escape no longer closes it and a keyboard reader is stranded. Put
      // focus back on the dialog itself.
      else dialog.current?.focus();
    });
  }, [load]);

  if (total === 0) return null;

  return (
    <>
      <div className="banner banner-attention" role="status">
        <div>
          <strong>
            {total.toLocaleString()} review{total === 1 ? '' : 's'} not matched to a customer
          </strong>
          <p>
            {total === 1 ? 'It counts' : 'They count'} in the figures below, but{' '}
            {total === 1 ? 'is' : 'are'} not on anyone&rsquo;s customer page. Reviews only publish a
            store name, so the automatic match gives up rather than guessing.
          </p>
        </div>
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Link manually
        </button>
      </div>

      {/* `tabIndex` so the dialog itself can hold focus when the element that
          had it is removed from under the reader. */}
      <dialog ref={dialog} className="modal" tabIndex={-1} onClose={() => setOpen(false)}>
        <div className="modal-head">
          <h2 className="card-label">Link reviews to customers</h2>
          <button
            type="button"
            className="modal-close"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="card-subtitle">
          You recognise these store names; the matcher does not. Linking one puts the review on that
          merchant&rsquo;s page for good — a later sync will not undo it.
        </p>

        <ul className="review-list">
          {reviews.map((review) => (
            <UnmatchedRow key={review.reviewId} review={review} onLinked={handleLinked} />
          ))}
        </ul>
      </dialog>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchFunnel, type FunnelBucket, type FunnelResponse, type Granularity } from '../api';
import { formatBucketDate, formatFullDate } from '../format';

/**
 * The install funnel.
 *
 * Two readings of one dataset. The **table** is the matrix — steps down the
 * side, periods across the top — and answers "is the shape moving". The
 * **chart** collapses the whole range into one funnel and answers "where do
 * they stop". A headline conversion sits above both, because the single number
 * a reader leads with is first step to last.
 *
 * Three things the layout has to keep saying:
 *
 *   - a step with no data is blank, never zero. The top two go dark on an
 *     install that has not connected BigQuery, and a dash is the honest mark.
 *   - between step 2 and step 3, browsers become shops. Said by the GA4 and
 *     Partner pills on every row and by the notes underneath, rather than by a
 *     rule across the table: the change of source is a fact about each step, and
 *     drawn as a divider it cut the funnel in two where the reader's eye most
 *     needs to carry across.
 *   - conversions are step-over-step against the previous *included* step, so
 *     excluding a step re-chains the arithmetic rather than leaving a hole.
 */

const STEP_STORAGE_KEY = 'partnerdex:funnel-steps';
const VIEW_STORAGE_KEY = 'partnerdex:funnel-view';

/** A funnel needs two points to have a conversion at all. */
const MIN_STEPS = 2;

type ViewMode = 'table' | 'chart';

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function count(value: number | null): string {
  return value === null ? '—' : NUMBER.format(value);
}

/**
 * Percentages carry one decimal below 10 and none above.
 *
 * A 0.4% conversion rendered without the decimal is a flat zero, and "21.9%"
 * beside "22%" in the same column is noise rather than precision.
 */
function rate(value: number): string {
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}%`;
}

/**
 * Step-over-step conversion for a chosen subset of steps.
 *
 * Recomputed here rather than taken from the response, because the response
 * describes all five steps and the reader may be looking at three. A null on
 * either side is unmeasurable and a zero denominator has no finite rate —
 * neither is 0%, which would read as "nobody converted".
 */
export function conversionsFor(
  counts: Array<number | null>,
  indices: number[],
): Array<number | null> {
  return indices.map((stepIndex, position) => {
    if (position === 0) return null;
    const value = counts[stepIndex] ?? null;
    const previous = counts[indices[position - 1]!] ?? null;
    if (value === null || previous === null || previous === 0) return null;
    return Math.round((value / previous) * 10000) / 100;
  });
}

/**
 * First shown step to last, as one rate.
 *
 * The same chain `conversionsFor` walks, with everything in between taken out —
 * so the end-to-end figure cannot drift from the step-over-step ones above it,
 * and excluding a step moves both together. Null propagates for the same
 * reasons: an unmeasurable end, or nobody at the top to convert.
 */
export function endToEnd(counts: Array<number | null>, indices: number[]): number | null {
  if (indices.length < MIN_STEPS) return null;
  return conversionsFor(counts, [indices[0]!, indices[indices.length - 1]!])[1] ?? null;
}

/** Column headings. A single collapsed bucket names its span, not its start. */
function columnLabel(bucket: FunnelBucket, granularity: Granularity, interval: string): string {
  if (granularity === 'previous_7_days') return 'Previous 7 days';
  if (granularity === 'week') return `Week of ${formatBucketDate(bucket.periodStart, 'day')}`;
  return formatBucketDate(bucket.periodStart, interval);
}

/**
 * The conversion under a count.
 *
 * Just the number. It had a bar behind it, which encoded the same value as the
 * digits and read as a stray underline; then an arrow, which pointed the way
 * every one of them already pointed. What tells a conversion from a count is
 * that it is smaller, greyer, and sits underneath — the title says the rest.
 */
function Conversion({ value, from }: { value: number | null; from: string }) {
  if (value === null) return <span className="funnel-conv empty">—</span>;
  return (
    <span className="funnel-conv" title={`${value}% of “${from}”`}>
      {rate(value)}
    </span>
  );
}

/* ------------------------------------------------------------- step picker */

/**
 * Everything about how the funnel is drawn, behind one control.
 *
 * The view switch used to sit out on the headline card, where it competed with
 * the one number that card exists to show. It is the same kind of choice as
 * which steps to include — a setting, not a finding — so both live here, at the
 * top right of the card they actually change.
 */
function FunnelSettings({
  steps,
  included,
  onToggle,
  view,
  onView,
}: {
  steps: FunnelResponse['steps'];
  included: string[];
  onToggle: (key: string) => void;
  view: ViewMode;
  onView: (next: ViewMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  // A popover that outlives a click elsewhere is a popover in the way.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="funnel-settings" ref={holder}>
      <button
        type="button"
        className="funnel-settings-button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Funnel settings"
        title="Funnel settings"
        onClick={() => setOpen((current) => !current)}
      >
        {/*
          A toothed cog, not a hub with rays.
          The previous drawing was a circle with eight radial spokes, which is
          the same construction as this dashboard's own light-theme sun — two
          controls a few hundred pixels apart reading as the same glyph. The
          teeth are what make a gear a gear, so they are drawn as an outline
          rather than as strokes leaving the hub.
        */}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M19.14 12.94a7.4 7.4 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.86a.5.5 0 0 0 .12.62l2.03 1.58a7.4 7.4 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.62l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.7 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.62z"
            fill="none"
            strokeWidth="1.5"
          />
          <circle cx="12" cy="12" r="2.6" fill="none" strokeWidth="1.5" />
        </svg>
      </button>

      {open ? (
        <div className="funnel-settings-panel" role="group" aria-label="Funnel settings">
          <p className="funnel-settings-title">Show as</p>
          <div className="funnel-views" role="group" aria-label="How to show the funnel">
            <button
              type="button"
              className={view === 'table' ? 'active' : undefined}
              aria-pressed={view === 'table'}
              onClick={() => onView('table')}
            >
              Table
            </button>
            <button
              type="button"
              className={view === 'chart' ? 'active' : undefined}
              aria-pressed={view === 'chart'}
              onClick={() => onView('chart')}
            >
              Funnel
            </button>
          </div>

          <p className="funnel-settings-title spaced">Steps shown</p>
          {steps.map((step) => {
            const on = included.includes(step.key);
            // The last two cannot be unchecked: a funnel with one step has no
            // conversion to report, and the headline figure would have no ends.
            const locked = on && included.length <= MIN_STEPS;
            return (
              <label key={step.key} className={locked ? 'funnel-settings-row locked' : 'funnel-settings-row'}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={() => onToggle(step.key)}
                />
                <span>{step.label}</span>
                <span className={`pill funnel-source-${step.source}`}>
                  {step.source === 'bigquery' ? 'GA4' : 'Partner'}
                </span>
              </label>
            );
          })}
          <p className="funnel-settings-note">
            Conversions re-chain to the previous step still shown.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- the chart */

/**
 * The whole range as one funnel.
 *
 * Ordered stages are ordinal, not categorical: one hue stepping in lightness,
 * so the order is visible in the colour and no stage claims an identity it does
 * not have. Bars are left-anchored rather than centred — a taper still reads as
 * a funnel, and a common baseline is what makes two lengths comparable.
 */
function FunnelChart({
  steps,
  counts,
  conversions,
}: {
  steps: FunnelResponse['steps'];
  counts: Array<number | null>;
  conversions: Array<number | null>;
}) {
  // Scaled against the widest measurable step, so an unmeasurable top does not
  // collapse everything below it to a sliver.
  const widest = Math.max(...counts.map((value) => value ?? 0), 1);

  return (
    <ol className="funnel-chart">
      {steps.map((step, index) => {
        const value = counts[index] ?? null;
        const width = value === null ? 0 : Math.max((value / widest) * 100, value > 0 ? 1.5 : 0);
        return (
          <li className="funnel-bar-row" key={step.key}>
            <div className="funnel-bar-label">
              <span className="funnel-step-index">{index + 1}</span>
              <span className="funnel-step-label">{step.label}</span>
              <span className={`pill funnel-source-${step.source}`}>
                {step.source === 'bigquery' ? 'GA4' : 'Partner'}
              </span>
            </div>

            <div className="funnel-bar-track">
              {value === null ? (
                <span className="funnel-bar-absent">Not measured</span>
              ) : (
                <div
                  className="funnel-bar"
                  style={{
                    width: `${width}%`,
                    // Ordinal ramp: step 1 is the anchor end of one hue.
                    background: `var(--funnel-${Math.min(index + 1, 5)})`,
                  }}
                  title={`${step.label}: ${NUMBER.format(value)} ${step.unit}s`}
                />
              )}
              <span className="funnel-bar-value">{count(value)}</span>
            </div>

            <div className="funnel-bar-conv">
              {index === 0 ? null : (
                <Conversion value={conversions[index] ?? null} from={steps[index - 1]!.label} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------- the page */

export function Funnel({
  appId,
  orgId = '',
  period,
  granularity,
}: {
  appId: string;
  orgId?: string;
  period: string;
  granularity: Granularity;
}) {
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [included, setIncluded] = useState<string[] | null>(() => {
    try {
      const stored = window.localStorage.getItem(STEP_STORAGE_KEY);
      return stored ? (JSON.parse(stored) as string[]) : null;
    } catch {
      return null;
    }
  });

  const [view, setView] = useState<ViewMode>(() =>
    window.localStorage.getItem(VIEW_STORAGE_KEY) === 'chart' ? 'chart' : 'table',
  );

  const changeView = useCallback((next: ViewMode) => {
    setView(next);
    window.localStorage.setItem(VIEW_STORAGE_KEY, next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchFunnel({ appId, orgId, period, granularity })
      .then((result) => {
        if (cancelled) return;
        setData(result);
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
  }, [appId, orgId, period, granularity]);

  const toggle = useCallback(
    (key: string) => {
      setIncluded((current) => {
        const base = current ?? data?.steps.map((step) => step.key) ?? [];
        const next = base.includes(key)
          ? base.filter((entry) => entry !== key)
          : [...base, key];
        if (next.length < MIN_STEPS) return base;
        // Kept in the funnel's own order rather than in click order — the steps
        // are a sequence, and a reordered one would be a different report.
        const ordered = (data?.steps ?? [])
          .map((step) => step.key)
          .filter((entry) => next.includes(entry));
        window.localStorage.setItem(STEP_STORAGE_KEY, JSON.stringify(ordered));
        return ordered;
      });
    },
    [data],
  );

  /**
   * Columns newest-first.
   *
   * The report is read from a scroll container pinned to its left edge, and what
   * a reader wants there is this week — not the oldest week in the range, with
   * the interesting end parked off-screen behind a horizontal scroll. The steps
   * still run top to bottom in funnel order; only time is reversed, and it runs
   * away from the frozen Step and Total columns rather than towards them.
   */
  const columns = useMemo(() => [...(data?.buckets ?? [])].reverse(), [data]);

  /** Indices into the response's five steps, in order, for what is shown. */
  const shown = useMemo(() => {
    if (!data) return [];
    const keys = included ?? data.steps.map((step) => step.key);
    const indices = data.steps
      .map((step, index) => (keys.includes(step.key) ? index : -1))
      .filter((index) => index >= 0);
    return indices.length >= MIN_STEPS ? indices : data.steps.map((_, index) => index);
  }, [data, included]);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load the funnel</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return <div className="skeleton">Loading funnel…</div>;

  const steps = shown.map((index) => data.steps[index]!);
  const totals = shown.map((index) => data.totals.counts[index] ?? null);
  const totalConversions = conversionsFor(data.totals.counts, shown);

  const first = totals[0] ?? null;
  const last = totals[totals.length - 1] ?? null;
  const headline = endToEnd(data.totals.counts, shown);

  return (
    <>
      {/* The one number this page leads with: the whole funnel, end to end. */}
      <div className="card full funnel-headline">
        <div className="funnel-headline-figure">
          <span className="funnel-headline-label">
            {steps[0]!.label} → {steps[steps.length - 1]!.label}
          </span>
          <span className="funnel-headline-value">{headline === null ? '—' : `${headline}%`}</span>
          <span className="funnel-headline-sub">
            {headline === null
              ? `“${steps[0]!.label}” is not measured for this app, so there is no end-to-end rate.`
              : `${count(first)} → ${count(last)} · ${formatFullDate(data.periodStart)} – ${formatFullDate(data.periodEnd)}`}
          </span>
        </div>

      </div>

      <div className={loading ? 'card full funnel-card stale' : 'card full funnel-card'}>
        {/* One head, one settings control, whichever way the data is drawn. */}
        <div className="card-head">
          <span className="card-label">{view === 'chart' ? 'Whole range' : 'By period'}</span>
          <FunnelSettings
            steps={data.steps}
            included={steps.map((s) => s.key)}
            onToggle={toggle}
            view={view}
            onView={changeView}
          />
        </div>

        {view === 'chart' ? (
          <FunnelChart steps={steps} counts={totals} conversions={totalConversions} />
        ) : (
          <div className="funnel-scroll">
            <table className="funnel-table">
              <caption className="sr-only">
                Funnel steps by {data.granularity.replace(/_/g, ' ')}
              </caption>
              <colgroup>
                <col className="funnel-col-step" />
                <col className="funnel-col-total" />
                {columns.map((bucket) => (
                  <col key={bucket.periodStart} className="funnel-col-bucket" />
                ))}
              </colgroup>

              <thead>
                <tr>
                  <th scope="col" className="funnel-cell-step">
                    Step
                  </th>
                  <th scope="col" className="funnel-cell-total">
                    Total
                  </th>
                  {columns.map((bucket) => (
                    <th
                      scope="col"
                      key={bucket.periodStart}
                      className={bucket.provisional ? 'provisional' : undefined}
                      title={
                        bucket.provisional
                          ? 'Still filling — trials started here have not all decided yet.'
                          : undefined
                      }
                    >
                      {columnLabel(bucket, data.granularity, data.timeSeriesInterval)}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {steps.map((step, position) => {
                  const stepIndex = shown[position]!;

                  return (
                    <tr key={step.key}>
                      <th scope="row" className="funnel-cell-step">
                        <span className="funnel-step-index">{position + 1}</span>
                        <span className="funnel-step-label">{step.label}</span>
                        <span className={`pill funnel-source-${step.source}`}>
                          {step.source === 'bigquery' ? 'GA4' : 'Partner'}
                        </span>
                      </th>

                      <td className="funnel-cell-total">
                        <span className="funnel-count">{count(totals[position] ?? null)}</span>
                        {position === 0 ? null : (
                          <Conversion
                            value={totalConversions[position] ?? null}
                            from={steps[position - 1]!.label}
                          />
                        )}
                      </td>

                      {columns.map((bucket) => {
                        const cell = conversionsFor(bucket.counts, shown);
                        return (
                          <td
                            key={bucket.periodStart}
                            className={bucket.provisional ? 'provisional' : undefined}
                          >
                            <span className="funnel-count">
                              {count(bucket.counts[stepIndex] ?? null)}
                            </span>
                            {position === 0 ? null : (
                              <Conversion
                                value={cell[position] ?? null}
                                from={steps[position - 1]!.label}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>

              {/*
                The bottom line, per column.

                Every rate above it is against the step before, so reading the
                range end to end means multiplying five of them across a row —
                which is the one number a reader actually wants and the one the
                matrix made hardest to get. It is a `tfoot` rather than a sixth
                body row because it is not a step: nothing converts *into* it,
                and the row heading names a span rather than an event.
              */}
              <tfoot>
                <tr className="funnel-final">
                  <th scope="row" className="funnel-cell-step">
                    <span className="funnel-step-label">Final conversion</span>
                    <span className="funnel-final-span">
                      {steps[0]!.label} → {steps[steps.length - 1]!.label}
                    </span>
                  </th>

                  <td className="funnel-cell-total">
                    {/* The same figure the headline card leads with, rounded to
                        the table's precision. The exact rate is on the title,
                        so the two never look like different numbers without a
                        way to reconcile them. */}
                    <span
                      className={
                        headline === null ? 'funnel-final-value empty' : 'funnel-final-value'
                      }
                      title={headline === null ? undefined : `${headline}% across the whole range`}
                    >
                      {headline === null ? '—' : rate(headline)}
                    </span>
                  </td>

                  {columns.map((bucket) => {
                    const value = endToEnd(bucket.counts, shown);
                    return (
                      <td
                        key={bucket.periodStart}
                        className={bucket.provisional ? 'provisional' : undefined}
                      >
                        <span
                          className={
                            value === null ? 'funnel-final-value empty' : 'funnel-final-value'
                          }
                          title={
                            value === null
                              ? undefined
                              : `${value}% of “${steps[0]!.label}” reached “${
                                  steps[steps.length - 1]!.label
                                }”`
                          }
                        >
                          {value === null ? '—' : rate(value)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Said under the figures rather than over them: a reader who has already
          understood the shape does not need the caveats first, and one who is
          about to misread it needs them before they leave the page. */}
      <ul className="funnel-notes">
        {data.meta.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </>
  );
}

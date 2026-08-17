import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { MetricResponse } from '../api';
import { formatValue } from '../format';
import type { CardSpec } from '../pages';
import type { CardState } from '../useOverview';
// Type-only, so no charting code is pulled in by naming the shape of a series.
import type { ChartSeries } from './Chart';

/**
 * The plot arrives as its own chunk.
 *
 * The charting library is the largest single thing the dashboard would
 * otherwise ship in one piece, and most of the dashboard never draws a plot:
 * the customer list, the settings pages and the whole affiliate section are
 * tables and forms. Keeping it behind a dynamic import means those pages never
 * download it, and the pages that do draw plots show their figures first.
 */
const CardChart = lazy(() => import('./CardChart'));

/**
 * Categorical slots 1-4, in their fixed order — slot 1 is the brand. Assign by
 * entity and never cycle: a filter that removes a series must not repaint the
 * ones that remain.
 */
const SLOT = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'] as const;

/**
 * A single-series plot is drawn in the brand unless the card says what it is
 * measuring, in which case the design system's growth and churn colours say it
 * before the label is read. Both roles are theme-aware and clear 3:1 on the card
 * in either theme, so the meaning survives the swap.
 */
const TONE = {
  growth: 'var(--good)',
  churn: 'var(--critical)',
} as const;

/**
 * A card is one metric read four ways: what it is, what it is now, how that
 * compares with the period before, and how it got there.
 *
 * The comparison line is deliberately period-scoped rather than bucket-scoped.
 * "Up 12% on the previous 30 days" is the question the headline figure raises;
 * answering it with the last two buckets would silently compare two days.
 *
 * The card also owns its own loading and failure states, and that is the point
 * of them living here: cards are fetched separately, so one that is still coming
 * says so in its own frame while its neighbours show figures, and one that
 * failed reports the failure in the space it occupies instead of taking the
 * page down with it.
 */
export function MetricCard({
  spec,
  state,
  onRetry,
}: {
  spec: CardSpec;
  /** Undefined before a request has been issued for this card at all. */
  state?: CardState;
  onRetry?: (metric: string) => void;
}) {
  const [showTable, setShowTable] = useState(false);
  const metric = state?.metric;

  // Memoized on the response rather than rebuilt per render: a fresh array here
  // would invalidate the series below — and the chart's own row shaping — on
  // every render of the page, including a theme toggle or a status poll.
  const breakdown = useMemo(
    () => (spec.breakdown ? metric?.series ?? [] : []),
    [spec.breakdown, metric],
  );

  const series = useMemo<ChartSeries[]>(() => {
    if (breakdown.length > 0) {
      return breakdown.slice(0, SLOT.length).map((item, index) => ({
        key: item.key,
        name: item.name,
        color: SLOT[index]!,
      }));
    }
    return [{ key: 'value', name: spec.label, color: spec.tone ? TONE[spec.tone] : SLOT[0]! }];
  }, [breakdown, spec.label, spec.tone]);

  if (!metric) {
    // Three ways a card can have no figure, and they mean different things to a
    // reader: it has not arrived yet, it will not arrive, or the server never
    // offered it. Only the middle one is worth a retry button.
    if (state?.status === 'error') {
      return (
        <EmptyCard spec={spec} value="—" tone="failed">
          <p className="card-note card-note-failed">{state.error}</p>
          {onRetry ? (
            <button type="button" className="card-toggle" onClick={() => onRetry(spec.metric)}>
              Try again
            </button>
          ) : null}
        </EmptyCard>
      );
    }
    if (!state || state.status === 'loading') {
      return (
        <EmptyCard spec={spec} value="…" tone="pending" busy>
          <p className="card-note">Still computing</p>
        </EmptyCard>
      );
    }
    return (
      <EmptyCard spec={spec} value="—">
        <p className="card-note">Not available</p>
      </EmptyCard>
    );
  }

  const format = metric.format;
  const currency = metric.currency;
  const height = spec.full ? 260 : 150;

  return (
    <section
      className={spec.full ? 'card full' : 'card'}
      // A card holding a figure while its replacement is in flight is busy, not
      // empty: the number stays readable and assistive technology is told it is
      // being updated rather than being read a value twice.
      aria-busy={state?.status === 'loading' ? true : undefined}
    >
      <div className="card-head">
        <div>
          <h2 className="card-label">{spec.label}</h2>
          {spec.subtitle ? <p className="card-subtitle">{spec.subtitle}</p> : null}
        </div>
        {/* Multi-series cards owe the reader a table: past two series, colour
            alone stops being a reliable way to pick one out. */}
        {series.length > 1 ? (
          <button
            type="button"
            className="card-toggle"
            onClick={() => setShowTable((current) => !current)}
            aria-pressed={showTable}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        ) : null}
      </div>

      <div className="card-value">
        {/* Revenue figures show their exact value; counts may still compact. */}
        {formatValue(metric.value, format, currency, { compact: format !== 'money' })}
      </div>

      <Comparison metric={metric} invert={spec.invertDelta ?? false} />

      {/* A refresh that failed leaves the previous figure up rather than
          blanking the card, so the card has to say that what is on screen is
          not the answer to the question currently in the filter bar. */}
      {state?.status === 'error' ? (
        <p className="card-note card-note-failed">
          Could not refresh — showing the last figure that arrived.
          {onRetry ? (
            <>
              {' '}
              <button type="button" className="card-note-retry" onClick={() => onRetry(spec.metric)}>
                Try again
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {series.length > 1 ? (
        <div className="legend">
          {series.map((item) => (
            <span className="legend-item" key={item.key}>
              <span className="legend-swatch" style={{ background: item.color }} />
              {item.name}
            </span>
          ))}
        </div>
      ) : null}

      {/* The figure above has already painted; the plot fills the space it has
          reserved when its chunk arrives. The fallback is the same height, so
          nothing on the page moves when it does. */}
      <Suspense fallback={<div className="card-placeholder" style={{ height }} />}>
        <CardChart
          spec={spec}
          metric={metric}
          series={series}
          breakdown={breakdown}
          showTable={showTable}
          height={height}
        />
      </Suspense>
    </section>
  );
}

/**
 * A card with no figure in it yet.
 *
 * Same frame, same label, same reserved plot height as a card that has one, so
 * a grid filling in one card at a time settles rather than jumping: a figure
 * landing replaces a placeholder of its own size instead of pushing the cards
 * below it down the page.
 */
function EmptyCard({
  spec,
  value,
  tone,
  busy,
  children,
}: {
  spec: CardSpec;
  value: string;
  tone?: 'pending' | 'failed';
  busy?: boolean;
  children: ReactNode;
}) {
  const classes = ['card'];
  if (spec.full) classes.push('full');
  if (tone) classes.push(`card-${tone}`);

  return (
    <section className={classes.join(' ')} aria-busy={busy ? true : undefined}>
      <div className="card-head">
        <div>
          <h2 className="card-label">{spec.label}</h2>
          {spec.subtitle ? <p className="card-subtitle">{spec.subtitle}</p> : null}
        </div>
      </div>
      <div className="card-value card-value-empty">{value}</div>
      {children}
      <div className="card-placeholder" style={{ height: spec.full ? 260 : 150 }} />
    </section>
  );
}

/**
 * The change and the figure it is measured against, both scoped to the selected
 * period. Showing the percentage alone would hide the case that matters most:
 * a large percentage swing on a base of almost nothing.
 *
 * "previously" stands in for naming the span: the range is already stated once
 * in the filter bar, and repeating it on every card in the grid crowded the
 * line without telling the reader anything new.
 */
function Comparison({ metric, invert }: { metric: MetricResponse; invert: boolean }) {
  const comparison = metric.comparison;
  if (!comparison) {
    return <div className="card-delta">No earlier period to compare against</div>;
  }

  const previous = formatValue(comparison.previousValue, metric.format, metric.currency, {
    compact: metric.format !== 'money',
  });

  if (comparison.changePercent === null) {
    // A zero base has no finite growth rate; the absolute figure still reads.
    return (
      <div className="card-delta">
        <span className="card-delta-figure">New</span>{' '}
        <span className="card-delta-note">from {previous} previously</span>
      </div>
    );
  }

  const flat = comparison.change === 0;
  const rising = comparison.change > 0;
  const tone = flat ? '' : (invert ? !rising : rising) ? ' up' : ' down';

  return (
    <div className={`card-delta${tone}`}>
      <span className="card-delta-figure">
        {/* The arrow says which way it moved; the colour says whether that is
            good. Churn rising is red and up, and both facts are legible. */}
        {flat ? '' : rising ? '▲ ' : '▼ '}
        {Math.abs(comparison.changePercent).toFixed(1)}%
      </span>{' '}
      <span className="card-delta-note">vs {previous} previously</span>
    </div>
  );
}

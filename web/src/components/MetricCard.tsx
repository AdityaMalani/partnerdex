import { useMemo, useState } from 'react';
import type { MetricResponse } from '../api';
import { formatValue } from '../format';
import type { CardSpec } from '../pages';
import {
  BarPlot,
  DataTable,
  LinePlot,
  ShareTable,
  StackedAreaPlot,
  useChartData,
  type ChartSeries,
} from './Chart';

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
 */
export function MetricCard({
  spec,
  metric,
}: {
  spec: CardSpec;
  metric: MetricResponse | undefined;
}) {
  const [showTable, setShowTable] = useState(false);

  const breakdown = spec.breakdown ? metric?.series ?? [] : [];

  // A table identifies its rows and columns by their headers, so the four-slot
  // cap that keeps a plot legible does not apply — it would silently drop the
  // very entries the reader asked to see.
  const isTable = spec.plot === 'table';
  const isShare = spec.plot === 'share';
  const isFigures = isTable || isShare;

  const series = useMemo<ChartSeries[]>(() => {
    if (breakdown.length > 0) {
      const shown = isFigures ? breakdown : breakdown.slice(0, SLOT.length);
      return shown.map((item, index) => ({
        key: item.key,
        name: item.name,
        color: SLOT[index % SLOT.length]!,
      }));
    }
    return [{ key: 'value', name: spec.label, color: spec.tone ? TONE[spec.tone] : SLOT[0]! }];
  }, [breakdown, isFigures, spec.label, spec.tone]);

  const total = useMemo(
    () => [
      {
        key: 'value',
        data: (metric?.timeSeries ?? []).map((point) => ({
          date: point.periodStart,
          value: point.value,
        })),
      },
    ],
    [metric],
  );
  const data = useChartData(breakdown.length > 0 ? breakdown : total);

  if (!metric) {
    return (
      <section className={spec.full ? 'card full' : 'card'}>
        <h2 className="card-label">{spec.label}</h2>
        <div className="card-value">—</div>
        <div className="card-delta">Not available</div>
      </section>
    );
  }

  const format = metric.format;
  const currency = metric.currency;
  const interval = metric.timeSeriesInterval;
  const height = spec.full ? 260 : 150;

  const plot =
    isFigures ? null : spec.plot === 'area' ? (
      <StackedAreaPlot
        data={data}
        series={series}
        format={format}
        currency={currency}
        interval={interval}
        height={height}
      />
    ) : spec.plot === 'bar' ? (
      <BarPlot
        data={data}
        series={series}
        format={format}
        currency={currency}
        interval={interval}
        height={height}
      />
    ) : (
      <LinePlot
        data={data}
        series={series}
        format={format}
        currency={currency}
        interval={interval}
        height={height}
      />
    );

  return (
    <section className={spec.full ? 'card full' : 'card'}>
      <div className="card-head">
        <div>
          <h2 className="card-label">{spec.label}</h2>
          {spec.subtitle ? <p className="card-subtitle">{spec.subtitle}</p> : null}
        </div>
        {/* Multi-series cards owe the reader a table: past two series, colour
            alone stops being a reliable way to pick one out. A card that is
            already a table has nowhere to toggle to. */}
        {series.length > 1 && !isFigures ? (
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

      {spec.comparisonNote ? (
        <div className="card-delta">{spec.comparisonNote}</div>
      ) : (
        <Comparison metric={metric} invert={spec.invertDelta ?? false} />
      )}

      {series.length > 1 && !isFigures ? (
        <div className="legend">
          {series.map((item) => (
            <span className="legend-item" key={item.key}>
              <span className="legend-swatch" style={{ background: item.color }} />
              {item.name}
            </span>
          ))}
        </div>
      ) : null}

      {isShare ? (
        <ShareTable
          series={series}
          data={data}
          format={format}
          currency={currency}
          partLabel={spec.share?.partLabel ?? 'Part'}
          totalLabel={spec.share?.totalLabel ?? 'Total'}
        />
      ) : showTable || isTable ? (
        <DataTable
          series={series}
          data={data}
          format={format}
          currency={currency}
          interval={interval}
          ledger={spec.ledger}
        />
      ) : (
        plot
      )}
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

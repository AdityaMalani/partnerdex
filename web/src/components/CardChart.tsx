/**
 * Everything on a metric card that needs the charting library, behind one
 * default export so the card can `lazy()` it.
 *
 * The split is worth a file of its own for two reasons. The charting library is
 * by some distance the largest thing the dashboard ships, and most of the
 * dashboard never draws a chart at all — the customer list, the settings pages
 * and the whole affiliate section are tables and forms, and used to pay for a
 * plotting library to render them. And on the pages that do draw charts, the
 * figure and its comparison are the part a reader looks at first: they paint
 * from the card's own module while the plot underneath them is still arriving.
 */

import { useMemo } from 'react';
import type { MetricResponse } from '../api';
import type { CardSpec } from '../pages';
import {
  BarPlot,
  DataTable,
  LinePlot,
  StackedAreaPlot,
  useChartData,
  type ChartSeries,
} from './Chart';

export default function CardChart({
  spec,
  metric,
  series,
  breakdown,
  showTable,
  height,
}: {
  spec: CardSpec;
  metric: MetricResponse;
  series: ChartSeries[];
  /** The component breakdown, when the card draws one; otherwise empty. */
  breakdown: MetricResponse['series'];
  showTable: boolean;
  height: number;
}) {
  // Memoized because `useChartData` keys its own work on the identity of what it
  // is given: a fresh array here would rebuild every row on every render of the
  // page, including renders that have nothing to do with this card.
  const shaped = useMemo(
    () =>
      breakdown && breakdown.length > 0
        ? breakdown
        : [
            {
              key: 'value',
              data: metric.timeSeries.map((point) => ({
                date: point.periodStart,
                value: point.value,
              })),
            },
          ],
    [breakdown, metric],
  );
  const data = useChartData(shaped);

  const format = metric.format;
  const currency = metric.currency;
  const interval = metric.timeSeriesInterval;

  if (showTable) {
    return (
      <DataTable
        series={series}
        data={data}
        format={format}
        currency={currency}
        interval={interval}
      />
    );
  }

  const props = { data, series, format, currency, interval, height };

  if (spec.plot === 'area') return <StackedAreaPlot {...props} />;
  if (spec.plot === 'bar') return <BarPlot {...props} />;
  return <LinePlot {...props} />;
}

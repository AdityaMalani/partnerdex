import { formatValue } from '../format';

/**
 * Monthly earnings, as a small bar chart.
 *
 * Bars rather than a line: a month's commission is a discrete bucket, not a
 * reading taken along a continuum, and at this size a bar's height is easier to
 * compare than a line's slope. One series, so it wears the categorical system's
 * first slot and needs no legend — the label above it names the series.
 *
 * The API returns only months that had a commission, so the gaps are filled
 * here. Drawing the returned rows side by side would space a two-year-old month
 * one bar away from last month and misstate the trend.
 */

const MONTH = /^(\d{4})-(\d{2})/;

/** `2026-06` → `Jun 26`. */
function label(month: string): string {
  const parts = MONTH.exec(month);
  if (!parts) return month;
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, 1));
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

/** Every month from the first to the last, zero where nothing was earned. */
function fill(points: Array<{ month: string; amount: number }>): Array<{
  month: string;
  amount: number;
}> {
  const known = new Map(points.map((point) => [point.month.slice(0, 7), point.amount]));
  const first = MONTH.exec(points[0]?.month ?? '');
  const last = MONTH.exec(points[points.length - 1]?.month ?? '');
  if (!first || !last) return points;

  const out: Array<{ month: string; amount: number }> = [];
  const cursor = new Date(Date.UTC(Number(first[1]), Number(first[2]) - 1, 1));
  const end = Date.UTC(Number(last[1]), Number(last[2]) - 1, 1);
  // Twelve is the server's own limit, so this can never run away.
  while (cursor.getTime() <= end && out.length < 24) {
    const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ month: key, amount: known.get(key) ?? 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

const WIDTH = 260;
const HEIGHT = 52;
/** The share of each month's slot the bar actually fills; the rest is the gap. */
const FILL = 0.55;

/** `YYYY-MM` for right now, in UTC — the same clock the server grouped by. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A bar with its top two corners rounded, sitting on the baseline. */
function bar(x: number, width: number, height: number): string {
  const top = HEIGHT - height;
  const radius = Math.min(2, width / 2, height);
  return [
    `M${x} ${HEIGHT}`,
    `V${top + radius}`,
    `A${radius} ${radius} 0 0 1 ${x + radius} ${top}`,
    `H${x + width - radius}`,
    `A${radius} ${radius} 0 0 1 ${x + width} ${top + radius}`,
    `V${HEIGHT}`,
    'Z',
  ].join(' ');
}

export function EarningsSparkline({
  byMonth,
  currency,
}: {
  byMonth: Array<{ month: string; amount: number }>;
  currency: string;
}) {
  // Two bars is a comparison, not a trend, and a chart of one is a number with
  // decoration. Below three months the tiles above already say it better.
  if (byMonth.length < 3) return null;

  const points = fill(byMonth);
  const peak = Math.max(...points.map((point) => point.amount));
  if (!(peak > 0)) return null;

  const step = WIDTH / points.length;
  const width = Math.max(step * FILL, 1);
  const inset = (step - width) / 2;
  // The month in progress is not a month that earned less. Drawn lighter and
  // said in the tooltip, because a half-finished bar at the right-hand end is
  // read as a collapse in earnings by everybody who does not know the date.
  const running = currentMonth();
  const money = (value: number) => formatValue(value, 'money', currency || 'USD');

  return (
    <figure className="portal-spark">
      <figcaption className="portal-spark-head">
        <span className="stat-label">Earnings by month</span>
        <span className="portal-spark-peak">Peak {money(peak)}</span>
      </figcaption>
      <svg
        className="portal-spark-plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Monthly earnings from ${label(points[0]!.month)} to ${label(
          points[points.length - 1]!.month,
        )}, peaking at ${money(peak)}.`}
      >
        {points.map((point, index) => {
          // A month that earned something never renders as nothing: a hairline
          // is the difference between "small" and "none", and they are not the
          // same fact about somebody's money.
          const height = point.amount > 0 ? Math.max((point.amount / peak) * HEIGHT, 1.5) : 0;
          const partial = point.month === running;
          return (
            <path
              key={point.month}
              className={[
                'portal-spark-bar',
                point.amount > 0 ? '' : 'empty',
                partial ? 'partial' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              d={bar(index * step + inset, width, Math.max(height, 1))}
            >
              <title>
                {`${label(point.month)}: ${money(point.amount)}${partial ? ' (month to date)' : ''}`}
              </title>
            </path>
          );
        })}
      </svg>
      <div className="portal-spark-axis">
        <span>{label(points[0]!.month)}</span>
        <span>{label(points[points.length - 1]!.month)}</span>
      </div>
    </figure>
  );
}

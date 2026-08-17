import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTOMATED_LAG_CEILING_DAYS,
  breakdownByPeriod,
  classifyOrigin,
  cohortBenchmarks,
  compareAttributions,
  estimateByBenchmark,
  lagDays,
  mergeAttributionChunks,
  originEvidence,
  shopKey,
  valueAttributions,
  type ClassifiedReferral,
  type MantleReferral,
  type MergedAttribution,
} from '../src/affiliates/backfillCompare.js';
import type { Attribution } from '../src/affiliates/ga4Attribution.js';

/**
 * The historical diff, minus BigQuery and minus the database.
 *
 * What is worth asserting here is not that the arithmetic adds up. It is the
 * handful of places where a wrong answer is *plausible* — where the count would
 * still look reasonable, so nobody would go looking:
 *
 *   - a reinstall counted as two referrals, paying two affiliates for one
 *     merchant
 *   - a manual assignment counted as a pipeline miss, which would make our
 *     pipeline look broken and invite someone to "fix" it into over-attributing
 *   - a merchant matched across apps, turning two legitimate referrals on two
 *     programs into a fabricated disagreement
 *   - the valuation key drifting from the key the caller sums gross by, which
 *     silently values everything at zero
 */

const STOQ = '1000001';
const FILEMONK = '1000002';

function ga4(overrides: Partial<Attribution> = {}): Attribution {
  return {
    appId: STOQ,
    handle: 'testhdl1',
    shopId: '99999999999',
    shopDomain: 'example.myshopify.com',
    clickedAt: '2026-07-01T00:00:00.000Z',
    installedAt: '2026-07-02T00:00:00.000Z',
    anonymousId: '111111111.1700000000',
    ...overrides,
  };
}

function merged(overrides: Partial<MergedAttribution> = {}): MergedAttribution {
  return { ...ga4(), installCount: 1, ...overrides };
}

function mantle(overrides: Partial<MantleReferral> = {}): ClassifiedReferral {
  return classifyOrigin({
    attributionId: 'a1',
    affiliateId: 'aff-1',
    affiliateName: 'Someone',
    programId: 'prog-1',
    appId: STOQ,
    handle: 'testhdl1',
    shopId: '99999999999',
    shopDomain: 'example.myshopify.com',
    referredAt: '2026-07-02T00:00:00.000Z',
    createdAt: '2026-07-02T00:00:03.000Z',
    hasListingPageView: true,
    deletedAt: null,
    ...overrides,
  });
}

describe('merging monthly chunks', () => {
  it('keeps one row when the same install appears in two overlapping chunks', () => {
    const result = mergeAttributionChunks([[ga4()], [ga4()]]);
    assert.equal(result.attributions.length, 1);
    assert.equal(result.reinstalledShops, 0);
    assert.equal(result.attributions[0]?.installCount, 1);
  });

  it('credits the first install when a merchant reinstalls', () => {
    const first = ga4({ installedAt: '2025-02-01T00:00:00.000Z', handle: 'aaaaaaaa' });
    const second = ga4({ installedAt: '2026-02-01T00:00:00.000Z', handle: 'bbbbbbbb' });
    // Deliberately out of order: chunks arrive per app, and a caller is free to
    // hand them over in any sequence.
    const result = mergeAttributionChunks([[second], [first]]);
    assert.equal(result.attributions.length, 1);
    assert.equal(result.attributions[0]?.handle, 'aaaaaaaa');
    assert.equal(result.attributions[0]?.installCount, 2);
    assert.equal(result.reinstalledShops, 1);
    assert.deepEqual(result.reinstalls.map((row) => row.laterHandle), ['bbbbbbbb']);
  });

  it('does not report a conflict when the reinstall credits the same affiliate', () => {
    const result = mergeAttributionChunks([
      [ga4({ installedAt: '2025-02-01T00:00:00.000Z' })],
      [ga4({ installedAt: '2026-02-01T00:00:00.000Z' })],
    ]);
    assert.equal(result.reinstalledShops, 1);
    assert.equal(result.reinstalls.length, 0);
  });

  it('keeps the same shop id on two apps apart', () => {
    const result = mergeAttributionChunks([
      [ga4({ appId: STOQ }), ga4({ appId: FILEMONK, handle: 'bbbbbbbb' })],
    ]);
    assert.equal(result.attributions.length, 2);
    assert.equal(result.reinstalledShops, 0);
  });
});

describe('classifying where a Mantle referral came from', () => {
  it('calls a row with a listing page view automated, whatever its lag', () => {
    // The page view is a stored fact and outranks the timestamps. A row that
    // points at the GA4 view it was built from was built by the pipeline.
    const row = mantle({
      hasListingPageView: true,
      referredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    assert.equal(row.origin, 'automated');
    assert.equal(lagDays(row), 2);
  });

  it('calls a backdated row with no page view manual', () => {
    const row = mantle({
      hasListingPageView: false,
      referredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(row.origin, 'manual');
    assert.equal(lagDays(row), 31);
  });

  it('refuses to guess when there is no page view and no lag', () => {
    // 35 real rows look like this. Calling them manual would inflate the count
    // of assignments no pipeline should reproduce; calling them automated would
    // inflate the count of things ours missed. Neither is known.
    const row = mantle({
      hasListingPageView: false,
      referredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:01.000Z',
    });
    assert.equal(row.origin, 'uncertain');
  });

  it('counts the grey band the lag signal alone cannot sort', () => {
    const rows = [
      mantle({ hasListingPageView: true }),
      mantle({
        attributionId: 'a2',
        hasListingPageView: false,
        referredAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-06T00:00:00.000Z',
      }),
    ];
    const evidence = originEvidence(rows);
    assert.equal(evidence.automated, 1);
    assert.equal(evidence.uncertain, 1);
    assert.equal(evidence.inTheGreyBand, 1);
    assert.ok(evidence.maxLagAutomated <= AUTOMATED_LAG_CEILING_DAYS);
  });
});

describe('diffing GA4 against Mantle', () => {
  it('agrees when both credit the same affiliate for the same merchant', () => {
    const result = compareAttributions([merged()], [mantle()]);
    assert.equal(result.matched.length, 1);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.ga4Only.length, 0);
    assert.equal(result.mantleOnly.length, 0);
  });

  it('reports a disagreement rather than picking a side', () => {
    const result = compareAttributions([merged({ handle: 'aaaaaaaa' })], [mantle()]);
    assert.equal(result.disagreements.length, 1);
    assert.equal(result.disagreements[0]?.ga4Handle, 'aaaaaaaa');
    assert.equal(result.disagreements[0]?.mantleHandle, 'testhdl1');
    // A disagreement is not also a miss on either side.
    assert.equal(result.ga4Only.length, 0);
    assert.equal(result.mantleOnly.length, 0);
  });

  it('matches on the domain when the shop ids differ', () => {
    // GA4 records `shop_id` from the install event and Mantle records
    // `platformId`; they are the same number today, but the domain is the only
    // key the export guarantees.
    const result = compareAttributions(
      [merged({ shopId: '999' })],
      [mantle({ shopId: '111' })],
    );
    assert.equal(result.matched.length, 1);
  });

  it('does not match the same merchant across two apps', () => {
    const result = compareAttributions([merged({ appId: FILEMONK })], [mantle({ appId: STOQ })]);
    assert.equal(result.matched.length, 0);
    assert.equal(result.disagreements.length, 0);
    assert.equal(result.ga4Only.length, 1);
    assert.equal(result.mantleOnly.length, 1);
    // ...but it says so, so a reader does not read it as a genuine miss.
    assert.equal(result.crossApp, 1);
  });

  it('separates Mantle rows by origin so manual assignments are not read as misses', () => {
    const manual = mantle({
      attributionId: 'a2',
      shopId: '222',
      shopDomain: 'manual.myshopify.com',
      hasListingPageView: false,
      referredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const result = compareAttributions([merged()], [mantle(), manual]);
    assert.equal(result.matched.length, 1);
    assert.deepEqual(
      result.mantleOnly.map((row) => row.origin),
      ['manual'],
    );
  });
});

describe('valuing what was missed', () => {
  it('pays 20% of gross on subscription revenue only', () => {
    const gross = new Map([[shopKey(STOQ, '99999999999'), 100]]);
    const valuation = valueAttributions([merged()], gross);
    assert.equal(valuation.totalGross, 100);
    assert.equal(valuation.totalCommission, 20);
    assert.equal(valuation.earning, 1);
  });

  it('values a merchant with no synced transactions at zero rather than guessing', () => {
    const valuation = valueAttributions([merged()], new Map());
    assert.equal(valuation.totalCommission, 0);
    assert.equal(valuation.earning, 0);
  });

  it('keys on app and shop together, so one app cannot claim the other app revenue', () => {
    const gross = new Map([[shopKey(STOQ, '99999999999'), 100]]);
    const valuation = valueAttributions([merged({ appId: FILEMONK })], gross);
    assert.equal(valuation.totalCommission, 0);
  });

  it('rounds each commission to cents before summing', () => {
    const gross = new Map([
      [shopKey(STOQ, '1'), 0.11],
      [shopKey(STOQ, '2'), 0.11],
    ]);
    const valuation = valueAttributions(
      [merged({ shopId: '1' }), merged({ shopId: '2' })],
      gross,
    );
    // 0.022 each, rounded to 0.02, so 0.04 — not 0.044 and not 0.05.
    assert.equal(valuation.totalCommission, 0.04);
  });
});

describe('estimating from Mantle own ledger, when the transactions cannot be read', () => {
  const cohort = [
    mantle({ attributionId: 'p1', referredAt: '2024-08-01T00:00:00.000Z' }),
    mantle({ attributionId: 'p2', referredAt: '2024-09-01T00:00:00.000Z' }),
    mantle({ attributionId: 'p3', referredAt: '2024-10-01T00:00:00.000Z' }),
  ];

  it('counts a referral that earned nothing as a zero, not as missing', () => {
    // Dropping the zeroes would price every miss as a guaranteed conversion,
    // which is the easiest way to over-state the estimate.
    const earned = new Map([
      ['p1', 0],
      ['p2', 30],
      ['p3', 60],
    ]);
    const [benchmark] = cohortBenchmarks(cohort, earned);
    assert.equal(benchmark?.referrals, 3);
    assert.equal(benchmark?.meanCommission, 30);
    assert.equal(benchmark?.medianCommission, 30);
  });

  it('treats a referral absent from the ledger as having earned nothing', () => {
    const [benchmark] = cohortBenchmarks(cohort, new Map([['p3', 90]]));
    assert.equal(benchmark?.meanCommission, 30);
    assert.equal(benchmark?.medianCommission, 0);
  });

  it('prices each miss against its own app and cohort year', () => {
    const benchmarks = cohortBenchmarks(
      [...cohort, mantle({ attributionId: 'f1', appId: FILEMONK, referredAt: '2024-08-01T00:00:00.000Z' })],
      new Map([
        ['p1', 0],
        ['p2', 30],
        ['p3', 60],
        ['f1', 4],
      ]),
    );
    const estimate = estimateByBenchmark(
      [
        merged({ shopId: '1', installedAt: '2024-11-01T00:00:00.000Z' }),
        merged({ shopId: '2', appId: FILEMONK, installedAt: '2024-11-01T00:00:00.000Z' }),
      ],
      benchmarks,
    );
    assert.equal(estimate.low, 34); // 30 median + 4 median
    assert.equal(estimate.high, 34); // 30 mean + 4 mean
    assert.equal(estimate.unpriced, 0);
  });

  it('refuses to price a cohort it has no comparable for', () => {
    const benchmarks = cohortBenchmarks(cohort, new Map([['p1', 30]]));
    const estimate = estimateByBenchmark(
      [merged({ installedAt: '2026-01-01T00:00:00.000Z' })],
      benchmarks,
    );
    assert.equal(estimate.low, 0);
    assert.equal(estimate.high, 0);
    assert.equal(estimate.unpriced, 1);
  });
});

describe('breaking the diff down by period', () => {
  it('buckets each side by its own clock', () => {
    const result = compareAttributions(
      [merged({ installedAt: '2024-06-01T00:00:00.000Z' })],
      [
        mantle({ referredAt: '2024-06-01T00:00:00.000Z', createdAt: '2024-06-01T00:00:01.000Z' }),
        mantle({
          attributionId: 'a3',
          shopId: '333',
          shopDomain: 'other.myshopify.com',
          referredAt: '2025-01-01T00:00:00.000Z',
          createdAt: '2025-03-01T00:00:00.000Z',
          hasListingPageView: false,
        }),
      ],
    );
    const periods = breakdownByPeriod(result);
    assert.deepEqual(
      periods.map((period) => [period.period, period.matched, period.mantleOnlyManual]),
      [
        ['2024', 1, 0],
        ['2025', 0, 1],
      ],
    );
  });
});

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../src/server/index.js';
import { getDb } from '../src/db/index.js';
import { funnelReport, FUNNEL_STEPS } from '../src/metrics/reports/funnel.js';
import { handlePattern, resolveUserKey, syncListingEvents } from '../src/bigquery/ingest.js';
import { useBigQueryConstructor } from '../src/bigquery/client.js';
import {
  BigQueryError,
  describe as describeConnection,
  parseServiceAccount,
  readConnection,
  resolveAppSource,
  saveAppSource,
  saveConnection,
} from '../src/bigquery/connection.js';
import { ADD_APP_CLICK_EVENT, LISTING_VIEW_EVENT } from '../src/bigquery/events.js';
import { conversionsFor } from '../web/src/components/Funnel.js';
import { APP_ID, resetEnvironment, seed, seedForApp } from './helpers.js';

/**
 * The funnel, and the seam down the middle of it.
 *
 * What is worth asserting here is not that a count comes back per step — it is the
 * handful of places the report could lie quietly:
 *
 *   - an unmeasurable step reported as zero, which reads as "nobody visited"
 *   - a conversion divided by nothing, reported as 0%
 *   - a trial conversion credited to the month the money landed rather than the
 *     month the trial began, which would put conversions in a column with no
 *     trials in it
 *   - a review landing in the column before its own, because the listing
 *     publishes a bare date that sorts ahead of an ISO instant
 *   - a review the matcher could not attach to a shop, or one that has since
 *     been taken down, dropped out of a period it really happened in
 *   - a service-account key leaking back out through the settings API
 */

const VIEW = 'listing_view';
const CLICK = 'add_app_click';

const KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'demo',
  private_key_id: 'abcdef0123456789',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----',
  client_email: 'partnerdex@demo.iam.gserviceaccount.com',
});

/** March 2024: three merchants arrive, two trial, one converts. */
function seedMarch() {
  return seed(
    [
      // Trials, at nine days from activation to first payment.
      {
        chargeRef: '1',
        shopId: '10',
        amount: 50,
        activatedAt: '2024-03-04T00:00:00Z',
        firstSaleAt: '2024-03-13T00:00:00Z',
      },
      // A trial that ended before any payment. The billing date a fortnight out
      // is what makes it a trial: every real activation carries one, and a
      // cancellation on its own says nothing about whether a trial was running.
      {
        chargeRef: '2',
        shopId: '11',
        amount: 50,
        activatedAt: '2024-03-05T00:00:00Z',
        billingOn: '2024-03-19T00:00:00Z',
        churnedAt: '2024-03-09T00:00:00Z',
      },
      // Paid on the spot: no trial at all, so it appears at neither trial step.
      {
        chargeRef: '3',
        shopId: '12',
        amount: 50,
        activatedAt: '2024-03-06T00:00:00Z',
        firstSaleAt: '2024-03-06T00:00:00Z',
      },
    ],
    {
      installs: [
        { shopId: '10', at: '2024-03-02T00:00:00Z' },
        { shopId: '11', at: '2024-03-03T00:00:00Z' },
        { shopId: '12', at: '2024-03-04T00:00:00Z' },
        // Installed but never subscribed — the drop-off from step 3 to step 4.
        { shopId: '13', at: '2024-03-07T00:00:00Z' },
      ],
    },
  );
}

/** `visitor` becomes the resolved `user_key`, which is what the funnel counts. */
function addListingEvents(rows: Array<{ type: string; at: string; visitor: string }>) {
  const db = getDb();
  const statement = db.prepare(
    `INSERT INTO listing_events (event_id, app_id, type, occurred_at, user_key, anonymous_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  rows.forEach((row, index) => {
    statement.run(
      `${APP_ID}:${index}:${row.visitor}:${row.at}`,
      APP_ID,
      row.type,
      row.at,
      row.visitor,
      row.visitor,
    );
  });
}

/** A row from before `user_key` existed, to prove the read-time fallback. */
function addLegacyListingEvent(row: { type: string; at: string; visitor: string }) {
  getDb()
    .prepare(
      `INSERT INTO listing_events (event_id, app_id, type, occurred_at, user_key, anonymous_id)
       VALUES (?, ?, ?, ?, '', ?)`,
    )
    .run(`legacy:${row.visitor}:${row.at}`, APP_ID, row.type, row.at, row.visitor);
}

/**
 * A crawled listing, whether or not it found anything.
 *
 * A snapshot row is what the ingest writes on every successful crawl, and it is
 * what the funnel reads to tell "nobody reviewed" from "nobody looked". Seeded
 * on its own so a listing with no reviews can be tested.
 */
function addReviewCrawl(appId = APP_ID, capturedAt = '2024-01-15T00:00:00.000Z') {
  getDb()
    .prepare(
      `INSERT INTO app_review_snapshots (app_id, captured_at, rating_value, rating_count)
       VALUES (?, ?, ?, ?)`,
    )
    .run(appId, capturedAt, 4.8, 12);
}

/** `postedOn` is a bare date, exactly as the listing publishes it. */
function addReviews(
  rows: Array<{ id: string; postedOn: string; appId?: string; shopId?: string; removedAt?: string }>,
) {
  const statement = getDb().prepare(
    `INSERT INTO app_reviews (
       review_id, app_id, rating, posted_on, body, store_name, shop_id,
       match_method, content_hash, first_seen_at, last_seen_at, removed_at
     ) VALUES (?, ?, 5, ?, 'Good app', 'Acme', ?, ?, '', ?, ?, ?)`,
  );
  for (const row of rows) {
    statement.run(
      row.id,
      row.appId ?? APP_ID,
      row.postedOn,
      row.shopId ?? '',
      row.shopId ? 'auto' : 'none',
      '2024-01-15T00:00:00.000Z',
      '2024-01-15T00:00:00.000Z',
      row.removedAt ?? null,
    );
  }
}

const MARCH = { period: 'custom', start: '2024-03-01', end: '2024-03-31' };
const NOW = new Date('2024-06-01T00:00:00Z');

const stepIndex = (key: string) => FUNNEL_STEPS.findIndex((step) => step.key === key);

before(() => {
  resetEnvironment();
});

beforeEach(() => {
  resetEnvironment();
});

describe('funnel: the Partner API steps', () => {
  it('counts installs, trials and conversions in the period they belong to', () => {
    seedMarch();
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.buckets.length, 1);
    const counts = report.buckets[0]!.counts;

    assert.equal(counts[stepIndex('installed')], 4, 'four shops installed in March');
    assert.equal(counts[stepIndex('trial_started')], 2, 'two of them started a trial');
    assert.equal(counts[stepIndex('trial_converted')], 1, 'one of those trials converted');
  });

  it('keeps a merchant who paid on the spot out of the trial steps, and says so', () => {
    seedMarch();
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.meta.directToPaid, 1);
    assert.ok(
      report.meta.notes.some((note) => note.includes('straight to paid')),
      'the note explaining the gap between installs and trials must be present',
    );
  });

  it('credits a conversion to the period the trial started in, not the period it paid', () => {
    // Activated on the last day of March, paid in April. The conversion belongs
    // to March's cohort; April started no trials and must convert none.
    seed([
      {
        chargeRef: '9',
        shopId: '20',
        amount: 50,
        activatedAt: '2024-03-30T00:00:00Z',
        firstSaleAt: '2024-04-08T00:00:00Z',
      },
    ]);

    const report = funnelReport(
      { period: 'custom', start: '2024-03-01', end: '2024-04-30', granularity: 'month' },
      { now: NOW },
    );

    const converted = stepIndex('trial_converted');
    const started = stepIndex('trial_started');
    assert.equal(report.buckets[0]!.counts[started], 1, 'March started the trial');
    assert.equal(report.buckets[0]!.counts[converted], 1, 'March owns the conversion');
    assert.equal(report.buckets[1]!.counts[started], 0);
    assert.equal(report.buckets[1]!.counts[converted], 0, 'April must not claim it');
  });
});

describe('funnel: what cannot be measured', () => {
  it('reports the listing steps as null, never zero, with no BigQuery connection', () => {
    seedMarch();
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    const counts = report.buckets[0]!.counts;

    assert.equal(counts[stepIndex('listing_view')], null);
    assert.equal(counts[stepIndex('add_app_click')], null);
    assert.equal(report.meta.bigqueryConnected, false);
    assert.ok(report.meta.notes.some((note) => note.includes('BigQuery is not connected')));
  });

  it('still reports null once connected but before any traffic has been collected', () => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(report.buckets[0]!.counts[stepIndex('listing_view')], null);
    assert.equal(report.meta.bigqueryConnected, true);
    assert.equal(report.meta.appsWithListingTraffic, 0);
  });

  it('reports a real zero once the app is instrumented and simply had no visitors', () => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
    // Traffic exists for the app, but in February rather than in the window.
    addListingEvents([{ type: VIEW, at: '2024-02-10T00:00:00Z', visitor: 'a' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(
      report.buckets[0]!.counts[stepIndex('listing_view')],
      0,
      'an instrumented app with a quiet month reports zero, not null',
    );
  });

  it('gives no conversion where the step above it is zero', () => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
    addListingEvents([{ type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    const bucket = report.buckets[0]!;

    assert.equal(bucket.counts[stepIndex('add_app_click')], 0);
    assert.equal(
      bucket.conversion[stepIndex('installed')],
      null,
      'four installs over zero clicks has no finite rate, and 0% would be a lie',
    );
  });
});

describe('funnel: visitors and conversion', () => {
  beforeEach(() => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
  });

  it('counts distinct browsers rather than events', () => {
    addListingEvents([
      { type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' },
      { type: VIEW, at: '2024-03-11T00:00:00Z', visitor: 'a' },
      { type: VIEW, at: '2024-03-12T00:00:00Z', visitor: 'b' },
      { type: CLICK, at: '2024-03-12T01:00:00Z', visitor: 'b' },
    ]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    const counts = report.buckets[0]!.counts;

    assert.equal(counts[stepIndex('listing_view')], 2, 'one visitor returning is still one');
    assert.equal(counts[stepIndex('add_app_click')], 1);
    assert.equal(report.buckets[0]!.conversion[stepIndex('add_app_click')], 50);
  });

  it('names the apps whose visitors are missing when only some are instrumented', () => {
    // One GA4 property covers one listing. Reporting across an app that has it
    // and an app that does not puts one app's visitors above two apps'
    // installs, and the rate into "Installed" reads over 100%.
    //
    // Rebuilt rather than extended: the scope is what is being varied, and it
    // is fixed at process start from PARTNER_APP_IDS.
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '7788', '40');
    saveConnection({ projectId: 'demo', credentials: KEY });
    addListingEvents([{ type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.meta.appsInScope, 2);
    assert.equal(report.meta.appsWithListingTraffic, 1);
    assert.deepEqual(report.meta.appsWithoutListingTraffic, ['App 222']);
    assert.ok(
      report.meta.warnings.some((warning) => warning.includes('App 222')),
      'the app missing from the top of the funnel must be named, not just counted',
    );
  });

  it('says nothing about coverage when every app in view is instrumented', () => {
    addListingEvents([{ type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' }]);
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.deepEqual(report.meta.appsWithoutListingTraffic, []);
    assert.equal(
      report.meta.warnings.some((warning) => warning.includes('cover')),
      false,
    );
  });

  it('warns rather than caps when a step exceeds the one above it', () => {
    // One visitor clicked; four shops installed. GA4 under-counts, and the
    // report must say so instead of quietly capping installs at one.
    addListingEvents([
      { type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' },
      { type: CLICK, at: '2024-03-10T01:00:00Z', visitor: 'a' },
    ]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(report.totals.counts[stepIndex('installed')], 4, 'installs are never capped');
    assert.ok(
      report.meta.warnings.some((warning) => warning.includes('Installed')),
      'the non-monotonic step must be reported',
    );
  });
});

/**
 * The review step, and the three ways it is unlike the five above it.
 *
 * It comes from a third store, it is counted in events rather than in people,
 * and it is not a subset of the step before it. Each of those is a way the
 * report could quietly mislead, so each has a test.
 */
describe('funnel: left a review', () => {
  it('counts reviews posted in the period, from the crawled listing', () => {
    seedMarch();
    addReviewCrawl();
    addReviews([
      { id: 'r1', postedOn: '2024-03-05' },
      { id: 'r2', postedOn: '2024-03-20' },
      // February, and so in neither the March column nor the March total.
      { id: 'r3', postedOn: '2024-02-28' },
    ]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.buckets[0]!.counts[stepIndex('review_posted')], 2);
    assert.equal(report.totals.counts[stepIndex('review_posted')], 2);
  });

  it('reports the step as null, never zero, when no listing has been crawled', () => {
    seedMarch();
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(
      report.buckets[0]!.counts[stepIndex('review_posted')],
      null,
      'a listing nobody has read is not a listing nobody reviewed',
    );
    assert.equal(report.totals.counts[stepIndex('review_posted')], null);
    assert.equal(report.meta.appsWithReviewCrawl, 0);
    assert.equal(report.meta.reviewsCrawledFrom, null);
    assert.ok(report.meta.notes.some((note) => note.includes('cannot be measured')));
  });

  it('reports a real zero once the listing has been crawled and nobody reviewed', () => {
    seedMarch();
    addReviewCrawl();

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(
      report.buckets[0]!.counts[stepIndex('review_posted')],
      0,
      'a crawled listing with a quiet month reports zero, not null',
    );
    assert.equal(report.meta.reviewsCrawledFrom, '2024-01-15T00:00:00.000Z');
  });

  it('puts a review in its own column rather than the one before it', () => {
    // The listing publishes `2024-03-01`, which sorts *before*
    // `2024-03-01T00:00:00.000Z` lexically. Without both sides in the same form
    // the first review of a period falls into the period before it.
    seedMarch();
    addReviewCrawl();
    addReviews([{ id: 'r1', postedOn: '2024-03-01' }]);

    const report = funnelReport({ ...MARCH, granularity: 'day' }, { now: NOW });
    const first = report.buckets[0]!;

    assert.equal(first.periodStart, '2024-03-01T00:00:00.000Z');
    assert.equal(first.counts[stepIndex('review_posted')], 1);
    assert.equal(
      report.buckets.slice(1).reduce((sum, bucket) => sum + (bucket.counts[stepIndex('review_posted')] ?? 0), 0),
      0,
      'the review belongs to one day only',
    );
  });

  it('keeps a review that has since been taken down, and one with no shop', () => {
    // Removal is not attributable and not retroactive: the merchant did leave
    // the review in March. And a review the matcher could not place is still a
    // review — counting distinct shops would delete exactly those.
    seedMarch();
    addReviewCrawl();
    addReviews([
      { id: 'r1', postedOn: '2024-03-05', shopId: '10' },
      { id: 'r2', postedOn: '2024-03-06', removedAt: '2024-04-01T00:00:00.000Z' },
      { id: 'r3', postedOn: '2024-03-07' },
    ]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(report.buckets[0]!.counts[stepIndex('review_posted')], 3);
  });

  it('explains rather than warns when reviews exceed the step above', () => {
    // Six reviews against one trial conversion is the ordinary case, not a
    // fault: reviewers need not have trialled. A warning that fires every month
    // is a warning nobody reads.
    seedMarch();
    addReviewCrawl();
    addReviews(
      ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, index) => ({
        id,
        postedOn: `2024-03-1${index}`,
      })),
    );

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.totals.counts[stepIndex('trial_converted')], 1);
    assert.equal(report.totals.counts[stepIndex('review_posted')], 6, 'never capped');
    assert.equal(
      report.meta.warnings.some((warning) => warning.includes('Left a review')),
      false,
      'exceeding the step above is the normal case here, so it is not a warning',
    );
    assert.ok(
      report.meta.notes.some((note) => note.includes('have to have trialled or paid')),
      'the reason it exceeds must be on the response',
    );
  });

  it('says which apps have no crawled listing when only some do', () => {
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '7788', '40');
    addReviewCrawl();
    addReviews([{ id: 'r1', postedOn: '2024-03-05' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.meta.appsWithReviewCrawl, 1);
    assert.deepEqual(report.meta.appsWithoutReviewCrawl, ['App 222']);
    assert.ok(
      report.meta.warnings.some(
        (warning) => warning.includes('Left a review') && warning.includes('App 222'),
      ),
      'the app missing from the bottom of the funnel must be named',
    );
  });

  it('flags the periods that predate the first crawl', () => {
    seedMarch();
    // First looked at the listing in April, so a review deleted in March was
    // never on a page we read.
    addReviewCrawl(APP_ID, '2024-04-02T00:00:00.000Z');
    addReviews([{ id: 'r1', postedOn: '2024-03-05' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });

    assert.equal(report.buckets[0]!.counts[stepIndex('review_posted')], 1);
    assert.ok(
      report.meta.notes.some((note) => note.includes('2024-04-02')),
      'the horizon before which removals are invisible must be stated',
    );
  });
});

describe('funnel: granularity', () => {
  it('splits the range into daily, weekly and monthly columns', () => {
    seedMarch();
    const range = { period: 'custom', start: '2024-03-04', end: '2024-03-18' };

    const daily = funnelReport({ ...range, granularity: 'day' }, { now: NOW });
    const weekly = funnelReport({ ...range, granularity: 'week' }, { now: NOW });
    const monthly = funnelReport({ ...range, granularity: 'month' }, { now: NOW });

    // A bare `end` date means the whole of that day, so the span is inclusive:
    // the 4th to the 18th is fifteen columns, not fourteen.
    assert.equal(daily.buckets.length, 15);
    assert.equal(weekly.buckets.length, 3, 'two whole weeks plus the partial one');
    assert.equal(monthly.buckets.length, 1);
    assert.equal(daily.timeSeriesInterval, 'day');
  });

  it('collapses the previous seven days into a single column', () => {
    seedMarch();
    const report = funnelReport(
      // The range is deliberately something else, to prove it is ignored.
      { period: 'last_12_months', granularity: 'previous_7_days' },
      { now: NOW },
    );

    assert.equal(report.buckets.length, 1);
    assert.equal(report.granularity, 'previous_7_days');
    const span = new Date(report.periodEnd).getTime() - new Date(report.periodStart).getTime();
    assert.equal(span, 7 * 86_400_000);
    assert.equal(report.buckets[0]!.periodStart, report.periodStart);
    assert.equal(report.buckets[0]!.periodEnd, report.periodEnd);
  });

  it('rejects a granularity it does not know', () => {
    seedMarch();
    assert.throws(
      () => funnelReport({ ...MARCH, granularity: 'fortnightly' }, { now: NOW }),
      /Unknown granularity/,
    );
  });
});

/**
 * Every step counts people, once each. These are the ways that quietly stops
 * being true: an enthusiastic visitor counted per visit, and a Total column
 * built by adding up distinct counts that do not add up.
 */
describe('funnel: one person, counted once', () => {
  beforeEach(() => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
  });

  it('counts a visitor once however many times they open the listing', () => {
    addListingEvents([
      { type: VIEW, at: '2024-03-10T09:00:00Z', visitor: 'ga:a' },
      { type: VIEW, at: '2024-03-10T10:00:00Z', visitor: 'ga:a' },
      { type: VIEW, at: '2024-03-10T11:00:00Z', visitor: 'ga:a' },
      { type: VIEW, at: '2024-03-10T12:00:00Z', visitor: 'ga:b' },
    ]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(
      report.buckets[0]!.counts[stepIndex('listing_view')],
      2,
      'four events from two people is two visitors',
    );
  });

  it('counts a visitor once across the range, not once per column', () => {
    // The same person on three different days. Each daily column sees one
    // visitor; the Total must still see one, not three.
    addListingEvents([
      { type: VIEW, at: '2024-03-10T09:00:00Z', visitor: 'ga:a' },
      { type: VIEW, at: '2024-03-11T09:00:00Z', visitor: 'ga:a' },
      { type: VIEW, at: '2024-03-12T09:00:00Z', visitor: 'ga:a' },
    ]);

    const report = funnelReport(
      { period: 'custom', start: '2024-03-10', end: '2024-03-12', granularity: 'day' },
      { now: NOW },
    );

    assert.deepEqual(
      report.buckets.map((bucket) => bucket.counts[stepIndex('listing_view')]),
      [1, 1, 1],
      'each day sees them once',
    );
    assert.equal(
      report.totals.counts[stepIndex('listing_view')],
      1,
      'and the range sees them once, not three times',
    );
  });

  it('counts a shop once across the range however often it reinstalled', () => {
    // Rebuilt from nothing: the shared fixture seeds four installers, and the
    // point here is one shop appearing twice.
    resetEnvironment();
    seed([], {
      installs: [
        { shopId: '10', at: '2024-03-02T00:00:00Z' },
        { shopId: '10', at: '2024-04-02T00:00:00Z' },
      ],
      uninstalls: [{ shopId: '10', at: '2024-03-20T00:00:00Z' }],
    });

    const report = funnelReport(
      { period: 'custom', start: '2024-03-01', end: '2024-04-30', granularity: 'month' },
      { now: NOW },
    );

    assert.deepEqual(
      report.buckets.map((bucket) => bucket.counts[stepIndex('installed')]),
      [1, 1],
      'each month saw an install',
    );
    assert.equal(
      report.totals.counts[stepIndex('installed')],
      1,
      'but only one shop installed across the range',
    );
  });

  /*
   * The two ways an install interval opens, and why only one is an install.
   *
   * A reopened shop took no action: it never saw the listing, so there is no
   * step 1 or 2 it could have come from, and counting it puts a numerator over
   * a denominator that cannot contain it. A merchant who uninstalled and came
   * back did choose the app again, and is an acquisition on the day they did.
   */
  it('leaves a reopened shop out of "Installed" and keeps the reinstall in', () => {
    resetEnvironment();
    seed([], {
      installs: [
        { shopId: '10', at: '2024-03-02T00:00:00Z' },
        // Shop 11 uninstalls in March and chooses the app again in April.
        { shopId: '11', at: '2024-03-03T00:00:00Z' },
        { shopId: '11', at: '2024-04-05T00:00:00Z' },
      ],
      uninstalls: [{ shopId: '11', at: '2024-03-20T00:00:00Z' }],
      // Shop 12 was installed before the range, went dark when the store closed,
      // and comes back in April without anybody choosing anything.
      closes: [{ shopId: '12', at: '2024-03-10T00:00:00Z' }],
      reopens: [{ shopId: '12', at: '2024-04-08T00:00:00Z' }],
    });

    const report = funnelReport(
      { period: 'custom', start: '2024-03-01', end: '2024-04-30', granularity: 'month' },
      { now: NOW },
    );

    assert.deepEqual(
      report.buckets.map((bucket) => bucket.counts[stepIndex('installed')]),
      [2, 1],
      'March has both installs; April has the reinstall and not the reopening',
    );
    assert.equal(
      report.totals.counts[stepIndex('installed')],
      2,
      'and across the range, two shops chose the app',
    );
    assert.equal(report.meta.reopenedNotCounted, 1, 'the reopening is reported, not dropped');
    assert.ok(
      report.meta.notes.some((note) => note.includes('reopened')),
      'and the reader is told why this runs below the installs figure elsewhere',
    );
  });

  it('still counts rows collected before user_key existed', () => {
    addLegacyListingEvent({ type: VIEW, at: '2024-03-10T09:00:00Z', visitor: 'ga:legacy' });
    addListingEvents([{ type: VIEW, at: '2024-03-11T09:00:00Z', visitor: 'ga:fresh' }]);

    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(
      report.buckets[0]!.counts[stepIndex('listing_view')],
      2,
      'an old row falls back to anonymous_id rather than dropping out',
    );
  });
});

describe('funnel: totals', () => {
  it('sums each step and divides once, rather than averaging the column rates', () => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
    // Day one: 100 viewers, 1 click. Day two: 1 viewer, 1 click. Averaging the
    // two rates gives 50.5%; the honest figure is 2 of 101.
    const rows: Array<{ type: string; at: string; visitor: string }> = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push({ type: VIEW, at: '2024-03-10T00:00:00Z', visitor: `v${i}` });
    }
    rows.push({ type: CLICK, at: '2024-03-10T01:00:00Z', visitor: 'v0' });
    rows.push({ type: VIEW, at: '2024-03-11T00:00:00Z', visitor: 'w0' });
    rows.push({ type: CLICK, at: '2024-03-11T01:00:00Z', visitor: 'w0' });
    addListingEvents(rows);

    const report = funnelReport(
      { period: 'custom', start: '2024-03-10', end: '2024-03-12', granularity: 'day' },
      { now: NOW },
    );

    assert.equal(report.totals.counts[stepIndex('listing_view')], 101);
    assert.equal(report.totals.counts[stepIndex('add_app_click')], 2);
    assert.equal(report.totals.conversion[stepIndex('add_app_click')], 1.98);
  });

  it('leaves the totals null wherever a step is unmeasurable', () => {
    seedMarch();
    const report = funnelReport({ ...MARCH, granularity: 'month' }, { now: NOW });
    assert.equal(report.totals.counts[stepIndex('listing_view')], null);
    assert.equal(report.totals.conversion[stepIndex('add_app_click')], null);
    assert.equal(report.totals.counts[stepIndex('installed')], 4);
  });
});

describe('bigquery connection', () => {
  it('never hands the service-account key back', () => {
    saveConnection({ projectId: 'demo', credentials: KEY });
    const view = describeConnection(readConnection()!) as Record<string, unknown>;

    assert.equal('credentials' in view, false);
    assert.equal(view.clientEmail, 'partnerdex@demo.iam.gserviceaccount.com');
    assert.equal(view.keyHint, '…23456789');
    assert.equal(
      JSON.stringify(view).includes('BEGIN PRIVATE KEY'),
      false,
      'nothing rendered to a browser may contain the key',
    );
  });

  it('keeps the stored key when an edit does not supply one', () => {
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveConnection({ projectId: 'other-project' });

    const connection = readConnection()!;
    assert.equal(connection.projectId, 'other-project');
    assert.ok(connection.credentials.includes('BEGIN PRIVATE KEY'));
  });

  it('clears the last check when the connection moves', () => {
    saveConnection({ projectId: 'demo', credentials: KEY });
    getDb()
      .prepare(`UPDATE bigquery_connection SET checked_at = '2024-01-01T00:00:00Z'`)
      .run();

    saveConnection({ projectId: 'other-project' });
    assert.equal(
      readConnection()!.checkedAt,
      null,
      'a green tick from the previous project would be worse than none',
    );
  });

  it('refuses a first connection with no key', () => {
    assert.throws(() => saveConnection({ projectId: 'demo' }), BigQueryError);
  });

  it('rejects an OAuth client secret, which downloads from the same page', () => {
    assert.throws(
      () => parseServiceAccount(JSON.stringify({ installed: { client_id: 'x' } })),
      /service_account/,
    );
    assert.throws(() => parseServiceAccount('not json at all'), /parse as JSON/);
  });

  it('rejects an identifier that would not be safe to interpolate', () => {
    assert.throws(
      () => saveConnection({ projectId: 'a`.b', credentials: KEY }),
      /Project id must be/,
    );
  });
});

/**
 * The dataset lives on the app, not on the account, because a partner who put a
 * separate GA4 measurement id on each listing has one export per app. These are
 * the consequences of that split which would be easy to regress.
 */
describe('bigquery per-app sources', () => {
  beforeEach(() => {
    seedMarch();
    saveConnection({ projectId: 'demo', location: 'US', credentials: KEY });
  });

  it('starts with no dataset, and refuses to guess one', () => {
    const source = resolveAppSource(APP_ID)!;
    assert.equal(source.dataset, null, 'an unset dataset must not fall back to anything');
    assert.equal(source.location, 'US', 'the location does fall back');
    assert.equal(source.locationOverridden, false);
  });

  it('keeps two apps on two different datasets', () => {
    seedForApp('222', '4242', '30');
    saveAppSource(APP_ID, { dataset: 'analytics_111' });
    saveAppSource('222', { dataset: 'analytics_222' });

    assert.equal(resolveAppSource(APP_ID)!.dataset, 'analytics_111');
    assert.equal(resolveAppSource('222')!.dataset, 'analytics_222');
  });

  it('overrides the location only where one is set', () => {
    saveAppSource(APP_ID, { dataset: 'analytics_111', location: 'EU' });
    const source = resolveAppSource(APP_ID)!;

    assert.equal(source.location, 'EU');
    assert.equal(source.locationOverridden, true);

    // Cleared, and it falls back to the account's default again rather than
    // being stuck on the value that was wrong.
    saveAppSource(APP_ID, { dataset: 'analytics_111', location: '' });
    assert.equal(resolveAppSource(APP_ID)!.location, 'US');
    assert.equal(resolveAppSource(APP_ID)!.locationOverridden, false);
  });

  it('skips an app with no dataset instead of syncing it against someone else’s', async () => {
    const result = await syncListingEvents(getDb(), [APP_ID], { now: NOW });

    assert.equal(result.rows, 0);
    assert.equal(result.apps.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /No GA4 dataset/);
  });

  it('rejects a dataset name that would not be safe to interpolate', () => {
    assert.throws(
      () => saveAppSource(APP_ID, { dataset: 'analytics_1`; DROP' }),
      /Dataset must be/,
    );
  });
});

/**
 * The picker's contract, exercised over a socket because that is what the
 * dashboard actually depends on: only apps with a dataset, and never an
 * "all apps" entry.
 */
describe('funnel app picker', () => {
  const listApps = async (): Promise<Array<{ id: string; name: string; hasTraffic: boolean }>> => {
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/funnel/apps`);
      const body = (await response.json()) as {
        apps: Array<{ id: string; name: string; hasTraffic: boolean }>;
      };
      return body.apps;
    } finally {
      server.close();
    }
  };

  it('offers nothing until a dataset is configured', async () => {
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '5150', '50');
    saveConnection({ projectId: 'demo', credentials: KEY });

    assert.deepEqual(await listApps(), [], 'an app with no dataset has no top to its funnel');
  });

  it('offers only the apps that have one, and marks those not yet synced', async () => {
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '5150', '50');
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveAppSource(APP_ID, { dataset: 'analytics_111' });

    const apps = await listApps();
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.id, APP_ID);
    assert.equal(apps[0]!.hasTraffic, false, 'configured but never synced is its own state');

    addListingEvents([{ type: VIEW, at: '2024-03-10T00:00:00Z', visitor: 'a' }]);
    assert.equal((await listApps())[0]!.hasTraffic, true);
  });
});

/**
 * The step picker re-chains conversions, so the arithmetic is done in the
 * browser over whichever subset is shown. It is the one piece of the report
 * that is not the server's, and the easiest to get quietly wrong.
 */
describe('funnel: conversions over a chosen subset of steps', () => {
  const counts = [1000, 200, 150, 60, 30];

  it('measures each step against the one above it when all are shown', () => {
    assert.deepEqual(conversionsFor(counts, [0, 1, 2, 3, 4]), [null, 20, 75, 40, 50]);
  });

  it('re-chains across a step that has been hidden', () => {
    // Hiding "add app clicked" must compare installs to views (15%), not leave
    // the 75% that was measured against the step no longer on screen.
    assert.deepEqual(conversionsFor(counts, [0, 2, 3, 4]), [null, 15, 40, 50]);
  });

  it('gives no rate where a step is unmeasurable or the one above it is zero', () => {
    assert.deepEqual(conversionsFor([null, null, 150, 60, 30], [0, 1, 2, 3, 4]), [
      null,
      null,
      null,
      40,
      50,
    ]);
    assert.deepEqual(
      conversionsFor([0, 0, 44, 3, 0], [0, 1, 2]),
      [null, null, null],
      'zero above has no finite rate, and 0% would read as "nobody converted"',
    );
  });
});

describe('bigquery identity', () => {
  it('prefers the shop over any analytics id', () => {
    assert.equal(
      resolveUserKey({
        shop_url: 'Acme.myshopify.com',
        shop_id: '123',
        user_id: 'u1',
        user_pseudo_id: 'p1',
      }),
      'shop:acme.myshopify.com',
      'a myshopify domain names a merchant; case is not part of the name',
    );
    assert.equal(
      resolveUserKey({ shop_id: '123', user_id: 'u1', user_pseudo_id: 'p1' }),
      'shop:123',
    );
  });

  it('falls back to the GA user id, then to the browser', () => {
    assert.equal(resolveUserKey({ user_id: 'u1', user_pseudo_id: 'p1' }), 'user:u1');
    assert.equal(resolveUserKey({ user_pseudo_id: 'p1' }), 'ga:p1');
  });

  it('keeps the spaces apart from real ids', () => {
    assert.equal(resolveUserKey({ shop_url: '   ', user_pseudo_id: 'p1' }), 'ga:p1');
    assert.equal(resolveUserKey({}), '', 'nothing at all resolves to nothing');
  });

  it('namespaces the sources so two identifier spaces cannot collide', () => {
    assert.notEqual(resolveUserKey({ user_id: '42' }), resolveUserKey({ shop_id: '42' }));
  });
});

describe('bigquery event names', () => {
  it('are constants, spelled the way Shopify sends them', () => {
    assert.equal(LISTING_VIEW_EVENT, 'page_view');
    assert.equal(
      ADD_APP_CLICK_EVENT,
      'Add App button',
      'lowercase button — GA4 names are case-sensitive and "Add App Button" matches nothing',
    );
  });

  it('cannot be overridden through the connection', () => {
    const saved = saveConnection({ projectId: 'demo', credentials: KEY }) as Record<string, unknown>;
    assert.equal('viewEvent' in saved, false);
    assert.equal('clickEvent' in saved, false);
  });

  it('leaves collected traffic alone when the connection is edited', () => {
    seedMarch();
    saveConnection({ projectId: 'demo', credentials: KEY });
    addListingEvents([{ type: VIEW, at: '2024-03-10T09:00:00Z', visitor: 'ga:a' }]);

    saveConnection({ projectId: 'demo', location: 'EU' });

    const rows = getDb().prepare('SELECT COUNT(*) AS n FROM listing_events').get() as { n: number };
    assert.equal(rows.n, 1, 'nothing about which events are read can have changed');
  });
});

/**
 * The handle filter has a cost, and it was being paid where there was nothing
 * to buy. A listing addresses some of its own pages by numeric id —
 * `apps.shopify.com/reviews/1384570` is this listing's reviews tab and contains
 * no handle — so filtering on the handle silently drops real views. It is worth
 * that only when a property carries more than one listing.
 */
describe('bigquery: when the handle filter applies', () => {
  const pattern = new RegExp(handlePattern('shipping-calculator-shipmagic').replace('(?i)', ''), 'i');

  it('does not match a listing page addressed by numeric id', () => {
    assert.equal(
      pattern.test('https://apps.shopify.com/reviews/1384570?locale=nb'),
      false,
      'the reviews tab is a real listing view the handle cannot see',
    );
  });

  it('matches the listing and its handle-addressed sub-pages', () => {
    assert.ok(pattern.test('https://apps.shopify.com/shipping-calculator-shipmagic'));
    assert.ok(pattern.test('https://apps.shopify.com/shipping-calculator-shipmagic/reviews'));
  });

  it('is skipped for an app whose dataset is its own', async () => {
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '5150', '50');
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveAppSource(APP_ID, { dataset: 'analytics_111', handle: 'app-one' });
    saveAppSource('222', { dataset: 'analytics_222', handle: 'app-two' });

    const queries: string[] = [];
    useBigQueryConstructor(
      class {
        query(options: { query: string }) {
          queries.push(options.query);
          return Promise.resolve([[]]);
        }
      } as never,
    );

    await syncListingEvents(getDb(), [APP_ID, '222'], { now: NOW });
    useBigQueryConstructor(null);

    assert.ok(queries.length > 0, 'both apps should have been queried');
    assert.equal(
      queries.some((q) => q.includes('handlePattern')),
      false,
      'a property with one listing counts everything in it',
    );
  });

  it('is applied when two apps share one dataset', async () => {
    resetEnvironment({ PARTNER_APP_IDS: '111,222' });
    seedMarch();
    seedForApp('222', '5150', '50');
    saveConnection({ projectId: 'demo', credentials: KEY });
    saveAppSource(APP_ID, { dataset: 'shared_ga4', handle: 'app-one' });
    saveAppSource('222', { dataset: 'shared_ga4', handle: 'app-two' });

    const queries: string[] = [];
    useBigQueryConstructor(
      class {
        query(options: { query: string }) {
          queries.push(options.query);
          return Promise.resolve([[]]);
        }
      } as never,
    );

    await syncListingEvents(getDb(), [APP_ID, '222'], { now: NOW });
    useBigQueryConstructor(null);

    assert.ok(
      queries.every((q) => q.includes('handlePattern')),
      'sharing a property is the one case where the events must be told apart',
    );
  });
});

describe('bigquery attribution', () => {
  it('anchors a handle on a path boundary so one app cannot claim another', () => {
    const pattern = new RegExp(handlePattern('stock-sync').replace('(?i)', ''), 'i');

    assert.ok(pattern.test('https://apps.shopify.com/stock-sync'));
    assert.ok(pattern.test('https://apps.shopify.com/stock-sync?locale=de'));
    assert.ok(pattern.test('https://apps.shopify.com/stock-sync/reviews'));
    assert.equal(
      pattern.test('https://apps.shopify.com/stock-sync-pro'),
      false,
      'a longer handle that starts the same is a different app',
    );
  });

  it('refuses a handle carrying a regex metacharacter', () => {
    assert.throws(() => handlePattern('stock.*'), BigQueryError);
  });
});

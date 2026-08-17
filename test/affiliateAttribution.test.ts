import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attributionQuery,
  extractReferralHandle,
  isHandleShaped,
  LISTING_HOST,
  qualifies,
  REFERRAL_WINDOW_DAYS,
  selectFirstTouch,
  type AttributionCandidate,
} from '../src/affiliates/ga4Attribution.js';
import { BigQueryError } from '../src/bigquery/connection.js';

/**
 * Affiliate attribution, minus BigQuery.
 *
 * The SQL is not what decides who gets paid — it narrows a multi-year export
 * down to candidate pairs, and everything after that is the rule. What is worth
 * asserting is the rule, and specifically the places where getting it wrong pays
 * the wrong person rather than failing:
 *
 *   - reading `utm_source` off a link that also carries `mref`
 *   - a junk parameter winning the first-touch race and taking an install off
 *     the affiliate who earned it
 *   - the 30-day boundary being exclusive at either end
 *   - one merchant credited to two affiliates
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

function candidate(overrides: Partial<AttributionCandidate> = {}): AttributionCandidate {
  return {
    shopId: '99999999999',
    shopDomain: 'example.myshopify.com',
    anonymousId: '111111111.1700000000',
    handle: 'testhdl1',
    clickedAt: '2026-07-01T00:00:00.000Z',
    installedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

/** An ISO instant `offsetMs` before the install both fixtures share. */
function before(installedAt: string, offsetMs: number): string {
  return new Date(Date.parse(installedAt) - offsetMs).toISOString();
}

describe('referral parameter extraction', () => {
  const listing = 'https://apps.shopify.com/back-in-stock-restock-alerts';

  it('reads mref', () => {
    assert.equal(extractReferralHandle(`${listing}?mref=testhdl1`), 'testhdl1');
  });

  it('prefers mref over utm_source and ref', () => {
    assert.equal(
      extractReferralHandle(`${listing}?utm_source=website&mref=testhdl1&ref=testhdl2`),
      'testhdl1',
    );
  });

  it('prefers utm_source over ref when there is no mref', () => {
    assert.equal(extractReferralHandle(`${listing}?ref=testhdl2&utm_source=testhdl1`), 'testhdl1');
  });

  // The tail of `mref` is `ref`. A pattern that did not anchor on `?` or `&`
  // would read the same handle twice and never notice.
  it('does not mistake the tail of mref for ref', () => {
    assert.equal(extractReferralHandle(`${listing}?mref=testhdl1`), 'testhdl1');
    assert.equal(extractReferralHandle(`${listing}?xmref=testhdl1`), null);
  });

  it('stops at the next parameter and at the fragment', () => {
    assert.equal(extractReferralHandle(`${listing}?mref=testhdl1&locale=fr`), 'testhdl1');
    assert.equal(extractReferralHandle(`${listing}?mref=testhdl1#reviews`), 'testhdl1');
  });

  it('treats an empty value as absent and falls through', () => {
    assert.equal(extractReferralHandle(`${listing}?mref=&utm_source=testhdl1`), 'testhdl1');
    assert.equal(extractReferralHandle(`${listing}?mref=`), null);
  });

  it('returns null for a listing URL with no referral parameter', () => {
    // The single most common listing URL in the export: Shopify's own admin
    // search. It carries st_source, not utm_source.
    assert.equal(
      extractReferralHandle(`${listing}?st_campaign=admin-search&st_source=admin-web`),
      null,
    );
    assert.equal(extractReferralHandle(null), null);
    assert.equal(extractReferralHandle(''), null);
  });

  it('recognises the shape of a handle, and only that shape', () => {
    assert.equal(isHandleShaped('testhdl1'), true);
    assert.equal(isHandleShaped('TESTHDL1'), false);
    assert.equal(isHandleShaped('admin-web'), false);
    assert.equal(isHandleShaped('website'), false);
    // Honest about the fallback's limit: an eight-character campaign name is
    // indistinguishable from a handle without the real list.
    assert.equal(isHandleShaped('filemonk'), true);
  });
});

describe('the 30-day referral window', () => {
  const installedAt = '2026-07-31T12:00:00.000Z';

  it('accepts a click one microsecond-equivalent inside the far edge', () => {
    assert.equal(
      qualifies(candidate({ installedAt, clickedAt: before(installedAt, 30 * DAY - 1) })),
      true,
    );
  });

  // Inclusive on purpose: a merchant who installs on the last day of the cookie
  // is a merchant the affiliate referred.
  it('accepts a click exactly 30 days before the install', () => {
    assert.equal(
      qualifies(candidate({ installedAt, clickedAt: before(installedAt, 30 * DAY) })),
      true,
    );
  });

  it('rejects a click one millisecond older than 30 days', () => {
    assert.equal(
      qualifies(candidate({ installedAt, clickedAt: before(installedAt, 30 * DAY + 1) })),
      false,
    );
  });

  // Same-instant is the common case, not an edge one: the listing page and the
  // install fire within the same second on a fast install.
  it('accepts a click at the same instant as the install', () => {
    assert.equal(qualifies(candidate({ installedAt, clickedAt: installedAt })), true);
  });

  it('rejects a click after the install, however close', () => {
    assert.equal(
      qualifies(candidate({ installedAt, clickedAt: before(installedAt, -1) })),
      false,
    );
  });

  it('honours a window other than the default', () => {
    const clickedAt = before(installedAt, 20 * DAY);
    assert.equal(qualifies(candidate({ installedAt, clickedAt }), REFERRAL_WINDOW_DAYS), true);
    assert.equal(qualifies(candidate({ installedAt, clickedAt }), 14), false);
  });

  it('rejects an unparseable timestamp rather than treating it as the epoch', () => {
    assert.equal(qualifies({ clickedAt: 'not a date', installedAt }), false);
    assert.equal(qualifies({ clickedAt: installedAt, installedAt: 'not a date' }), false);
  });
});

describe('first touch', () => {
  const installedAt = '2026-07-31T12:00:00.000Z';

  it('credits the earliest qualifying click, not the closest one', () => {
    const rows = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt: before(installedAt, 10 * MINUTE), handle: 'testhdl2' }),
      candidate({ installedAt, clickedAt: before(installedAt, 20 * DAY), handle: 'testhdl1' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.handle, 'testhdl1');
  });

  it('ignores a click that fell out of the window, even if it was first', () => {
    const rows = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt: before(installedAt, 40 * DAY), handle: 'testhdl2' }),
      candidate({ installedAt, clickedAt: before(installedAt, 5 * DAY), handle: 'testhdl1' }),
    ]);
    assert.deepEqual(
      rows.map((row) => row.handle),
      ['testhdl1'],
    );
  });

  it('credits one merchant to exactly one affiliate', () => {
    const rows = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt: before(installedAt, 3 * DAY), handle: 'testhdl2' }),
      candidate({ installedAt, clickedAt: before(installedAt, 2 * DAY), handle: 'testhdl1' }),
      candidate({ installedAt, clickedAt: before(installedAt, 1 * DAY), handle: 'zzfixtr9' }),
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.handle, 'testhdl2');
  });

  it('keeps merchants apart', () => {
    const rows = selectFirstTouch('stoq', [
      candidate({ shopId: '1', shopDomain: 'one.myshopify.com', handle: 'testhdl2' }),
      candidate({ shopId: '2', shopDomain: 'two.myshopify.com', handle: 'testhdl1' }),
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.shopId).sort(),
      ['1', '2'],
    );
  });

  // The measured failure this guards: filtering after the pick rather than
  // before it attributed 39 installs where filtering before it attributed 51,
  // because Shopify's own admin-search click lands before the affiliate's.
  it('does not let a non-handle parameter take the attribution', () => {
    const rows = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt: before(installedAt, 6 * DAY), handle: 'admin-web' }),
      candidate({ installedAt, clickedAt: before(installedAt, 5 * DAY), handle: 'testhdl1' }),
    ]);
    assert.deepEqual(
      rows.map((row) => row.handle),
      ['testhdl1'],
    );
  });

  it('accepts only known handles when the caller supplies them', () => {
    const candidates = [
      candidate({ installedAt, clickedAt: before(installedAt, 6 * DAY), handle: 'filemonk' }),
      candidate({ installedAt, clickedAt: before(installedAt, 5 * DAY), handle: 'testhdl1' }),
    ];
    assert.deepEqual(
      selectFirstTouch('stoq', candidates).map((row) => row.handle),
      // Shape alone cannot tell a campaign name from a handle, so the junk wins.
      ['filemonk'],
    );
    assert.deepEqual(
      selectFirstTouch('stoq', candidates, { handles: ['testhdl1', 'testhdl2'] }).map(
        (row) => row.handle,
      ),
      ['testhdl1'],
    );
  });

  it('normalises handle case on both sides of the allowlist', () => {
    const rows = selectFirstTouch('stoq', [candidate({ handle: 'TESTHDL1' })], {
      handles: ['testhdl1'],
    });
    assert.deepEqual(
      rows.map((row) => row.handle),
      ['testhdl1'],
    );
  });

  it('answers the same way twice when two clicks share an instant', () => {
    const clickedAt = before(installedAt, 2 * DAY);
    const one = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt, handle: 'zzfixtr9' }),
      candidate({ installedAt, clickedAt, handle: 'testhdl2' }),
    ]);
    const two = selectFirstTouch('stoq', [
      candidate({ installedAt, clickedAt, handle: 'testhdl2' }),
      candidate({ installedAt, clickedAt, handle: 'zzfixtr9' }),
    ]);
    assert.deepEqual(one, two);
    assert.equal(one[0]?.handle, 'testhdl2');
  });

  it('drops a candidate with no shop, which cannot be paid against', () => {
    assert.deepEqual(selectFirstTouch('stoq', [candidate({ shopId: '' })]), []);
  });

  it('returns plain data, keyed to the app it was run for', () => {
    const rows = selectFirstTouch('gid://partners/App/111', [candidate()]);
    assert.deepEqual(rows, [
      {
        appId: 'gid://partners/App/111',
        handle: 'testhdl1',
        shopId: '99999999999',
        shopDomain: 'example.myshopify.com',
        clickedAt: '2026-07-01T00:00:00.000Z',
        installedAt: '2026-07-02T00:00:00.000Z',
        anonymousId: '111111111.1700000000',
      },
    ]);
  });
});

describe('the query it sends', () => {
  const sql = attributionQuery('test-bq-project', 'analytics_000000000');

  // The one thing standing between this and a scan of two years of daily tables.
  it('always bounds the table suffix', () => {
    assert.match(sql, /_TABLE_SUFFIX BETWEEN @scanFrom AND @scanTo/);
  });

  it('reads both sides of the join in one pass over one scan', () => {
    assert.equal(sql.match(/FROM `test-bq-project\.analytics_000000000\.events_\*`/g)?.length, 1);
  });

  it('binds every value rather than interpolating it', () => {
    for (const param of [
      '@scanFrom',
      '@scanTo',
      '@clickFromMicros',
      '@installFromMicros',
      '@installToMicros',
      '@windowMicros',
      '@maxRows',
    ]) {
      assert.ok(sql.includes(param), `${param} is not bound`);
    }
    assert.match(sql, /REGEXP_CONTAINS\(handle, @handleShape\)/);
    assert.match(
      attributionQuery('p', 'd', { byHandleList: true }),
      /LOWER\(handle\) IN UNNEST\(@handles\)/,
    );
  });

  /*
   * A measurement id is public, so any site that copies the tag emits into the
   * property. One mirror site already does. Without the host check it could
   * assign itself commissions with a made-up `?mref=`.
   */
  it('accepts clicks only from the App Store host', () => {
    assert.match(sql, /NET\.HOST\(page_location\) = @listingHost/);
    assert.equal(LISTING_HOST, 'apps.shopify.com');
  });

  /*
   * The install is server-side and carries no page_location at all. Filtering it
   * on hostname would return zero attributions and no error — the worst
   * available failure mode, since nothing looks broken.
   */
  it('does not apply the host check to the install side', () => {
    const installs = sql.slice(sql.indexOf('installs AS ('));
    assert.ok(!installs.includes('NET.HOST'), 'the install CTE must not filter on hostname');
    assert.equal(sql.match(/NET\.HOST/g)?.length, 1);
  });

  it('reads the install event the funnel deliberately skips', () => {
    assert.match(sql, /event_name = 'shopify_app_install'/);
    assert.match(sql, /key = 'shop_id'/);
    assert.match(sql, /key = 'shop_url'/);
  });

  // Same reasoning as `handlePattern` in the funnel: the dataset reaches the SQL
  // as text because an identifier cannot be bound, so it is checked instead.
  it('refuses a dataset or project that is not an identifier', () => {
    assert.throws(() => attributionQuery('ok', 'analytics`; DROP'), BigQueryError);
    assert.throws(() => attributionQuery('ok project', 'analytics_1'), BigQueryError);
  });
});

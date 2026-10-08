import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb, type Db } from '../src/db/index.js';
import { dispatchPending } from '../src/notifications/dispatch.js';
import { buildMessage } from '../src/notifications/slack.js';
import {
  createChannel,
  getChannel,
  listChannels,
  normalizeWebhookUrl,
  NotificationError,
  setTopic,
  webhookHint,
} from '../src/notifications/store.js';
import { APP_REVIEW_EVENTS, APP_SUBSCRIPTION_EVENTS } from '../src/notifications/topics.js';
import { APP_ID, resetEnvironment, seed, seedForApp } from './helpers.js';

/**
 * What gets said, to whom, and how many times.
 *
 * These are the cases that turn a working notifier into an untrustworthy one:
 * a toggle that replays two years of history the moment it is switched on, a
 * rebuild that re-announces every subscription the account has ever had, an
 * upgrade reported as a lost customer, and one merchant action arriving as two
 * pings.
 */

const TOPIC = APP_SUBSCRIPTION_EVENTS.key;

interface SentMessage {
  url: string;
  text: string;
  blocks: unknown[];
}

let sent: SentMessage[] = [];
let realFetch: typeof globalThis.fetch;

/** Answers every webhook POST with `reply`, and records what was sent. */
function stubFetch(reply: (attempt: number) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; blocks: unknown[] };
    sent.push({ url: String(input), text: body.text, blocks: body.blocks });
    return reply(sent.length);
  }) as typeof globalThis.fetch;
}

const ok = () => new Response('ok', { status: 200 });

/**
 * Backdates a topic's watermark so a fixture's history counts as news.
 *
 * Everything in this suite happens in 2024 while the watermark is stamped at
 * `now`, so without this the correct answer to every test would be "sends
 * nothing" — which is the behaviour the first test pins down deliberately.
 */
function watermark(db: Db, channelId: string, at: string): void {
  db.prepare(
    'UPDATE notification_subscriptions SET enabled_at = ? WHERE channel_id = ? AND topic = ?',
  ).run(at, channelId, TOPIC);
}

function channelWithTopic(db: Db, name = '#revenue'): string {
  const channel = createChannel(
    { name, webhookUrl: 'https://hooks.slack.com/services/T1/B1/secret123' },
    db,
  );
  setTopic(channel.id, TOPIC, true, db);
  return channel.id;
}

function headlines(): string[] {
  return sent.map((message) => message.text.split(':')[0]!);
}

beforeEach(() => {
  resetEnvironment();
  sent = [];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

describe('webhook handling', () => {
  it('refuses a plaintext webhook, because the secret is in the URL', () => {
    assert.throws(
      () => normalizeWebhookUrl('http://hooks.slack.com/services/T1/B1/secret'),
      (error: unknown) => error instanceof NotificationError && /https/.test((error as Error).message),
    );
  });

  it('refuses something that is not a URL at all', () => {
    assert.throws(() => normalizeWebhookUrl('paste it here'), NotificationError);
  });

  it('never returns the URL it was given', () => {
    const db = getDb();
    const channel = createChannel(
      { name: '#revenue', webhookUrl: 'https://hooks.slack.com/services/T1/B1/supersecret' },
      db,
    );

    const serialized = JSON.stringify([channel, getChannel(channel.id, db), listChannels(db)]);
    assert.equal(serialized.includes('supersecret'), false);
    assert.match(channel.webhookHint, /^hooks\.slack\.com\//);
  });

  it('masks all but the tail of the secret', () => {
    assert.equal(webhookHint('https://hooks.slack.com/services/T1/B1/abcdefgh'), 'hooks.slack.com/…efgh');
  });
});

/**
 * The ledger stops anything being said twice; it cannot stop something being
 * said late. Two backlogs produce that: an instance that was down, and a release
 * that widens a topic a channel already subscribes to — the watermark is per
 * topic, so the added types make months of history look like unsent news.
 */
describe('how old an event may be and still be news', () => {
  const ACTIVATED = '2024-03-01T00:00:00Z';

  /** `hours` after the fixture's activation. */
  const clock = (hours: number) =>
    new Date(new Date(ACTIVATED).getTime() + hours * 3_600_000);

  /**
   * A `review_posted` row written straight in. The App Store ingest is a long
   * way from what this suite is testing, and only the timestamp matters here.
   */
  function seedReviewEvent(db: Db, occurredAt: string): void {
    db.prepare(
      `INSERT INTO customer_events (
         event_id, app_id, shop_id, type, occurred_at, charge_id, prev_charge_id,
         plan_name, plan_amount, billing_interval, currency, net_change, amount,
         suppressed, detail
       ) VALUES (?, ?, '', 'review_posted', ?, '', '', NULL, NULL, NULL, NULL,
                 NULL, NULL, 0, ?)`,
    ).run('review:r1:posted', APP_ID, occurredAt, JSON.stringify({ rating: 5, storeName: 'Acme' }));
  }

  function seedOne() {
    resetEnvironment({ NOTIFICATION_MAX_AGE_HOURS: '24' });
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: ACTIVATED, firstSaleAt: ACTIVATED },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);
    return db;
  }

  it('announces an event from within the window', async () => {
    const db = seedOne();
    assert.equal((await dispatchPending(db, { now: clock(6) })).sent, 1);
  });

  it('stays quiet about one the window has passed', async () => {
    const db = seedOne();
    assert.equal((await dispatchPending(db, { now: clock(30) })).sent, 0);
  });

  /**
   * The case the cap exists for: a release adds event types to a topic that has
   * been switched on for months, and every past occurrence of the new types
   * becomes undelivered news at once.
   */
  it('does not replay history when a topic gains a new event type', async () => {
    resetEnvironment({ NOTIFICATION_MAX_AGE_HOURS: '24' });
    const db = seed([
      // A trial that converted long ago. `trial_converted` was not in the topic
      // when this happened; now it is.
      {
        chargeRef: 'old',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T00:00:00Z',
        billingOn: '2024-03-15T00:00:00Z',
        firstSaleAt: '2024-03-15T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    // Six months later, the release lands and the next sync runs.
    const summary = await dispatchPending(db, { now: new Date('2024-09-01T00:00:00Z') });

    assert.equal(summary.sent, 0, 'nothing from six months ago is news');
  });

  /**
   * The App Store publishes the day a review was posted, not the time, so a
   * review is stamped at midnight and can look a full day older than it is —
   * plus however long the sweep took to find it.
   */
  it('gives a review the length of its own day before calling it stale', async () => {
    resetEnvironment({ NOTIFICATION_MAX_AGE_HOURS: '24', REVIEW_SWEEP_HOURS: '24' });
    const db = getDb();
    seedReviewEvent(db, '2024-03-01T00:00:00.000Z');
    const channelId = createChannel(
      { name: '#reviews', webhookUrl: 'https://hooks.slack.com/services/T1/B1/secret123' },
      db,
    ).id;
    setTopic(channelId, APP_REVIEW_EVENTS.key, true, db);
    db.prepare(
      'UPDATE notification_subscriptions SET enabled_at = ? WHERE channel_id = ? AND topic = ?',
    ).run('2024-01-01T00:00:00Z', channelId, APP_REVIEW_EVENTS.key);
    stubFetch(ok);

    // 40 hours past the stamped midnight — beyond the 24h a Partner API event
    // would get, and still well inside a review's allowance.
    const summary = await dispatchPending(db, { now: new Date('2024-03-02T16:00:00Z') });

    assert.equal(summary.sent, 1);
  });
});

describe('what a channel is told', () => {
  it('says nothing about what happened before the toggle was switched on', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    channelWithTopic(db);
    stubFetch(ok);

    const summary = await dispatchPending(db);

    assert.equal(summary.sent, 0);
    assert.equal(sent.length, 0);
  });

  it('reports a subscription that started after it was switched on', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    const summary = await dispatchPending(db);

    assert.equal(summary.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, 'https://hooks.slack.com/services/T1/B1/secret123');
    assert.match(sent[0]!.text, /^Subscription started: Shop 1/);
  });

  it('carries the shop, the app, the plan and the amount', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    const rendered = JSON.stringify(sent[0]!.blocks);
    assert.match(rendered, /Shop 1/);
    assert.match(rendered, /s1\.example/);
    assert.match(rendered, /Test App/);
    assert.match(rendered, /Plan/);
    assert.match(rendered, /\$29\.00\/mo/);
  });

  /**
   * The pairing this collapses is not a bug in the compiler: a trial really is
   * both a charge activating and a free period beginning, and the ledger needs
   * both rows. It is one thing the merchant did, so it is one message.
   */
  it('announces a trial once, not as a trial and a subscription', async () => {
    const db = seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T00:00:00Z',
        billingOn: '2024-03-15T00:00:00Z',
        firstSaleAt: '2024-03-15T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    // Both rows exist; only one message does.
    const compiled = db
      .prepare(
        `SELECT type FROM customer_events
          WHERE shop_id = '1' AND occurred_at = '2024-03-01T00:00:00.000Z' AND suppressed = 0
          ORDER BY type`,
      )
      .all() as Array<{ type: string }>;
    assert.deepEqual(compiled.map((row) => row.type), ['subscribed', 'trial_started']);

    await dispatchPending(db);

    // One message for the activation instant, then the conversion on its own
    // two weeks later — which is the event that actually carries the money.
    assert.deepEqual(headlines(), ['Trial started', 'Trial converted']);
  });

  /**
   * The reported failure, end to end: a merchant dropped a trial and signed up
   * again a couple of minutes later, and the channel was told twice — "Subscription
   * upgraded" and "Trial started" — for one merchant action, neither of which
   * was what happened. The compiler now calls the return a win-back, and the
   * pair of rows it shares its instant with becomes the one sentence that is
   * true of both: they have been here before, and they are trialling again.
   */
  it('announces a win-back trial once, as a restart', async () => {
    const db = seed([
      {
        chargeRef: 'dropped',
        shopId: '1',
        amount: 14,
        activatedAt: '2024-03-01T00:00:00Z',
        billingOn: '2024-03-15T00:00:00Z',
        churnedAt: '2024-03-10T00:00:00Z',
      },
      {
        chargeRef: 'again',
        shopId: '1',
        amount: 14,
        activatedAt: '2024-03-10T00:02:00Z',
        billingOn: '2024-03-24T00:00:00Z',
        firstSaleAt: '2024-03-24T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    // Two rows at the instant of the return, as the ledger requires.
    const compiled = db
      .prepare(
        `SELECT type FROM customer_events
          WHERE shop_id = '1' AND occurred_at = '2024-03-10T00:02:00.000Z' AND suppressed = 0
          ORDER BY type`,
      )
      .all() as Array<{ type: string }>;
    assert.deepEqual(compiled.map((row) => row.type), ['resubscribed', 'trial_started']);

    await dispatchPending(db);

    // One message for the return, and it says what the return was.
    const spoken = headlines();
    assert.equal(spoken.filter((line) => line === 'Trial restarted').length, 1);
    assert.equal(spoken.filter((line) => line === 'Subscription upgraded').length, 0);
    assert.equal(spoken.filter((line) => line === 'Subscription downgraded').length, 0);
    assert.equal(spoken.filter((line) => line === 'Subscription restarted').length, 0);
    assert.equal(spoken.indexOf('Trial restarted'), spoken.lastIndexOf('Trial restarted'));
  });

  /**
   * The reported failure: a merchant started a trial, uninstalled hours later,
   * and the channel heard only the good half. A trial the reader was told about
   * starting must be a trial they are told about ending.
   */
  it('reports a trial the merchant abandons hours after starting it', async () => {
    const db = seed(
      [
        {
          chargeRef: 'c1',
          shopId: '1',
          amount: 4.99,
          activatedAt: '2024-03-01T00:22:51Z',
          billingOn: '2024-03-15T00:00:00Z',
          churnedAt: '2024-03-01T01:42:53Z',
        },
      ],
      { uninstalls: [{ shopId: '1', at: '2024-03-01T01:42:52Z' }] },
    );
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    assert.deepEqual(headlines(), ['Trial started', 'Trial cancelled']);
    // At the moment they left, not at the trial end date they never reached.
    assert.match(JSON.stringify(sent[1]!.blocks), /2024-03-01T01:42:53/);
  });
  it('reports an upgrade as an upgrade, not as a cancellation', async () => {
    const db = seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
        churnedAt: '2024-04-01T00:00:00Z',
      },
      {
        chargeRef: 'c2',
        shopId: '1',
        amount: 99,
        activatedAt: '2024-04-01T00:00:00Z',
        firstSaleAt: '2024-04-01T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-03-15T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    assert.deepEqual(headlines(), ['Subscription upgraded']);
    assert.match(JSON.stringify(sent[0]!.blocks), /Was on/);
  });

  /**
   * The reported failure, end to end: a merchant moved from a Starter trial to
   * Pro, and the channel heard "Trial cancelled" and then "Trial restarted".
   */
  it('reports a plan change made mid-trial as one upgrade', async () => {
    const db = seed([
      {
        chargeRef: 'starter',
        shopId: '1',
        amount: 14,
        activatedAt: '2024-03-01T10:57:45Z',
        billingOn: '2024-03-15T00:00:00Z',
        churnedAt: '2024-03-01T11:00:09Z',
      },
      {
        chargeRef: 'pro',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T11:00:10Z',
        billingOn: '2024-03-15T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-03-01T10:58:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    // The trial carried across to Pro, so it still converts on the date Starter's
    // would have — which is news of its own, a fortnight later.
    assert.deepEqual(headlines(), ['Subscription upgraded', 'Trial converted']);
    assert.match(JSON.stringify(sent[0]!.blocks), /Was on/);
  });

  it('reports a freeze and a thaw', async () => {
    const db = seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
        frozenAt: '2024-04-01T00:00:00Z',
        unfrozenAt: '2024-05-01T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-03-15T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    assert.deepEqual(headlines(), ['Subscription frozen', 'Subscription unfrozen']);
  });

  it('reports a cancellation', async () => {
    const db = seed([
      {
        chargeRef: 'c1',
        shopId: '1',
        amount: 29,
        activatedAt: '2024-03-01T00:00:00Z',
        firstSaleAt: '2024-03-01T00:00:00Z',
        churnedAt: '2024-04-01T00:00:00Z',
      },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-03-15T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);

    assert.deepEqual(headlines(), ['Subscription cancelled']);
  });

  it('ignores apps outside the reporting scope', async () => {
    seed([]);
    const db = seedForApp('222', 'other', '7');
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2020-01-01T00:00:00Z');
    stubFetch(ok);

    const summary = await dispatchPending(db);

    assert.equal(summary.sent, 0);
  });

  it('sends nothing when every toggle is off', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channel = createChannel(
      { name: '#quiet', webhookUrl: 'https://hooks.slack.com/services/T1/B1/secret123' },
      db,
    );
    setTopic(channel.id, TOPIC, true, db);
    watermark(db, channel.id, '2024-01-01T00:00:00Z');
    setTopic(channel.id, TOPIC, false, db);
    stubFetch(ok);

    assert.equal((await dispatchPending(db)).sent, 0);
    assert.equal(sent.length, 0);
  });
});

describe('saying it exactly once', () => {
  it('does not repeat itself on the next sync', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    assert.equal((await dispatchPending(db)).sent, 1);
    assert.equal((await dispatchPending(db)).sent, 0);
    assert.equal(sent.length, 1);
  });

  /**
   * The reason the delivery ledger exists at all. `customer_events` is dropped
   * and rewritten on every sync, so "rows I have not seen" is every row, every
   * time. Only the deterministic event id survives the rebuild.
   */
  it('does not repeat itself after the events table is rebuilt', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(ok);

    await dispatchPending(db);
    const { rebuildDerivedTables } = await import('../src/sync/derive.js');
    rebuildDerivedTables(db);

    assert.equal((await dispatchPending(db)).sent, 0);
    assert.equal(sent.length, 1);
  });

  it('tells a second channel the same news', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    for (const name of ['#revenue', '#founders']) {
      const id = channelWithTopic(db, name);
      watermark(db, id, '2024-01-01T00:00:00Z');
    }
    stubFetch(ok);

    assert.equal((await dispatchPending(db)).sent, 2);
  });
});

describe('when Slack refuses', () => {
  it('keeps a transient failure pending for the next run', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');

    // Down on the first attempt, back on the second.
    stubFetch((attempt) => (attempt === 1 ? new Response('', { status: 503 }) : ok()));

    const first = await dispatchPending(db);
    assert.equal(first.sent, 0);
    assert.equal(first.deferred, 1);
    assert.match(getChannel(channelId, db)!.lastError!, /503/);

    const second = await dispatchPending(db);
    assert.equal(second.sent, 1);
    assert.equal(getChannel(channelId, db)!.lastError, null);
  });

  /**
   * A revoked webhook answers 404 forever. Retrying it every five minutes would
   * mean the queue never advances, so the event is retired rather than left to
   * block the ones behind it.
   */
  it('retires an event a revoked webhook will never accept', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch(() => new Response('no_service', { status: 404 }));

    const first = await dispatchPending(db);
    assert.equal(first.retired, 1);
    assert.match(getChannel(channelId, db)!.lastError!, /no_service/);

    // Offered once, never again.
    await dispatchPending(db);
    assert.equal(sent.length, 1);
  });

  it('treats rate limiting as transient, not as a dead webhook', async () => {
    const db = seed([
      { chargeRef: 'c1', shopId: '1', amount: 29, activatedAt: '2024-03-01T00:00:00Z', firstSaleAt: '2024-03-01T00:00:00Z' },
    ]);
    const channelId = channelWithTopic(db);
    watermark(db, channelId, '2024-01-01T00:00:00Z');
    stubFetch((attempt) => (attempt === 1 ? new Response('', { status: 429 }) : ok()));

    assert.equal((await dispatchPending(db)).deferred, 1);
    assert.equal((await dispatchPending(db)).sent, 1);
  });
});

describe('message rendering', () => {
  const base = {
    eventId: 'e1',
    type: 'subscribed',
    occurredAt: '2024-03-01T00:00:00.000Z',
    shopId: '1',
    shopName: 'Acme Store',
    shopDomain: 'acme.myshopify.com',
    appId: '111',
    appName: 'Test App',
    planName: 'Pro',
    amount: 29,
    billingInterval: 'EVERY_30_DAYS' as string | null,
    currency: 'USD',
    netChange: 29,
    previousPlanName: null,
    previousAmount: null,
    previousBillingInterval: null,
    trialEndsAt: null,
  };

  /**
   * `plan_amount` on the event is the normalized monthly figure MRR sums, so an
   * annual plan reads as 24.92 there. A merchant paying $299 a year should be
   * announced as paying $299 a year, with the monthly figure kept for the MRR
   * line where it belongs.
   */
  it('quotes an annual plan at its billed price, not its monthly twelfth', () => {
    const message = buildMessage({
      ...base,
      amount: 299,
      billingInterval: 'ANNUAL',
      netChange: 299 / 12,
    });
    const rendered = JSON.stringify(message.blocks);

    assert.match(rendered, /\$299\.00\/yr/);
    assert.match(rendered, /\+\$24\.92\/mo/);
  });

  it('says a trial moves no money rather than leaving it blank', () => {
    const message = buildMessage({ ...base, type: 'trial_started', netChange: 0 });
    assert.match(JSON.stringify(message.blocks), /No change/);
  });

  it('does not let a store name inject Slack markup', () => {
    const message = buildMessage({ ...base, shopName: '<https://evil.example|Acme>' });
    assert.equal(JSON.stringify(message.blocks).includes('<https://evil.example|'), false);
  });

  it('leads with the headline, so a lock screen shows what happened', () => {
    assert.equal(buildMessage(base).text, 'Subscription started: Acme Store — Pro — $29.00/mo');
  });

  /**
   * Moving from $14/mo to $140/yr lowers MRR to $11.67, so the pipeline records
   * a `downgraded` event — which the spec requires and MRR depends on. The
   * message must not repeat that word at a merchant who just paid for a year.
   */
  describe('a switch between monthly and annual billing', () => {
    const toAnnual = {
      ...base,
      type: 'downgraded',
      planName: 'Starter',
      amount: 140,
      billingInterval: 'ANNUAL',
      netChange: 140 / 12 - 14,
      previousPlanName: 'Starter',
      previousAmount: 14,
      previousBillingInterval: 'EVERY_30_DAYS',
    };

    it('is announced as a switch, not as a downgrade', () => {
      const message = buildMessage(toAnnual);
      assert.match(message.text, /^Switched to annual billing:/);
      assert.equal(JSON.stringify(message.blocks).includes('downgraded'), false);
    });

    it('still reports the MRR it actually lost', () => {
      const rendered = JSON.stringify(buildMessage(toAnnual).blocks);
      assert.match(rendered, /−\$2\.33\/mo/);
      assert.match(rendered, /\$140\.00\/yr/);
      assert.match(rendered, /Was on Starter — \$14\.00\/mo/);
    });

    it('reads the other direction as a switch too', () => {
      const message = buildMessage({
        ...base,
        type: 'upgraded',
        planName: 'Starter',
        amount: 14,
        billingInterval: 'EVERY_30_DAYS',
        netChange: 14 - 140 / 12,
        previousPlanName: 'Starter',
        previousAmount: 140,
        previousBillingInterval: 'ANNUAL',
      });
      assert.match(message.text, /^Switched to monthly billing:/);
    });

    it('leaves a real tier move alone', () => {
      const message = buildMessage({
        ...base,
        type: 'upgraded',
        planName: 'Pro',
        amount: 290,
        billingInterval: 'ANNUAL',
        netChange: 290 / 12 - 14,
        previousPlanName: 'Starter',
        previousAmount: 14,
        previousBillingInterval: 'EVERY_30_DAYS',
      });
      assert.match(
        message.text,
        /^Subscription upgraded:/,
        'the plan name changed, so this is a tier move that happens to switch cadence',
      );
    });

    it('leaves a same-cadence downgrade alone', () => {
      const message = buildMessage({
        ...base,
        type: 'downgraded',
        planName: 'Starter',
        amount: 9.99,
        netChange: 9.99 - 14,
        previousPlanName: 'Starter',
        previousAmount: 14,
        previousBillingInterval: 'EVERY_30_DAYS',
      });
      assert.match(message.text, /^Subscription downgraded:/);
    });
  });
});

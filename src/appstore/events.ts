import type { Db } from '../db/index.js';

/**
 * Reviews, compiled onto the same timeline as everything else a customer does.
 *
 * The alternative was a parallel notion of "review events" with its own storage,
 * its own delivery ledger and its own idea of what counts as new. Writing them
 * into `customer_events` instead means the Customers page renders them without
 * knowing they came from a different source, the Slack dispatcher announces them
 * under rules it already enforces, and a review sits in the merchant's history
 * between the trial they started and the plan they upgraded to — which is where
 * a review is actually worth reading.
 *
 * Three rules make that safe:
 *
 *   - **Ids are deterministic.** `customer_events` is dropped and rewritten on
 *     every sync, so the delivery ledger's at-most-once promise rests entirely
 *     on an id that survives the rebuild. An edit folds its content hash into
 *     the id, so a second rewrite is a second piece of news rather than one that
 *     the ledger has already seen.
 *
 *   - **A review with no customer still gets an event**, carrying `shop_id = ''`
 *     exactly as a shopless app event does. It cannot appear on anybody's
 *     timeline, but "somebody left you a one-star" is news whether or not we
 *     worked out who, and suppressing it until the match landed would be
 *     silence at the worst moment.
 *
 *   - **Removal is dated, not deleted.** `review_removed` is emitted from
 *     `removed_at`, and the review row it came from is still there in full.
 *
 * Self-contained: it clears the three review types out of `customer_events` and
 * writes them back in one transaction. It used to lean on the lifecycle
 * compiler, which emptied everything that was not a payment before every rebuild
 * — and that was what removed a `review_edited` row whose id had moved on,
 * because the id folds a content hash and a rewritten review compiles to a
 * *different* row rather than an update of the old one. The compiler now
 * rewrites one merchant at a time and names the lifecycle types it owns, so
 * this has to clear its own.
 */

/** Row shape read out of `app_reviews`. */
interface ReviewRow {
  review_id: string;
  app_id: string;
  shop_id: string;
  rating: number;
  prior_rating: number | null;
  posted_on: string;
  body: string;
  store_name: string;
  country: string | null;
  permalink: string | null;
  content_hash: string;
  edited_at: string | null;
  removed_at: string | null;
}

interface ReviewEvent {
  event_id: string;
  app_id: string;
  shop_id: string;
  type: string;
  occurred_at: string;
  detail: string;
}

/**
 * The listing publishes a date and no time, so a review lands at the start of
 * its day in UTC. Everything on this timeline is compared lexically, and a
 * bare date would sort before every timestamped event of the same day rather
 * than sorting as a date at all.
 */
function startOfDay(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function detailFor(row: ReviewRow, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reviewId: row.review_id,
    rating: row.rating,
    storeName: row.store_name,
    country: row.country,
    body: row.body,
    permalink: row.permalink,
    ...extra,
  });
}

export function buildReviewEvents(db: Db): number {
  const rows = db
    .prepare(
      `SELECT review_id, app_id, shop_id, rating, prior_rating, posted_on, body,
              store_name, country, permalink, content_hash, edited_at, removed_at
         FROM app_reviews`,
    )
    .all() as ReviewRow[];

  const events: ReviewEvent[] = [];

  for (const row of rows) {
    events.push({
      event_id: `review:${row.review_id}:posted`,
      app_id: row.app_id,
      shop_id: row.shop_id,
      type: 'review_posted',
      occurred_at: startOfDay(row.posted_on),
      detail: detailFor(row),
    });

    if (row.edited_at) {
      events.push({
        // The hash makes each distinct version its own event. Without it a
        // review rewritten twice would reuse an id the ledger has already
        // delivered, and the second rewrite would never be announced.
        event_id: `review:${row.review_id}:edited:${row.content_hash.slice(0, 12)}`,
        app_id: row.app_id,
        shop_id: row.shop_id,
        type: 'review_edited',
        occurred_at: row.edited_at,
        detail: detailFor(row, { priorRating: row.prior_rating }),
      });
    }

    if (row.removed_at) {
      events.push({
        event_id: `review:${row.review_id}:removed`,
        app_id: row.app_id,
        shop_id: row.shop_id,
        type: 'review_removed',
        occurred_at: row.removed_at,
        detail: detailFor(row, { removed: true }),
      });
    }
  }

  const statement = db.prepare(
    `INSERT INTO customer_events (
       event_id, app_id, shop_id, type, occurred_at, charge_id, prev_charge_id,
       plan_name, plan_amount, billing_interval, currency, net_change, amount,
       suppressed, detail
     ) VALUES (
       @event_id, @app_id, @shop_id, @type, @occurred_at, '', '',
       NULL, NULL, NULL, NULL, NULL, NULL,
       0, @detail
     )
     ON CONFLICT(event_id) DO UPDATE SET
       shop_id = excluded.shop_id,
       type = excluded.type,
       occurred_at = excluded.occurred_at,
       detail = excluded.detail`,
  );

  const write = db.transaction((batch: ReviewEvent[]) => {
    db.prepare(
      `DELETE FROM customer_events
        WHERE type IN ('review_posted', 'review_edited', 'review_removed')`,
    ).run();
    for (const row of batch) statement.run(row);
  });

  write(events);
  return events.length;
}

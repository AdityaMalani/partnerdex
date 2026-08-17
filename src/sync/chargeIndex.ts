import type { Db } from '../db/index.js';

/**
 * The charge index: the three tables that let the derived subscription tables be
 * rebuilt one merchant at a time.
 *
 * `derive.ts` reconstructs a subscription's life, an install's span and a
 * lifecycle timeline by walking one merchant's events in order. That makes the
 * unit of invalidation an `(app_id, shop_id)` pair rather than a day — but a
 * pair on its own cannot be rebuilt, because the reconstruction reads three
 * things a pair does not contain:
 *
 *   1. **the settled sales of its charges**, which live in `transactions` and
 *      used to be found with a GROUP BY over the whole ledger;
 *   2. **the raw charge facts**, which live in `app_events` and used to be found
 *      with a GROUP BY over the whole feed;
 *   3. **the price book**, which is genuinely not local — it answers "what
 *      cadence has this app's <plan, price> been billed at *anywhere*".
 *
 * This module maintains all three, and in doing so answers the only question
 * that decides whether the per-pair rebuild is sound: **which pairs a change
 * can reach.** (1) and (2) reach exactly the pairs that hold the charge; (3)
 * reaches every pair holding a charge at a price point whose answer moved, and
 * is the reason the book is stored rather than recomputed in memory.
 *
 * Everything here marks its pairs into `derive_dirty_pairs` — the durable work
 * list — before the step that depends on having found them, so a pass that dies
 * half way leaves the work still claimed rather than silently dropped.
 */

/** `(app_id, shop_id)`: the unit a derived rebuild is invalidated in. */
export interface Pair {
  app_id: string;
  shop_id: string;
}

/**
 * Rows per statement, and per write transaction.
 *
 * Everything below is a drain: a bounded slice is read, recomputed and
 * committed, and the slice's marks go in the same transaction. Nothing holds
 * more than a slice, which is the property this repository lost once already by
 * building a derived table's whole output as one array before writing it.
 */
const CHUNK = 500;

/** `app_id`, plan name and as-billed price — what identifies a price point. */
export function priceKey(appId: string, planName: string | null, amount: number | null): string {
  return `${appId} ${planName ?? ''} ${(amount ?? 0).toFixed(2)}`;
}

/**
 * The charge dimension, as the Partner API's event feed states it.
 *
 * One row per charge, every column a fact rather than a derivation. Kept apart
 * from `subscriptions` for exactly that reason: the price book is computed from
 * these, and computing it from `subscriptions` would make the derivation depend
 * on its own output.
 */
export interface ChargeRow {
  charge_id: string;
  charge_ref: string;
  app_id: string;
  shop_id: string;
  plan_name: string | null;
  amount: number | null;
  currency: string | null;
  is_test: number;
  accepted_at: string | null;
  activated_at: string | null;
  canceled_at: string | null;
  frozen_at: string | null;
  unfrozen_at: string | null;
  billing_on: string | null;
}

export interface SaleRow {
  charge_ref: string;
  first_sale_at: string;
  last_sale_at: string;
  paid_sale_count: number;
  billing_interval: string | null;
}

const CANCEL_TYPES = [
  'SUBSCRIPTION_CHARGE_CANCELED',
  'SUBSCRIPTION_CHARGE_EXPIRED',
  'SUBSCRIPTION_CHARGE_DECLINED',
];

/**
 * The fold from raw events to one charge, unchanged from the query it replaces.
 *
 * `WHERE` is left to the caller so the same expression serves the full rebuild
 * (no restriction) and the incremental one (a set of charge ids), and so the two
 * cannot drift into computing different columns.
 */
const CHARGE_SELECT = `
  SELECT
    charge_id,
    '' AS charge_ref,
    MIN(app_id) AS app_id,
    MAX(shop_id) AS shop_id,
    COALESCE(
      MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_name END),
      MAX(charge_name)
    ) AS plan_name,
    COALESCE(
      MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN charge_amount END),
      MAX(charge_amount)
    ) AS amount,
    MAX(charge_currency) AS currency,
    MAX(charge_test) AS is_test,
    MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACCEPTED' THEN occurred_at END) AS accepted_at,
    MIN(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN occurred_at END) AS activated_at,
    MIN(CASE WHEN type IN (${CANCEL_TYPES.map((type) => `'${type}'`).join(',')}) THEN occurred_at END) AS canceled_at,
    MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_FROZEN' THEN occurred_at END) AS frozen_at,
    MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_UNFROZEN' THEN occurred_at END) AS unfrozen_at,
    COALESCE(
      MAX(CASE WHEN type = 'SUBSCRIPTION_CHARGE_ACTIVATED' THEN billing_on END),
      MAX(billing_on)
    ) AS billing_on
  FROM app_events
  WHERE charge_id <> '' AND type LIKE 'SUBSCRIPTION_CHARGE_%'`;

const CHARGE_COLUMNS = `charge_id, charge_ref, app_id, shop_id, plan_name, amount, currency,
                        is_test, accepted_at, activated_at, canceled_at, frozen_at,
                        unfrozen_at, billing_on`;

/**
 * `gid://partners/AppSubscription/1234` -> `1234`, in SQL.
 *
 * The charge ref is what a transaction names a charge by, so `charge_facts`
 * carries it beside the id rather than making every join recompute it.
 * `replace` walks off the last `/` the way `split('/').pop()` does in the
 * ingest, and a bare id passes through unchanged.
 */
const CHARGE_REF_EXPR = `REPLACE(charge_id, RTRIM(charge_id, REPLACE(charge_id, '/', '')), '')`;

// ---------------------------------------------------------------------------
// The ingest's side: marking.

/**
 * Mark the merchants an event batch wrote to.
 *
 * Marked on every write rather than only on writes that changed something, for
 * the reason `transaction_daily_dirty` gives: telling a restatement that moved a
 * figure from one that did not would mean reading the old row back, rebuilding a
 * merchant that turned out to be unchanged costs milliseconds, and missing one
 * that did change is wrong until the next full rebuild.
 */
export function markDirtyPairs(db: Db, appId: string, shopIds: Iterable<string>): void {
  const statement = db.prepare(
    'INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id) VALUES (?, ?)',
  );
  for (const shopId of shopIds) statement.run(appId, shopId);
}

/** As above, for pairs already known as pairs. */
export function markPairs(db: Db, pairs: Iterable<Pair>): void {
  const statement = db.prepare(
    'INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id) VALUES (?, ?)',
  );
  for (const pair of pairs) statement.run(pair.app_id, pair.shop_id);
}

/**
 * Mark the charges a transaction batch wrote sales for.
 *
 * Only `AppSubscriptionSale`, because that is the only type the aggregate reads.
 * A usage sale carries its own unique charge ref — four million of them in this
 * ledger — and marking those would put tens of thousands of charges no
 * subscription has ever heard of through the drain on every sync.
 */
export function markSaleCharges(db: Db, refs: Iterable<string>): void {
  const statement = db.prepare(
    'INSERT OR IGNORE INTO charge_sales_dirty (charge_ref) VALUES (?)',
  );
  for (const ref of refs) statement.run(ref);
}

// ---------------------------------------------------------------------------
// The sync's side: draining.

const SALES_SELECT = `SELECT charge_ref,
                             MIN(created_at) AS first_sale_at,
                             MAX(created_at) AS last_sale_at,
                             COUNT(*) AS paid_sale_count,
                             MAX(billing_interval) AS billing_interval
                        FROM transactions
                       WHERE type = 'AppSubscriptionSale' AND charge_ref <> '' AND gross_amount > 0`;

/**
 * Bring `charge_sales` up to date, and mark the merchants whose money moved.
 *
 * A dirty charge is deleted and recomputed from the raw rows rather than
 * adjusted, so a sale restated twice lands where restating it once lands and a
 * sale that vanished takes its row with it — a charge whose last paid sale is
 * refunded to zero loses its `charge_sales` row entirely, which is what
 * `buildSubscriptions` reads as "never paid".
 *
 * The pairs are marked from `charge_facts` *before* the marks are dropped, in
 * the same transaction, so a crash cannot lose the connection between a sale
 * that landed and the merchant it belongs to.
 */
export function syncChargeSales(db: Db, options: { full: boolean }): number {
  if (options.full) {
    db.transaction(() => {
      db.prepare('DELETE FROM charge_sales').run();
      db.prepare(
        `INSERT INTO charge_sales
           (charge_ref, first_sale_at, last_sale_at, paid_sale_count, billing_interval)
         ${SALES_SELECT} GROUP BY charge_ref`,
      ).run();
      db.prepare('DELETE FROM charge_sales_dirty').run();
    })();
    return (db.prepare('SELECT COUNT(*) AS n FROM charge_sales').get() as { n: number }).n;
  }

  const take = db.prepare('SELECT charge_ref FROM charge_sales_dirty ORDER BY charge_ref LIMIT ?');
  let done = 0;

  for (;;) {
    const refs = (take.all(CHUNK) as Array<{ charge_ref: string }>).map((row) => row.charge_ref);
    if (refs.length === 0) break;
    const list = refs.map(() => '?').join(',');

    db.transaction(() => {
      // The merchants first: a charge whose sales moved has to be rebuilt, and
      // the only record of which merchant holds it is `charge_facts`. A charge
      // whose facts have not arrived yet marks nobody, correctly — the event
      // that creates it will mark its own merchant when it lands.
      db.prepare(
        `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
         SELECT DISTINCT app_id, shop_id FROM charge_facts WHERE charge_ref IN (${list})`,
      ).run(...refs);

      db.prepare(`DELETE FROM charge_sales WHERE charge_ref IN (${list})`).run(...refs);
      db.prepare(
        `INSERT INTO charge_sales
           (charge_ref, first_sale_at, last_sale_at, paid_sale_count, billing_interval)
         ${SALES_SELECT} AND charge_ref IN (${list}) GROUP BY charge_ref`,
      ).run(...refs);
      db.prepare(`DELETE FROM charge_sales_dirty WHERE charge_ref IN (${list})`).run(...refs);
    })();

    done += refs.length;
  }

  return done;
}

/**
 * Bring `charge_facts` up to date for every marked merchant.
 *
 * The scope is a set of **charge ids**, not of pairs, and that is deliberate.
 * The fold groups by charge id with `MIN(app_id)` and `MAX(shop_id)`, so
 * restricting it to one merchant's rows would compute a different answer for a
 * charge that somehow appears under two — and a charge whose merchant *moves*
 * has to invalidate the merchant it left as well as the one it arrived at. So
 * the ids are collected from both sides, the fold runs unrestricted over them,
 * and the pairs named before and after are both marked.
 *
 * Returns how many charges were refolded.
 */
export function syncChargeFacts(db: Db, options: { full: boolean }): number {
  if (options.full) {
    db.transaction(() => {
      db.prepare('DELETE FROM charge_facts').run();
      db.prepare(
        `INSERT INTO charge_facts (${CHARGE_COLUMNS})
         SELECT charge_id, ${CHARGE_REF_EXPR}, app_id, shop_id, plan_name, amount, currency,
                is_test, accepted_at, activated_at, canceled_at, frozen_at, unfrozen_at, billing_on
           FROM (${CHARGE_SELECT} GROUP BY charge_id)`,
      ).run();
    })();
    return (db.prepare('SELECT COUNT(*) AS n FROM charge_facts').get() as { n: number }).n;
  }

  /*
   * The charges of every marked merchant, from the feed and from the stored
   * facts. A temp table rather than a subquery for the reason `stockRollup.ts`
   * records: the joins below are anti-joins on a key SQLite can only use if it
   * is a key, and left as correlated subqueries they degenerate into a rescan
   * per row.
   */
  db.exec('DROP TABLE IF EXISTS temp.derive_charges');
  db.exec('CREATE TEMP TABLE derive_charges (charge_id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.prepare(
    `INSERT OR IGNORE INTO temp.derive_charges (charge_id)
     SELECT e.charge_id FROM app_events e
       JOIN derive_dirty_pairs p ON p.app_id = e.app_id AND p.shop_id = e.shop_id
      WHERE e.charge_id <> '' AND e.type LIKE 'SUBSCRIPTION_CHARGE_%'`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO temp.derive_charges (charge_id)
     SELECT f.charge_id FROM charge_facts f
       JOIN derive_dirty_pairs p ON p.app_id = f.app_id AND p.shop_id = f.shop_id`,
  ).run();

  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM temp.derive_charges').get() as { n: number }
  ).n;

  db.transaction(() => {
    // The merchants these charges belong to *now*, before the fold moves any of
    // them. A charge that changes hands must leave the merchant it came from
    // marked, or that merchant keeps a subscription row for a charge it no
    // longer holds.
    db.prepare(
      `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
       SELECT DISTINCT f.app_id, f.shop_id FROM charge_facts f
         JOIN temp.derive_charges c ON c.charge_id = f.charge_id`,
    ).run();

    db.prepare(
      `DELETE FROM charge_facts
        WHERE charge_id IN (SELECT charge_id FROM temp.derive_charges)`,
    ).run();
    db.prepare(
      `INSERT INTO charge_facts (${CHARGE_COLUMNS})
       SELECT charge_id, ${CHARGE_REF_EXPR}, app_id, shop_id, plan_name, amount, currency,
              is_test, accepted_at, activated_at, canceled_at, frozen_at, unfrozen_at, billing_on
         FROM (${CHARGE_SELECT}
                 AND charge_id IN (SELECT charge_id FROM temp.derive_charges)
               GROUP BY charge_id)`,
    ).run();

    // And the merchants they belong to now.
    db.prepare(
      `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
       SELECT DISTINCT f.app_id, f.shop_id FROM charge_facts f
         JOIN temp.derive_charges c ON c.charge_id = f.charge_id`,
    ).run();
  })();

  db.exec('DROP TABLE IF EXISTS temp.derive_charges');
  return total;
}

/**
 * Recompute the price book, mark whoever it moved under, and store it.
 *
 * A price point seen at exactly one cadence teaches that cadence; one seen at
 * both teaches nothing and is dropped, so the book only ever answers where the
 * answer is unambiguous. That is unchanged — what is new is that the answer is
 * *compared* against the last one, because it is the only input to the
 * derivation that is not local to a merchant and therefore the only one that can
 * make a merchant wrong without anything of that merchant's having changed.
 *
 * The scan of every charge to find the dependents is paid only when a key
 * actually moved, which in the steady state is never: a book that did not move
 * marks nobody and costs one streamed pass over the charges that have settled.
 */
export function syncPriceBook(db: Db): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  const rows = db
    .prepare(
      `SELECT f.app_id AS app_id, f.plan_name AS plan_name, f.amount AS amount,
              s.billing_interval AS billing_interval
         FROM charge_facts f
         JOIN charge_sales s ON s.charge_ref = f.charge_ref
        WHERE f.is_test = 0 AND s.billing_interval IS NOT NULL`,
    )
    .iterate() as Iterable<{
    app_id: string;
    plan_name: string | null;
    amount: number | null;
    billing_interval: string;
  }>;

  for (const row of rows) {
    const key = priceKey(row.app_id, row.plan_name, row.amount);
    const intervals = seen.get(key);
    if (intervals) intervals.add(row.billing_interval);
    else seen.set(key, new Set([row.billing_interval]));
  }

  const book = new Map<string, string>();
  for (const [key, intervals] of seen) {
    const [only] = intervals;
    if (intervals.size === 1 && only) book.set(key, only);
  }

  const stored = new Map(
    (
      db.prepare('SELECT key, billing_interval FROM price_book').all() as Array<{
        key: string;
        billing_interval: string;
      }>
    ).map((row) => [row.key, row.billing_interval]),
  );

  // Both directions: a key that appeared, a key whose cadence changed, and a key
  // that stopped being unambiguous and vanished. All three move a charge that
  // was resolving through the book.
  const moved = new Set<string>();
  for (const [key, interval] of book) if (stored.get(key) !== interval) moved.add(key);
  for (const [key] of stored) if (!book.has(key)) moved.add(key);

  if (moved.size > 0) {
    const dependents = new Map<string, Pair>();
    const charges = db
      .prepare('SELECT app_id, shop_id, plan_name, amount FROM charge_facts')
      .iterate() as Iterable<{
      app_id: string;
      shop_id: string;
      plan_name: string | null;
      amount: number | null;
    }>;
    for (const charge of charges) {
      if (!moved.has(priceKey(charge.app_id, charge.plan_name, charge.amount))) continue;
      dependents.set(`${charge.app_id} ${charge.shop_id}`, {
        app_id: charge.app_id,
        shop_id: charge.shop_id,
      });
    }

    db.transaction(() => {
      markPairs(db, dependents.values());
      db.prepare('DELETE FROM price_book').run();
      const statement = db.prepare(
        'INSERT INTO price_book (key, billing_interval) VALUES (?, ?)',
      );
      for (const [key, interval] of book) statement.run(key, interval);
    })();
  }

  return book;
}

/**
 * Mark every merchant whose derivation the passage of time has changed.
 *
 * `buildSubscriptions` reads the wall clock in exactly two places, and both ask
 * the same question of the same column: has this charge's next billing date
 * arrived? A charge whose `billing_on` has crossed between the last pass and
 * this one converts, or stops reading as in-trial, with nothing about it having
 * changed at all. Nothing marks that merchant, so this does.
 *
 * The window is half-open on the left and closed on the right, exactly matching
 * `billing_on <= now`, so a charge is swept in by exactly one pass. `from` is
 * the previous pass's `now`; a missing one means the derivation has never run
 * under this scheme and the caller does a full rebuild instead.
 */
export function markClockPairs(db: Db, from: string, to: string): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
       SELECT DISTINCT app_id, shop_id FROM charge_facts
        WHERE billing_on > @from AND billing_on <= @to`,
    )
    .run({ from, to });
  return result.changes;
}

/** Every merchant the feed knows about — the seed for a full rebuild. */
export function markAllPairs(db: Db): number {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO derive_dirty_pairs (app_id, shop_id)
       SELECT DISTINCT app_id, shop_id FROM app_events
        UNION
       SELECT DISTINCT app_id, shop_id FROM charge_facts`,
    )
    .run();
  return result.changes;
}

/** The next slice of merchants owed a rebuild, in a stable order. */
export function nextDirtyPairs(db: Db, limit = CHUNK): Pair[] {
  return db
    .prepare('SELECT app_id, shop_id FROM derive_dirty_pairs ORDER BY app_id, shop_id LIMIT ?')
    .all(limit) as Pair[];
}

export function dirtyPairCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM derive_dirty_pairs').get() as { n: number }).n;
}

/**
 * Materialise a slice of merchants as a temp table, keyed.
 *
 * Keyed, and a table rather than an `OR` chain of five hundred equalities,
 * because that is the difference between five hundred index seeks and a scan of
 * the whole source per slice — the same trap `stockRollup.ts` records finding
 * the hard way. Everything read per merchant joins through this.
 */
export function loadPairs(db: Db, pairs: Pair[]): void {
  db.exec('DROP TABLE IF EXISTS temp.derive_slice');
  db.exec(
    `CREATE TEMP TABLE derive_slice (app_id TEXT NOT NULL, shop_id TEXT NOT NULL,
       PRIMARY KEY (app_id, shop_id)) WITHOUT ROWID`,
  );
  const insert = db.prepare('INSERT INTO temp.derive_slice (app_id, shop_id) VALUES (?, ?)');
  db.transaction(() => {
    for (const pair of pairs) insert.run(pair.app_id, pair.shop_id);
  })();
}

export function dropPairs(db: Db): void {
  db.exec('DROP TABLE IF EXISTS temp.derive_slice');
}

/**
 * The charges of the loaded slice of merchants.
 *
 * `CROSS JOIN` rather than `JOIN`, and it is load-bearing rather than
 * decoration: SQLite has no statistics for a temp table and assumes it is large,
 * so left to choose it drives the loop from `charge_facts` and scans every charge
 * in the database once per slice — a hundred million rows over a full rebuild,
 * measured. `CROSS JOIN` is SQLite's way of fixing the outer table, and it turns
 * the read into one index seek per merchant.
 */
export function chargesForPairs(db: Db): ChargeRow[] {
  return db
    .prepare(
      `SELECT ${CHARGE_COLUMNS.split(',').map((column) => `f.${column.trim()}`).join(', ')}
         FROM temp.derive_slice p
         CROSS JOIN charge_facts f ON f.app_id = p.app_id AND f.shop_id = p.shop_id`,
    )
    .all() as ChargeRow[];
}

/** The settled sales of the loaded slice's charges, by charge ref. See above. */
export function salesForPairs(db: Db): Map<string, SaleRow> {
  const rows = db
    .prepare(
      `SELECT s.charge_ref, s.first_sale_at, s.last_sale_at, s.paid_sale_count, s.billing_interval
         FROM temp.derive_slice p
         CROSS JOIN charge_facts f ON f.app_id = p.app_id AND f.shop_id = p.shop_id
         CROSS JOIN charge_sales s ON s.charge_ref = f.charge_ref`,
    )
    .all() as SaleRow[];
  return new Map(rows.map((row) => [row.charge_ref, row]));
}

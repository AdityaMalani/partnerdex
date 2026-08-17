import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { APP_GID, resetEnvironment } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { resetConfig } from '../src/config.js';
import { insertTransactions, type TransactionNode } from '../src/sync/ingest.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { offsetSegments, syncTransactionDaily } from '../src/sync/rollup.js';

/**
 * The rollup's claim is that a sum of daily sums is a sum over rows.
 *
 * These tests hold the write half of it: what the table contains, against the
 * ledger it was built from, after a full build, after an incremental one, and
 * after a restatement. The read half — that no metric's answer moves — is in
 * `transactionRollupReads.test.ts`.
 */

const NOW = new Date('2024-07-01T00:00:00.000Z');

function sale(
  id: string,
  createdAt: string,
  gross: number,
  overrides: Partial<TransactionNode> = {},
): TransactionNode {
  return {
    id: `gid://partners/AppUsageSale/${id}`,
    createdAt,
    __typename: 'AppUsageSale',
    app: { id: APP_GID, name: 'Test App' },
    shop: { id: 'gid://partners/Shop/10', name: 'Shop 10', myshopifyDomain: 's10.example' },
    chargeId: '',
    billingInterval: null,
    grossAmount: { amount: String(gross), currencyCode: 'USD' },
    netAmount: { amount: String(gross - 1), currencyCode: 'USD' },
    shopifyFee: { amount: '1', currencyCode: 'USD' },
    ...overrides,
  };
}

/** Amounts with awkward decimal expansions, so a rounding bug has room to show. */
const AMOUNTS = [0.07, 12.34, 199.99, 3.33, 0.01, 47.61, 1234.56, 0.99];

function seedLedger(): void {
  const db = getDb();
  const nodes: TransactionNode[] = [];
  // Several transactions per day across a couple of months, at a spread of
  // times of day, so both the whole-day interiors and the partial-day ends of a
  // window carry rows.
  for (let day = 0; day < 60; day += 1) {
    for (let n = 0; n < 4; n += 1) {
      const at = new Date(Date.UTC(2024, 3, 1, n * 6 + 1, 17, 33) + day * 86_400_000);
      nodes.push(
        sale(`${day}-${n}`, at.toISOString(), AMOUNTS[(day * 4 + n) % AMOUNTS.length]!),
      );
    }
  }
  insertTransactions(db, nodes);
  rebuildDerivedTables(db);
}

/** Every figure the rollup stores, recomputed straight off the raw table. */
function rawTotals(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, type, app_id, currency,
              SUM(gross_amount) AS gross_amount, SUM(net_amount) AS net_amount,
              SUM(shopify_fee) AS shopify_fee, COUNT(*) AS txn_count
         FROM transactions
        GROUP BY 1, 2, 3, 4
        ORDER BY 1, 2, 3, 4`,
    )
    .all() as Array<Record<string, unknown>>;
}

function rollupRows(): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT day, type, app_id, currency, gross_amount, net_amount, shopify_fee, txn_count
         FROM transaction_daily ORDER BY day, type, app_id, currency`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe('the daily transaction rollup', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  it('stores exactly what the ledger says, cell for cell', () => {
    seedLedger();
    // The fixture runs in UTC, so the raw grouping by the date prefix is an
    // independent second opinion on the day each row was filed under.
    assert.deepEqual(rollupRows(), rawTotals());
  });

  /**
   * Counts are integers and must match outright. Money is stored as the source
   * stores it, as binary floating point, and adding a hundred subtotals is not
   * bit-for-bit the same operation as adding ten thousand rows — floating-point
   * addition is not associative, and no arrangement of a rollup can make it so.
   *
   * Storing integer cents instead would make the *table* exact and the data
   * wrong: this ledger carries amounts with more than two decimal places, and
   * rounding them on the way in would quietly lose money that the raw table
   * still has. So the residual is left where it is, bounded, and asserted at the
   * size it actually is — parts in a hundred billion, orders of magnitude below
   * the cent every one of these figures is presented at. The metric responses
   * themselves are compared for equality outright, further down.
   */
  it('sums to the ledger total, to within one bit of the last place', () => {
    seedLedger();
    const db = getDb();
    const rollup = db
      .prepare(
        'SELECT SUM(gross_amount) AS g, SUM(net_amount) AS n, SUM(shopify_fee) AS f, SUM(txn_count) AS c FROM transaction_daily',
      )
      .get() as Record<string, number>;
    const raw = db
      .prepare(
        'SELECT SUM(gross_amount) AS g, SUM(net_amount) AS n, SUM(shopify_fee) AS f, COUNT(*) AS c FROM transactions',
      )
      .get() as Record<string, number>;

    assert.equal(rollup.c, raw.c);
    for (const column of ['g', 'n', 'f'] as const) {
      const difference = Math.abs(rollup[column]! - raw[column]!);
      assert.ok(
        difference <= Math.abs(raw[column]!) * Number.EPSILON * 8,
        `${column} drifted by ${difference}, which is more than rounding can explain`,
      );
      assert.equal(Math.round(rollup[column]! * 100), Math.round(raw[column]! * 100));
    }
  });
});

describe('incremental maintenance', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  it('touches only the days a sync ingested', () => {
    seedLedger();
    const db = getDb();
    const before = rollupRows();

    insertTransactions(db, [sale('late-1', '2024-06-15T04:00:00.000Z', 5)]);
    const result = syncTransactionDaily(db);

    assert.equal(result.full, false, 'a one-day arrival must not rebuild everything');
    // The marked UTC day plus one either side — the widening that makes the
    // drain safe in any timezone. Nothing beyond it.
    assert.equal(result.days, 3);

    const after = rollupRows();
    const changed = after.filter(
      (row, index) => JSON.stringify(row) !== JSON.stringify(before[index]),
    );
    assert.equal(changed.length, 1);
    assert.equal(changed[0]!.day, '2024-06-15');
    assert.deepEqual(after, rawTotals());
  });

  it('files a transaction that arrives long after its own day', () => {
    seedLedger();
    const db = getDb();

    insertTransactions(db, [sale('backdated', '2024-04-02T11:00:00.000Z', 77.77)]);
    syncTransactionDaily(db);

    assert.deepEqual(rollupRows(), rawTotals());
    const day = db
      .prepare('SELECT txn_count FROM transaction_daily WHERE day = ?')
      .get('2024-04-02') as { txn_count: number };
    assert.equal(day.txn_count, 5);
  });

  it('rebuilds wholesale rather than seeking when a backfill dirties everything', () => {
    seedLedger();
    // A first import marks every day it carries, and past a couple of months of
    // them one pass beats many seeks.
    assert.equal(syncTransactionDaily(getDb(), { full: false }).full, false);

    const db = getDb();
    const nodes: TransactionNode[] = [];
    for (let day = 0; day < 120; day += 1) {
      const at = new Date(Date.UTC(2023, 0, 1) + day * 86_400_000);
      nodes.push(sale(`bulk-${day}`, at.toISOString(), 1.11));
    }
    insertTransactions(db, nodes);
    assert.equal(syncTransactionDaily(db).full, true);
    assert.deepEqual(rollupRows(), rawTotals());
  });
});

describe('restatement', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  /**
   * The Partner API re-serves rows it has already served, with corrected
   * amounts. A rollup that adds the correction to what it already held, or that
   * never hears about it at all, is wrong from then on and says nothing.
   */
  it('corrects the day when an already-ingested transaction is restated', () => {
    seedLedger();
    const db = getDb();
    const original = db
      .prepare('SELECT gross_amount AS g FROM transaction_daily WHERE day = ?')
      .get('2024-04-05') as { g: number };

    // Same id, different money: an upsert, not an insert.
    insertTransactions(db, [sale('4-0', '2024-04-05T01:17:33.000Z', 500)]);
    syncTransactionDaily(db);

    const corrected = db
      .prepare('SELECT gross_amount AS g FROM transaction_daily WHERE day = ?')
      .get('2024-04-05') as { g: number };
    assert.notEqual(corrected.g, original.g);
    assert.deepEqual(rollupRows(), rawTotals());
  });

  it('is unchanged by a restatement that restates nothing', () => {
    seedLedger();
    const db = getDb();
    const before = rollupRows();

    // The amount the fixture already gave this row, so nothing actually moves.
    insertTransactions(db, [sale('4-0', '2024-04-05T01:17:33.000Z', AMOUNTS[16 % AMOUNTS.length]!)]);
    syncTransactionDaily(db);

    // Recomputed from the raw rows rather than adjusted, so applying the same
    // fact twice lands in the same place.
    assert.deepEqual(rollupRows(), before);
  });

  /**
   * The other direction of the same property: a day whose rows all went away
   * loses its rollup row, because the day is recomputed rather than adjusted.
   */
  it('empties a day whose last transaction is gone', () => {
    seedLedger();
    const db = getDb();
    db.prepare("DELETE FROM transactions WHERE created_at LIKE '2024-04-05%'").run();
    db.prepare('INSERT OR IGNORE INTO transaction_daily_dirty (day) VALUES (?)').run('2024-04-05');
    syncTransactionDaily(db);

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM transaction_daily WHERE day = ?')
      .get('2024-04-05') as { n: number };
    assert.equal(remaining.n, 0);
    assert.deepEqual(rollupRows(), rawTotals());
  });
});

describe('reporting timezone', () => {
  beforeEach(() => resetEnvironment({ METRICS_INCLUDE_USAGE: 'true' }));

  it('files a row under its local day, not its UTC one', () => {
    resetEnvironment({ METRICS_INCLUDE_USAGE: 'true', REPORTING_TIMEZONE: 'America/Los_Angeles' });
    const db = getDb();
    // 03:00 UTC on the 6th is 20:00 on the 5th in that zone.
    insertTransactions(db, [sale('tz', '2024-04-06T03:00:00.000Z', 10)]);
    rebuildDerivedTables(db);

    const rows = db.prepare('SELECT day FROM transaction_daily').all() as Array<{ day: string }>;
    assert.deepEqual(rows, [{ day: '2024-04-05' }]);
  });

  it('rebuilds from scratch when the reporting timezone changes', () => {
    seedLedger();
    // Changed in place rather than through `resetEnvironment`, which would also
    // hand back a fresh database and leave nothing to rebuild.
    process.env.REPORTING_TIMEZONE = 'Asia/Tokyo';
    resetConfig();

    // The day keys mean something else now, so there is nothing to patch.
    const result = syncTransactionDaily(getDb());
    assert.equal(result.full, true);

    const rows = getDb()
      .prepare('SELECT day, txn_count FROM transaction_daily ORDER BY day')
      .all() as Array<{ day: string; txn_count: number }>;
    // Tokyo is nine hours ahead, so the fixture's 01:17 and 07:17 UTC rows move
    // to the following local day and the series gains a day at its end.
    assert.equal(rows[0]!.day, '2024-04-01');
    assert.equal(
      rows.reduce((total, row) => total + row.txn_count, 0),
      240,
    );
  });

  it('finds a zone\'s offset changes to the millisecond', () => {
    // Spring forward 2024 in that zone is 10:00 UTC on 10 March.
    const segments = offsetSegments(
      new Date('2024-03-01T00:00:00.000Z'),
      new Date('2024-03-20T00:00:00.000Z'),
      'America/Los_Angeles',
    );
    assert.equal(segments.length, 2);
    assert.equal(segments[0]!.start, '');
    assert.equal(segments[0]!.seconds, -8 * 3600);
    assert.equal(segments[1]!.start, '2024-03-10T10:00:00.000Z');
    assert.equal(segments[1]!.seconds, -7 * 3600);
  });

  it('collapses to a single segment in a zone that never shifts', () => {
    const segments = offsetSegments(
      new Date('2015-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      'UTC',
    );
    assert.deepEqual(segments, [{ start: '', seconds: 0 }]);
  });

});

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDb, readSyncState, writeSyncState } from '../src/db/index.js';
import { runSync, transactionsKey } from '../src/sync/index.js';
import { addDays, toUtcIso } from '../src/metrics/time.js';
import { getPrimaryOrg } from '../src/config.js';
import { ORG_ID, resetEnvironment } from './helpers.js';

/**
 * The two ways a pass could leave the sync behind its own data.
 *
 * Both are about state written between passes rather than about any single
 * request, so the fake below is a *stateful* Partner API: it holds a history,
 * it narrows a fresh query by `createdAtMin`, and — this is the part that
 * matters — it treats a cursor as a position in the query that produced it. That
 * is what a Relay cursor is. A server that reinterpreted an old cursor under a
 * new filter would be doing the client a favour it is not obliged to do, and the
 * client must not depend on the favour.
 */

const OVERLAP_DAYS = 3;
const APP_GID = 'gid://partners/App/111';

interface Row {
  id: string;
  createdAt: string;
}

/** A history of one row per hour, oldest first, ending at `end`. */
function history(count: number, end: string): Row[] {
  const last = Date.parse(end);
  return Array.from({ length: count }, (_, index) => ({
    id: `gid://partners/AppSubscriptionSale/${index}`,
    createdAt: new Date(last - (count - 1 - index) * 3_600_000).toISOString(),
  }));
}

function node(row: Row): unknown {
  return {
    id: row.id,
    createdAt: row.createdAt,
    __typename: 'AppSubscriptionSale',
    app: { id: APP_GID, name: 'Test App' },
    shop: { id: 'gid://partners/Shop/1', name: 'Shop', myshopifyDomain: 's.example' },
    chargeId: 'gid://shopify/AppSubscription/1',
    billingInterval: 'EVERY_30_DAYS',
    grossAmount: { amount: '10', currencyCode: 'USD' },
    netAmount: { amount: '9', currencyCode: 'USD' },
    shopifyFee: { amount: '1', currencyCode: 'USD' },
  };
}

interface Ask {
  after: string | null;
  createdAtMin: string | null;
}

interface Fake {
  /** Every transactions query this pass made, in order. */
  asks: Ask[];
  /** How many transaction rows the fake handed over. */
  served: number;
  /** Serve this many transaction pages, then reject the rest. */
  failAfterPages: number | null;
  restore(): void;
}

/**
 * A Partner API with a real connection behind it.
 *
 * `pageSize` is deliberately tiny so an interruption lands in the middle of a
 * walk rather than at either end of it.
 */
function fakePartnerApi(rows: Row[], pageSize = 2): Fake {
  const originalFetch = globalThis.fetch;
  const fake: Fake = {
    asks: [],
    served: 0,
    failAfterPages: null,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
  let pages = 0;

  const ok = (body: unknown): Response =>
    new Response(JSON.stringify({ data: body }), { status: 200 });

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as {
      query: string;
      variables: { after?: string | null; createdAtMin?: string };
    };

    if (!query.includes('PartnerdexTransactions')) {
      // Events and everything else: nothing to report.
      return ok({ app: { events: { pageInfo: { hasNextPage: false }, edges: [] } } });
    }

    const after = variables.after ?? null;
    const createdAtMin = variables.createdAtMin ?? null;
    fake.asks.push({ after, createdAtMin });

    if (fake.failAfterPages !== null && pages >= fake.failAfterPages) {
      // A pass cut off mid-walk, with its cursor already stored. 401 rather
      // than 500 because the client retries a 500 and this has to bite once.
      return new Response('gone', { status: 401 });
    }
    pages += 1;

    /*
     * A fresh query is narrowed by `createdAtMin`. A query carrying a cursor is
     * a continuation of the one that issued it, so it resumes at that position
     * in history and the filter supplied alongside is not reapplied — the
     * behaviour reproduced at scale in `scripts/window-probe.ts`.
     */
    const from = after === null ? 0 : rows.findIndex((row) => row.id === after) + 1;
    const edges: Array<{ cursor: string; node: unknown }> = [];
    let index = from;
    for (; index < rows.length && edges.length < pageSize; index += 1) {
      const row = rows[index] as Row;
      if (after === null && createdAtMin && row.createdAt < createdAtMin) continue;
      edges.push({ cursor: row.id, node: node(row) });
    }

    fake.served += edges.length;
    return ok({ transactions: { pageInfo: { hasNextPage: index < rows.length }, edges } });
  }) as unknown as typeof fetch;

  return fake;
}

function key(): string {
  return transactionsKey(getPrimaryOrg(), null);
}

/** The window a pass will ask for, given what is recorded. */
function windowFor(syncedThrough: string | null): string {
  if (!syncedThrough) return toUtcIso('2020-01-01T00:00:00Z');
  return toUtcIso(addDays(new Date(syncedThrough), -OVERLAP_DAYS));
}

function bankedIds(): string[] {
  return (getDb().prepare('SELECT id FROM transactions ORDER BY id').all() as Array<{ id: string }>)
    .map((row) => row.id);
}

/** `PARTNER_APP_IDS` empty, so the pass covers every app rather than a named one. */
function environment(overrides: Record<string, string> = {}): void {
  resetEnvironment({ PARTNER_APP_IDS: '', ...overrides });
}

describe('the watermark only ever moves forward', () => {
  beforeEach(() => environment());

  /**
   * The production shape: a pass that does not reach the newest row. Its own
   * rows are all it knows, and the largest of them is behind the recorded mark.
   * Writing that back puts the sync permanently behind its own data — the window
   * is derived from the mark, so it is re-read on every pass from then on.
   */
  it('does not regress when a pass stops short of the newest row', async () => {
    const rows = history(20, '2026-08-15T12:00:00Z');
    const recorded = rows[rows.length - 1]?.createdAt as string;
    writeSyncState(getDb(), key(), { syncedThrough: recorded });

    // Everything this pass can see is older than what is already recorded: the
    // fake's history stops well before the mark.
    const fake = fakePartnerApi(rows.slice(0, 5));
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    assert.equal(readSyncState(getDb(), key()).syncedThrough, recorded);
  });

  it('moves forward when a pass does reach newer rows', async () => {
    const rows = history(20, '2026-08-15T12:00:00Z');
    writeSyncState(getDb(), key(), { syncedThrough: rows[10]?.createdAt as string });

    const fake = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    assert.equal(
      readSyncState(getDb(), key()).syncedThrough,
      toUtcIso(rows[rows.length - 1]?.createdAt as string),
    );
  });

  /**
   * An empty pass used to stamp the wall clock, which is a watermark no row
   * supports — and forward of the data rather than behind it, so the next pass
   * skips everything before it bar the overlap. On a first sync that finds
   * nothing, that is the whole of history skipped and never asked for again.
   */
  it('leaves the watermark alone when a pass returns no rows', async () => {
    const recorded = '2026-08-01T00:00:00.000Z';
    writeSyncState(getDb(), key(), { syncedThrough: recorded });

    const fake = fakePartnerApi([]);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    assert.equal(readSyncState(getDb(), key()).syncedThrough, recorded);
  });

  it('records no watermark at all when the very first pass returns no rows', async () => {
    const fake = fakePartnerApi([]);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    // Null, not "now": the next pass must still start at SYNC_START_DATE.
    assert.equal(readSyncState(getDb(), key()).syncedThrough, null);
  });
});

describe('a cursor belongs to the window it was made for', () => {
  beforeEach(() => environment());

  /**
   * The over-walk. A cursor left by a pass over a much wider window resumes
   * *that* walk, so the pass reads history it has no reason to read and the rows
   * it was started for go unfetched. Discarding the cursor costs one clean walk
   * of the window it actually wants.
   */
  it('discards a cursor produced under a different window', async () => {
    // Eight days of history, so the three-day window is a genuine minority of it
    // and "walked the window" is distinguishable from "walked everything".
    const rows = history(200, '2026-08-15T12:00:00Z');
    const recorded = rows[195]?.createdAt as string;
    const window = windowFor(recorded);

    writeSyncState(getDb(), key(), {
      syncedThrough: recorded,
      // Deep in history, from a pass that was walking everything.
      cursor: rows[2]?.id as string,
      cursorWindow: windowFor(null),
    });

    const fake = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    // Started clean, and started at the window it computed for itself.
    assert.deepEqual(fake.asks[0], { after: null, createdAtMin: window });
    // And it read the window rather than the back half of history.
    const inWindow = rows.filter((row) => row.createdAt >= window).length;
    assert.equal(fake.served, inWindow);
    assert.ok(fake.served < rows.length, 'a discarded cursor must not become a full re-walk');
  });

  /** A legacy cursor carries no window, which is not a match and must not be trusted. */
  it('discards a cursor stored before windows were recorded', async () => {
    const rows = history(40, '2026-08-15T12:00:00Z');
    const recorded = rows[35]?.createdAt as string;
    writeSyncState(getDb(), key(), { syncedThrough: recorded });
    // Straight to the column, because `writeSyncState` will not write a cursor
    // without a window any more. This is what an existing database holds.
    getDb().prepare('UPDATE sync_state SET cursor = ? WHERE key = ?').run(rows[2]?.id, key());

    const fake = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    assert.equal(fake.asks[0]?.after, null);
  });

  it('resumes from a cursor produced under the same window', async () => {
    const rows = history(40, '2026-08-15T12:00:00Z');
    const recorded = rows[35]?.createdAt as string;
    const window = windowFor(recorded);
    const resumeFrom = rows[37]?.id as string;

    writeSyncState(getDb(), key(), {
      syncedThrough: recorded,
      cursor: resumeFrom,
      cursorWindow: window,
    });

    const fake = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      fake.restore();
    }

    assert.equal(fake.asks[0]?.after, resumeFrom);
    // Only the tail after the cursor, not the whole window again.
    assert.equal(fake.served, rows.length - 38);
    assert.deepEqual(bankedIds().sort(), rows.slice(38).map((row) => row.id).sort());
  });

  /**
   * The reason the cursor is kept at all: an interrupted pass has to be able to
   * carry on, and the two halves together have to bank what one clean pass would
   * have banked.
   */
  it('banks the same rows whether or not the pass was interrupted', async () => {
    const rows = history(12, '2026-08-15T12:00:00Z');

    const clean = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      clean.restore();
    }
    const uninterrupted = bankedIds();
    const watermark = readSyncState(getDb(), key()).syncedThrough;
    assert.equal(uninterrupted.length, rows.length);

    // A second database, and the same history read in two halves.
    environment();

    const first = fakePartnerApi(rows);
    first.failAfterPages = 3;
    try {
      await assert.rejects(() => runSync());
    } finally {
      first.restore();
    }

    const midway = readSyncState(getDb(), key());
    assert.ok(midway.cursor, 'an interrupted pass leaves its cursor');
    assert.equal(midway.cursorWindow, windowFor(midway.syncedThrough));

    const second = fakePartnerApi(rows);
    try {
      await runSync();
    } finally {
      second.restore();
    }

    assert.deepEqual(bankedIds(), uninterrupted);
    assert.equal(readSyncState(getDb(), key()).syncedThrough, watermark);
    // Resumed rather than restarted: the second half asked from the cursor.
    assert.equal(second.asks[0]?.after, midway.cursor);
    // And the pass that finished cleared the cursor and its window together.
    assert.deepEqual(
      { ...readSyncState(getDb(), key()), syncedThrough: null },
      { cursor: null, cursorWindow: null, syncedThrough: null },
    );
  });
});

describe('the cursor_window column on an existing database', () => {
  /**
   * The schema block runs before migrations on every open, so a column has to
   * exist in both places or an old file gets it from neither. The only way to
   * see the difference is to open a file written before it.
   */
  it('is added to a database whose sync_state predates it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdx-watermark-'));
    const file = path.join(dir, 'legacy.db');
    try {
      const legacy = new Database(file);
      legacy.exec(`
        CREATE TABLE sync_state (
          key            TEXT PRIMARY KEY,
          cursor         TEXT,
          synced_through TEXT,
          updated_at     TEXT NOT NULL
        ) WITHOUT ROWID;
      `);
      legacy
        .prepare('INSERT INTO sync_state VALUES (?, ?, ?, ?)')
        .run(`org:${ORG_ID}:transactions:all`, 'legacy-cursor', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      legacy.close();

      resetEnvironment({ DATABASE_PATH: file });
      const state = readSyncState(getDb(), `org:${ORG_ID}:transactions:all`);
      // The column is there, the row survived, and its cursor reads as
      // provenance-unknown rather than as belonging to some window.
      assert.deepEqual(state, {
        cursor: 'legacy-cursor',
        cursorWindow: null,
        syncedThrough: '2026-08-01T00:00:00.000Z',
      });
      closeDb();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

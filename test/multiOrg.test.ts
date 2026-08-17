import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  ConfigError,
  getConfig,
  getOrg,
  getPrimaryOrg,
  resetConfig,
  type PartnerOrg,
} from '../src/config.js';
import { closeDb, getDb, readSyncState, writeSyncState } from '../src/db/index.js';
import { PartnerApiError, partnerQuery } from '../src/partner/client.js';
import { eventsKey, resolveScopedAppIds, runSync, transactionsKey } from '../src/sync/index.js';
import { upsertApp } from '../src/sync/ingest.js';
import { ORG_ID, OTHER_ORG_ID, resetEnvironment } from './helpers.js';

/**
 * Multi-organization support, and the two silent-data-loss paths it has to
 * close: a call that does not say which organization it is for, and a sync
 * watermark that two organizations share.
 */

const scratch: string[] = [];

function scratchPath(name: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdx-multiorg-')), name);
  scratch.push(path.dirname(file));
  return file;
}

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe('configuring organizations', () => {
  beforeEach(() => resetEnvironment());

  it('reads the legacy single-org variables as exactly one organization', () => {
    const { partner } = getConfig();
    assert.equal(partner.orgs.length, 1);
    assert.equal(partner.orgs[0]?.organizationId, ORG_ID);
    assert.equal(partner.orgs[0]?.token, 'test-token');
    // The label falls back to the id rather than to an empty string.
    assert.equal(partner.orgs[0]?.label, ORG_ID);
    assert.equal(
      partner.orgs[0]?.endpoint,
      `https://partners.shopify.com/${ORG_ID}/api/2026-07/graphql.json`,
    );
  });

  /**
   * The migration path that matters: an existing deployment adds two secrets
   * and changes none of the ones it already has.
   */
  it('adds an indexed organization alongside the legacy pair', () => {
    resetEnvironment({
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
      PARTNER_ORG_2_LABEL: 'Invoice Falcon',
    });

    const { orgs } = getConfig().partner;
    assert.deepEqual(
      orgs.map((org) => [org.organizationId, org.token, org.label]),
      [
        [ORG_ID, 'test-token', ORG_ID],
        [OTHER_ORG_ID, 'second-token', 'Invoice Falcon'],
      ],
    );
    // The legacy org stays primary, which is what the apps backfill relies on.
    assert.equal(getPrimaryOrg().organizationId, ORG_ID);
  });

  it('runs on the indexed variables alone, with no legacy pair', () => {
    resetEnvironment();
    delete process.env.PARTNER_ORGANIZATION_ID;
    delete process.env.PARTNER_API_TOKEN;
    process.env.PARTNER_ORG_1_ID = OTHER_ORG_ID;
    process.env.PARTNER_ORG_1_TOKEN = 'only-token';
    resetConfig();

    const { orgs } = getConfig().partner;
    assert.equal(orgs.length, 1);
    assert.equal(orgs[0]?.organizationId, OTHER_ORG_ID);
  });

  it('orders indexed organizations numerically, not lexically', () => {
    resetEnvironment({
      PARTNER_ORG_10_ID: '1010',
      PARTNER_ORG_10_TOKEN: 'ten',
      PARTNER_ORG_2_ID: '202',
      PARTNER_ORG_2_TOKEN: 'two',
    });
    assert.deepEqual(
      getConfig().partner.orgs.map((org) => org.organizationId),
      [ORG_ID, '202', '1010'],
    );
  });

  it('refuses the same organization configured twice', () => {
    resetEnvironment({ PARTNER_ORG_2_ID: ORG_ID, PARTNER_ORG_2_TOKEN: 'duplicate' });
    assert.throws(() => getConfig(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /configured twice/);
      return true;
    });
  });

  it('refuses an organization with no token', () => {
    resetEnvironment({ PARTNER_ORG_2_ID: OTHER_ORG_ID });
    assert.throws(() => getConfig(), ConfigError);
  });

  it('refuses an organization id that is not the numeric id', () => {
    resetEnvironment({
      PARTNER_ORG_2_ID: 'my-org-handle',
      PARTNER_ORG_2_TOKEN: 'token',
    });
    assert.throws(() => getConfig(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /numeric organization id/);
      return true;
    });
  });

  /** The original error for the original mistake, unchanged. */
  it('refuses to start with no organization at all', () => {
    resetEnvironment();
    delete process.env.PARTNER_ORGANIZATION_ID;
    resetConfig();
    assert.throws(() => getConfig(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /PARTNER_ORGANIZATION_ID/);
      return true;
    });
  });

  /**
   * An unknown organization is refused, not defaulted. If this ever returned
   * `orgs[0]` instead, a row attributed to an org whose token was removed would
   * quietly be re-synced through a different organization's credential.
   */
  it('refuses to resolve credentials for an organization it does not have', () => {
    assert.throws(() => getOrg(OTHER_ORG_ID), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, new RegExp(OTHER_ORG_ID));
      return true;
    });
    assert.equal(getOrg(ORG_ID).token, 'test-token');
  });
});

describe('a Partner API call must name its organization', () => {
  beforeEach(() => resetEnvironment());

  /*
   * `partnerQuery(org, …)` is typed with `org` required and first, so a call
   * site that forgets it does not compile. This covers the callers the compiler
   * cannot see — a JS import, a stub, an `any` in the middle of a chain — where
   * the alternative to failing is querying whichever organization happened to
   * be first and filing the answer under the other one's app.
   */
  it('fails loudly rather than defaulting to the first organization', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('unreachable');
    }) as typeof fetch;

    try {
      await assert.rejects(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (partnerQuery as any)(undefined, 'query { x }'),
        (error: unknown) => {
          assert.ok(error instanceof PartnerApiError);
          assert.match(error.message, /without an organization/);
          return true;
        },
      );
      assert.equal(called, false, 'no request may be sent without an organization');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends the organization it was given, not the primary one', async () => {
    resetEnvironment({ PARTNER_ORG_2_ID: OTHER_ORG_ID, PARTNER_ORG_2_TOKEN: 'second-token' });
    const second = getOrg(OTHER_ORG_ID);

    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; token: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        token: String((init.headers as Record<string, string>)['X-Shopify-Access-Token']),
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await partnerQuery(second, 'query { ok }');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, new RegExp(`/${OTHER_ORG_ID}/api/`));
    assert.equal(seen[0]!.token, 'second-token');
  });
});

describe('sync watermarks are namespaced per organization', () => {
  beforeEach(() => resetEnvironment());

  function org(id: string): PartnerOrg {
    return {
      organizationId: id,
      token: `token-${id}`,
      label: id,
      apiVersion: '2026-07',
      endpoint: `https://partners.shopify.com/${id}/api/2026-07/graphql.json`,
    };
  }

  it('gives two organizations different keys for the same scope', () => {
    assert.notEqual(transactionsKey(org('A'), null), transactionsKey(org('B'), null));
    assert.equal(transactionsKey(org('A'), null), 'org:A:transactions:all');
    assert.equal(transactionsKey(org('A'), '111'), 'org:A:transactions:111');
    assert.equal(eventsKey(org('A'), '111'), 'org:A:events:111');
    assert.notEqual(eventsKey(org('A'), '111'), eventsKey(org('B'), '111'));
  });

  /**
   * The failure this prevents: org B finishes a run and pushes the shared
   * `transactions:all` watermark to today, so org A's next run starts from
   * today and never reads the years it had not reached. It reports success and
   * loses the data silently.
   */
  it('does not let one organization advance another organization\'s watermark', () => {
    const db = getDb();
    writeSyncState(db, transactionsKey(org('A'), null), {
      cursor: null,
      syncedThrough: '2015-06-01T00:00:00.000Z',
    });
    writeSyncState(db, transactionsKey(org('B'), null), {
      cursor: null,
      syncedThrough: '2026-08-01T00:00:00.000Z',
    });

    assert.equal(
      readSyncState(db, transactionsKey(org('A'), null)).syncedThrough,
      '2015-06-01T00:00:00.000Z',
    );
  });
});

describe('apps carry the organization they came from', () => {
  beforeEach(() => resetEnvironment());

  it('records the organization on every app and filters by it', () => {
    const db = getDb();
    process.env.PARTNER_APP_IDS = '';
    resetConfig();
    upsertApp(db, { id: 'gid://partners/App/111', name: 'A', apiKey: null }, ORG_ID);
    upsertApp(db, { id: 'gid://partners/App/222', name: 'B', apiKey: null }, OTHER_ORG_ID);

    assert.deepEqual(resolveScopedAppIds(db, ORG_ID), ['111']);
    assert.deepEqual(resolveScopedAppIds(db, OTHER_ORG_ID), ['222']);
  });

  /**
   * Unfiltered stays unfiltered. Every report, the dashboard app list, the
   * notifier and the affiliate ledger read this, and defaulting it to one
   * organization would drop the other org's apps out of figures that used to
   * include every app this instance covers.
   */
  it('returns every organization\'s apps when no organization is named', () => {
    const db = getDb();
    process.env.PARTNER_APP_IDS = '';
    resetConfig();
    upsertApp(db, { id: 'gid://partners/App/111', name: 'A', apiKey: null }, ORG_ID);
    upsertApp(db, { id: 'gid://partners/App/222', name: 'B', apiKey: null }, OTHER_ORG_ID);

    assert.deepEqual(resolveScopedAppIds(db), ['111', '222']);
  });

  it('intersects the flat PARTNER_APP_IDS allowlist with the organization', () => {
    const db = getDb();
    process.env.PARTNER_APP_IDS = '111,222';
    resetConfig();
    upsertApp(db, { id: 'gid://partners/App/111', name: 'A', apiKey: null }, ORG_ID);
    upsertApp(db, { id: 'gid://partners/App/222', name: 'B', apiKey: null }, OTHER_ORG_ID);
    upsertApp(db, { id: 'gid://partners/App/333', name: 'C', apiKey: null }, ORG_ID);

    assert.deepEqual(resolveScopedAppIds(db, ORG_ID), ['111']);
    assert.deepEqual(resolveScopedAppIds(db, OTHER_ORG_ID), ['222']);
  });
});

/**
 * The migration, against a database shaped like one that already exists.
 *
 * Every test elsewhere in this suite opens `:memory:`, where the schema block
 * creates `apps` complete and the ALTER never runs — so none of them can see a
 * migration that is wrong for an existing file. These build the old shape by
 * hand and open it with the current code.
 */
describe('migrating a database that predates multi-org', () => {
  /** A database as it was before `apps.org_id` existed, with real data in it. */
  function legacyDatabase(): string {
    const file = scratchPath('legacy.db');
    const db = new Database(file);
    db.exec(`
      CREATE TABLE apps (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        api_key        TEXT,
        discovered_at  TEXT NOT NULL
      );
      CREATE TABLE sync_state (
        key            TEXT PRIMARY KEY,
        cursor         TEXT,
        synced_through TEXT,
        updated_at     TEXT NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO apps VALUES ('111', 'Existing App', 'key-1', '2024-01-01T00:00:00Z');
      INSERT INTO apps VALUES ('222', 'Another App', NULL, '2024-01-02T00:00:00Z');
      INSERT INTO sync_state VALUES
        ('transactions:all', NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00Z'),
        ('transactions:111', 'cursor-abc', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00Z'),
        ('events:111', NULL, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00Z'),
        ('reviews:111', NULL, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00Z'),
        ('bigquery:111', NULL, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00Z');
    `);
    db.close();
    return file;
  }

  it('adds the column, backfills it, and keeps every row', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    const db = getDb();

    const apps = db.prepare('SELECT id, org_id, name, api_key FROM apps ORDER BY id').all();
    assert.deepEqual(apps, [
      { id: '111', org_id: ORG_ID, name: 'Existing App', api_key: 'key-1' },
      { id: '222', org_id: ORG_ID, name: 'Another App', api_key: null },
    ]);
    closeDb();
  });

  /**
   * The expensive half. The production backfill is 8.6M rows and many hours;
   * losing these watermarks means starting it again from `SYNC_START_DATE`.
   */
  it('renames the watermark keys instead of stranding them', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    const db = getDb();

    assert.equal(
      readSyncState(db, `org:${ORG_ID}:transactions:all`).syncedThrough,
      '2026-08-01T00:00:00.000Z',
    );
    const scoped = readSyncState(db, `org:${ORG_ID}:transactions:111`);
    assert.equal(scoped.syncedThrough, '2026-08-02T00:00:00.000Z');
    assert.equal(scoped.cursor, 'cursor-abc', 'an interrupted run must still resume');
    assert.equal(
      readSyncState(db, `org:${ORG_ID}:events:111`).syncedThrough,
      '2026-08-03T00:00:00.000Z',
    );

    // Nothing left behind under the old names.
    const stale = db
      .prepare(`SELECT key FROM sync_state WHERE key LIKE 'transactions:%' OR key LIKE 'events:%'`)
      .all();
    assert.deepEqual(stale, []);
    closeDb();
  });

  /** App-scoped, organization-agnostic keys are not touched. */
  it('leaves review and BigQuery watermarks alone', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    const db = getDb();

    assert.equal(readSyncState(db, 'reviews:111').syncedThrough, '2026-07-01T00:00:00.000Z');
    assert.equal(readSyncState(db, 'bigquery:111').syncedThrough, '2026-07-02T00:00:00.000Z');
    closeDb();
  });

  /**
   * The index is created in `migrate()` and not in the schema block, because
   * the schema block runs on every open *before* migrations and an index naming
   * a column an old database does not have yet takes the whole process down.
   * Opening a legacy file is the only test that can see the difference.
   */
  it('creates the org index on an old database and on a new one', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    const indexes = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'apps'`)
      .all() as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === 'idx_apps_org'));
    closeDb();

    resetEnvironment();
    const fresh = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'apps'`)
      .all() as Array<{ name: string }>;
    assert.ok(fresh.some((row) => row.name === 'idx_apps_org'));
  });

  it('is idempotent across repeated opens', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    getDb();
    closeDb();
    resetEnvironment({ DATABASE_PATH: file });
    const db = getDb();

    // Not double-prefixed, and still one row per key.
    assert.equal(
      readSyncState(db, `org:${ORG_ID}:transactions:all`).syncedThrough,
      '2026-08-01T00:00:00.000Z',
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM sync_state').get() as { n: number };
    assert.equal(count.n, 5);
    closeDb();
  });

  /**
   * Backfilling to `orgs[0]` is only correct because `orgs[0]` is the legacy
   * pair when the legacy pair is set — the rows can only have come from the org
   * that was the single configured one when they were written.
   */
  it('backfills to the legacy organization even when a second one is configured', () => {
    const file = legacyDatabase();
    resetEnvironment({
      DATABASE_PATH: file,
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
    });
    const db = getDb();

    const orgs = db.prepare('SELECT DISTINCT org_id FROM apps').all();
    assert.deepEqual(orgs, [{ org_id: ORG_ID }]);
    assert.equal(
      readSyncState(db, `org:${ORG_ID}:transactions:all`).syncedThrough,
      '2026-08-01T00:00:00.000Z',
    );
    closeDb();
  });
});

/**
 * The whole loop, against two fake organizations.
 *
 * The point is not the row counts; it is that each organization was reached
 * with its own token, its apps were filed under its own id, and its watermark
 * is its own.
 */
describe('a sync across two organizations', () => {
  function respond(body: unknown): Response {
    return new Response(JSON.stringify({ data: body }), { status: 200 });
  }

  /**
   * What a pass left behind under one key: that it ran at all, and how it
   * closed. `reached` comes from the state row's existence rather than from the
   * watermark, because a pass that returns no rows now correctly leaves the
   * watermark alone.
   */
  function passState(key: string): {
    reached: boolean;
    cursor: string | null;
    syncedThrough: string | null;
  } {
    const row = getDb().prepare('SELECT updated_at FROM sync_state WHERE key = ?').get(key) as
      | { updated_at: string }
      | undefined;
    const { cursor, syncedThrough } = readSyncState(getDb(), key);
    return { reached: Boolean(row?.updated_at), cursor, syncedThrough };
  }

  it('keeps each organization\'s apps, tokens and watermarks separate', async () => {
    resetEnvironment({
      PARTNER_APP_IDS: '',
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
    });

    const tokensByOrg = new Map<string, Set<string>>();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const orgId = /partners\.shopify\.com\/(\d+)\//.exec(String(url))?.[1] ?? '';
      const token = String((init.headers as Record<string, string>)['X-Shopify-Access-Token']);
      const seen = tokensByOrg.get(orgId) ?? new Set<string>();
      seen.add(token);
      tokensByOrg.set(orgId, seen);

      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes('PartnerdexTransactions')) {
        const appId = orgId === ORG_ID ? '111' : '222';
        return respond({
          transactions: {
            pageInfo: { hasNextPage: false },
            edges: [
              {
                cursor: `cursor-${orgId}`,
                node: {
                  id: `gid://partners/AppSubscriptionSale/${orgId}-1`,
                  createdAt: '2024-03-01T00:00:00Z',
                  __typename: 'AppSubscriptionSale',
                  app: { id: `gid://partners/App/${appId}`, name: `App ${appId}` },
                  shop: {
                    id: 'gid://partners/Shop/1',
                    name: 'Shop',
                    myshopifyDomain: 's.example',
                  },
                  chargeId: `gid://shopify/AppSubscription/${orgId}`,
                  billingInterval: 'EVERY_30_DAYS',
                  grossAmount: { amount: '10', currencyCode: 'USD' },
                  netAmount: { amount: '9', currencyCode: 'USD' },
                  shopifyFee: { amount: '1', currencyCode: 'USD' },
                },
              },
            ],
          },
        });
      }
      // Events: nothing to report, for either organization.
      return respond({ app: { events: { pageInfo: { hasNextPage: false }, edges: [] } } });
    }) as unknown as typeof fetch;

    let result;
    try {
      result = await runSync();
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(result.orgs, [ORG_ID, OTHER_ORG_ID]);

    // Each endpoint saw exactly its own token and no other.
    assert.deepEqual([...(tokensByOrg.get(ORG_ID) ?? [])], ['test-token']);
    assert.deepEqual([...(tokensByOrg.get(OTHER_ORG_ID) ?? [])], ['second-token']);

    const db = getDb();
    const apps = db.prepare('SELECT id, org_id FROM apps ORDER BY id').all();
    assert.deepEqual(apps, [
      { id: '111', org_id: ORG_ID },
      { id: '222', org_id: OTHER_ORG_ID },
    ]);

    // Two watermarks, not one shared one.
    const keys = db
      .prepare(`SELECT key FROM sync_state WHERE key LIKE '%transactions:all' ORDER BY key`)
      .all();
    assert.deepEqual(keys, [
      { key: `org:${OTHER_ORG_ID}:transactions:all` },
      { key: `org:${ORG_ID}:transactions:all` },
    ]);
  });

  /**
   * One organization's failure must not strand the other's sync, or the
   * rebuild every report reads. A revoked token on the app nobody is looking at
   * would otherwise freeze the whole dashboard.
   */
  it('syncs the healthy organization and still reports the failure', async () => {
    resetEnvironment({
      PARTNER_APP_IDS: '',
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'revoked',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const orgId = /partners\.shopify\.com\/(\d+)\//.exec(String(url))?.[1] ?? '';
      if (orgId === OTHER_ORG_ID) {
        return new Response('nope', { status: 401 });
      }
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes('PartnerdexTransactions')) {
        return respond({ transactions: { pageInfo: { hasNextPage: false }, edges: [] } });
      }
      return respond({ app: { events: { pageInfo: { hasNextPage: false }, edges: [] } } });
    }) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => runSync(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /1 of 2 organization\(s\) failed/);
          assert.match(error.message, new RegExp(OTHER_ORG_ID));
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The healthy organization still ran its pass and closed it cleanly.
    //
    // Its state row, not its watermark: this org's fake returns no rows, and a
    // pass that saw no rows has learned no watermark. It used to stamp the wall
    // clock, which is a mark no row supports and which would skip everything
    // before it on the next pass — see `advanceWatermark`.
    assert.deepEqual(passState(`org:${ORG_ID}:transactions:all`), {
      reached: true,
      cursor: null,
      syncedThrough: null,
    });
  });

  /**
   * The starvation case, which per-organization error handling cannot reach.
   *
   * A revoked token raises something to catch. A hang raises nothing: the first
   * organization neither finishes nor fails, and the second — sequential, behind
   * it — never runs at all. Not late, not partially. Never. A second
   * organization can sit configured and unsynced for as long as the first one's
   * socket stays open.
   */
  it('gives up on an organization that hangs, so the next one still syncs', async () => {
    resetEnvironment({
      PARTNER_APP_IDS: '',
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
      // The idle deadline, turned down from fifteen minutes so the test can
      // reach it. Nothing else about the mechanism changes.
      SYNC_ORG_STALL_MS: '150',
    });

    const reached = new Set<string>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const orgId = /partners\.shopify\.com\/(\d+)\//.exec(String(url))?.[1] ?? '';
      reached.add(orgId);

      if (orgId === ORG_ID) {
        // Accepted and never answered, for as long as anyone is willing to wait.
        return new Promise<Response>((_resolve, reject) => {
          // A real open socket keeps the event loop alive; a bare promise does
          // not, and the test runner would call the loop drained before the
          // deadline could fire.
          const keepalive = setInterval(() => {}, 20);
          init.signal?.addEventListener(
            'abort',
            () => {
              clearInterval(keepalive);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      }

      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes('PartnerdexTransactions')) {
        return respond({ transactions: { pageInfo: { hasNextPage: false }, edges: [] } });
      }
      return respond({ app: { events: { pageInfo: { hasNextPage: false }, edges: [] } } });
    }) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => runSync(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /1 of 2 organization\(s\) failed/);
          assert.match(error.message, /made no progress/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The second organization was reached at all, which is the whole point.
    assert.ok(reached.has(OTHER_ORG_ID), 'the second organization never got its turn');
    assert.deepEqual(
      passState(`org:${OTHER_ORG_ID}:transactions:all`),
      { reached: true, cursor: null, syncedThrough: null },
      'and it ran a pass of its own, under its own key',
    );
  });
});

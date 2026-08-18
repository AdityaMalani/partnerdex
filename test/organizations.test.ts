import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { closeDb, getDb, readSyncState } from '../src/db/index.js';
import { activeOrg, activeOrgs } from '../src/orgs/registry.js';
import {
  describeOrganization,
  listOrganizations,
  readOrganization,
  removeOrganization,
  saveOrganization,
} from '../src/orgs/store.js';
import { createApp } from '../src/server/index.js';
import { runSync } from '../src/sync/index.js';
import { upsertApp } from '../src/sync/ingest.js';
import { ORG_ID, OTHER_ORG_ID, resetEnvironment, seedForApp } from './helpers.js';

/**
 * Organizations as data rather than as environment.
 *
 * Four things are worth a test here and the rest is plumbing: that an existing
 * deployment comes up with its organizations intact and its watermarks
 * untouched; that the token never leaves the server by any route; that scoping
 * a report to one organization narrows it and scoping to none does not; and
 * that none of it is reachable from the affiliate portal's realm.
 */

const scratch: string[] = [];

function scratchPath(name: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdx-orgs-')), name);
  scratch.push(path.dirname(file));
  return file;
}

after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A database as it exists in production today: apps, watermarks, and no
 * `organizations` table at all.
 *
 * Built by hand rather than by the current schema, because a table created by
 * the code under test cannot show whether that code copes with a file that
 * predates it.
 */
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
    INSERT INTO apps VALUES ('111', 'First App', 'key-1', '2024-01-01T00:00:00Z');
    INSERT INTO sync_state VALUES
      ('transactions:all', NULL, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00Z'),
      ('events:111', NULL, '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00Z');
  `);
  db.close();
  return file;
}

describe('seeding organizations from the environment', () => {
  afterEach(() => closeDb());

  it('brings an existing deployment up with its organizations and its data intact', () => {
    const file = legacyDatabase();
    resetEnvironment({
      DATABASE_PATH: file,
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
      PARTNER_ORG_2_LABEL: 'Second',
    });
    const db = getDb();

    // Both organizations arrive, in the order the environment declares them —
    // which is the order the sync visits them, so it is not cosmetic.
    assert.deepEqual(
      listOrganizations(db).map((org) => [org.id, org.label, org.source, org.token]),
      [
        [ORG_ID, ORG_ID, 'env', 'test-token'],
        [OTHER_ORG_ID, 'Second', 'env', 'second-token'],
      ],
    );

    // Nothing already in the file moved.
    const apps = db.prepare('SELECT id, org_id FROM apps').all();
    assert.deepEqual(apps, [{ id: '111', org_id: ORG_ID }]);
    assert.equal(
      readSyncState(db, `org:${ORG_ID}:transactions:all`).syncedThrough,
      '2026-08-01T00:00:00.000Z',
      'a multi-hour backfill must not be re-walked',
    );
  });

  /**
   * The reconciliation rule, in the one case where it can be seen: the
   * environment seeds and the database decides. An operator who rotated a token
   * in the dashboard has said which of the two they mean; a `fly secrets` value
   * left from the bootstrap has said nothing since the first boot.
   */
  it('never overwrites a stored token with the environment\'s', () => {
    const file = scratchPath('kept.db');
    resetEnvironment({ DATABASE_PATH: file });
    saveOrganization(getDb(), { id: ORG_ID, token: 'rotated-in-the-dashboard' });
    closeDb();

    resetEnvironment({ DATABASE_PATH: file });
    const org = readOrganization(getDb(), ORG_ID);
    assert.equal(org?.token, 'rotated-in-the-dashboard');
    // And the row is no longer the environment's to reclaim.
    assert.equal(org?.source, 'manual');
  });

  /** A removal has to survive a restart, or the button is not honest. */
  it('does not resurrect an organization that was removed', () => {
    const file = scratchPath('removed.db');
    resetEnvironment({ DATABASE_PATH: file });
    removeOrganization(getDb(), ORG_ID);
    closeDb();

    resetEnvironment({ DATABASE_PATH: file });
    const db = getDb();
    assert.equal(readOrganization(db, ORG_ID)?.disabledAt !== null, true);
    assert.deepEqual(activeOrgs(db), []);
  });

  it('picks up an organization added to the environment after the first boot', () => {
    const file = scratchPath('grown.db');
    resetEnvironment({ DATABASE_PATH: file });
    assert.deepEqual(activeOrgs(getDb()).map((org) => org.organizationId), [ORG_ID]);
    closeDb();

    resetEnvironment({
      DATABASE_PATH: file,
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
    });
    assert.deepEqual(
      activeOrgs(getDb()).map((org) => org.organizationId),
      [ORG_ID, OTHER_ORG_ID],
    );
  });

  /**
   * An old database opened by a process with no credentials at all. The column
   * is added and left blank rather than attributing millions of rows to a
   * guess, and the watermarks stay under their old names so the rename can
   * still happen once an organization exists.
   */
  it('declines to guess an organization for existing rows when there is none', () => {
    const file = legacyDatabase();
    resetEnvironment({ DATABASE_PATH: file });
    delete process.env.PARTNER_ORGANIZATION_ID;
    delete process.env.PARTNER_API_TOKEN;
    closeDb();

    const db = getDb();
    assert.deepEqual(db.prepare('SELECT id, org_id FROM apps').all(), [{ id: '111', org_id: '' }]);
    assert.equal(readSyncState(db, 'transactions:all').syncedThrough, '2026-08-01T00:00:00.000Z');
    closeDb();

    // And the rename happens on the next open, once one exists.
    resetEnvironment({ DATABASE_PATH: file });
    assert.equal(
      readSyncState(getDb(), `org:${ORG_ID}:transactions:all`).syncedThrough,
      '2026-08-01T00:00:00.000Z',
    );
  });
});

describe('an instance with nothing configured', () => {
  beforeEach(() => {
    resetEnvironment();
    delete process.env.PARTNER_ORGANIZATION_ID;
    delete process.env.PARTNER_API_TOKEN;
  });
  afterEach(() => closeDb());

  /**
   * The refusal that used to live in `getConfig()`. It cannot live there any
   * more — an install has to boot far enough to serve the page you add an
   * organization on — so it is a message on the sync's progress channel and the
   * run carries on with everything that does not need a Partner credential.
   */
  it('boots, syncs nothing, and says so instead of throwing', async () => {
    const lines: string[] = [];
    const result = await runSync({ onProgress: (line) => lines.push(line) });

    assert.deepEqual(result.orgs, []);
    assert.equal(result.transactions, 0);
    assert.ok(
      lines.some((line) => /No Shopify Partner organization is configured/.test(line)),
      lines.join('\n'),
    );
  });
});

/* ------------------------------------------------------------------ HTTP */

describe('the organizations API', () => {
  let server: Server;
  let origin: string;

  const json = async (response: Response): Promise<any> => response.json();
  const get = (path: string): Promise<Response> => fetch(`${origin}${path}`);
  const send = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${origin}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A Partner API that accepts one token and refuses everything else. */
  function fakePartnerApi(accepted: Record<string, string>): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      const target = String(url);
      if (!target.includes('partners.shopify.com')) {
        return original(url as never, init as never);
      }
      const orgId = /partners\.shopify\.com\/(\d+)\//.exec(target)?.[1] ?? '';
      const token = String((init.headers as Record<string, string>)['X-Shopify-Access-Token']);
      if (accepted[orgId] !== token) return new Response('nope', { status: 401 });
      return new Response(
        JSON.stringify({
          data: {
            transactions: {
              edges: [
                {
                  node: {
                    createdAt: '2024-03-01T00:00:00Z',
                    app: { id: 'gid://partners/App/111', name: 'First App' },
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  before(async () => {
    resetEnvironment();
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    // A fresh in-memory store per test, re-seeded from the environment.
    resetEnvironment();
    getDb();
  });

  it('lists the seeded organization with its sync health and no token', async () => {
    const body = await json(await get('/api/organizations'));
    assert.equal(body.organizations.length, 1);

    const [org] = body.organizations;
    assert.equal(org.id, ORG_ID);
    assert.equal(org.inEnvironment, true);
    assert.equal(org.hasToken, true);
    // Four characters of a token that is ten long, and nothing that could be used.
    assert.equal(org.tokenHint, 'oken');
    assert.ok('lastSyncAt' in org && 'phase' in org && 'syncError' in org);
    assert.equal(JSON.stringify(body).includes('test-token'), false);
  });

  it('adds an organization only after the Partner API accepts the token', async () => {
    const restore = fakePartnerApi({ [OTHER_ORG_ID]: 'good-token' });
    try {
      const refused = await send('POST', '/api/organizations', {
        organizationId: OTHER_ORG_ID,
        token: 'wrong-token',
      });
      assert.equal(refused.status, 400);
      assert.equal(readOrganization(getDb(), OTHER_ORG_ID), null, 'nothing may be stored');

      const created = await send('POST', '/api/organizations', {
        organizationId: OTHER_ORG_ID,
        label: 'Second',
        token: 'good-token',
      });
      assert.equal(created.status, 201);

      const body = await json(created);
      // The check says what the credential actually reaches, by name — the only
      // thing that distinguishes "right token" from "right token, wrong org".
      assert.equal(body.check.ok, true);
      assert.deepEqual(body.check.apps, [{ id: '111', name: 'First App' }]);
      assert.equal(JSON.stringify(body).includes('good-token'), false);
      assert.equal(readOrganization(getDb(), OTHER_ORG_ID)?.token, 'good-token');
    } finally {
      restore();
    }
  });

  it('replaces a token without ever displaying the old one', async () => {
    const restore = fakePartnerApi({ [ORG_ID]: 'rotated' });
    try {
      const response = await send('PATCH', `/api/organizations/${ORG_ID}`, { token: 'rotated' });
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(JSON.stringify(body).includes('rotated'), false);
      assert.equal(readOrganization(getDb(), ORG_ID)?.token, 'rotated');
    } finally {
      restore();
    }
  });

  it('renames without calling the Partner API and without a token', async () => {
    const restore = fakePartnerApi({});
    try {
      const body = await json(
        await send('PATCH', `/api/organizations/${ORG_ID}`, { label: 'Renamed' }),
      );
      assert.equal(body.organizations[0].label, 'Renamed');
      // The stored credential is untouched by a rename.
      assert.equal(readOrganization(getDb(), ORG_ID)?.token, 'test-token');
    } finally {
      restore();
    }
  });

  /**
   * The removal contract, which is the one an operator has to be able to trust:
   * the credential goes, the data stays, and adding it back resumes rather than
   * re-reading years of history.
   */
  it('removes the credential and keeps every row and watermark', async () => {
    const db = getDb();
    seedForApp('111', 'charge-1');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    assert.ok(before > 0);

    const body = await json(await send('DELETE', `/api/organizations/${ORG_ID}`));
    assert.equal(body.removed.hasToken, false);
    assert.match(body.kept.history, /kept/);

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n,
      before,
      'removing an organization must not delete its history',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM apps WHERE org_id = ?').get(ORG_ID) as { n: number }).n,
      1,
      'and must not orphan its apps',
    );
    assert.deepEqual(activeOrgs(db), [], 'but it stops syncing');
    assert.equal(activeOrg(ORG_ID, db), null);

    // Adding it back re-enables the same row rather than creating a second one.
    const restore = fakePartnerApi({ [ORG_ID]: 'back-again' });
    try {
      const again = await send('POST', '/api/organizations', {
        organizationId: ORG_ID,
        token: 'back-again',
      });
      assert.equal(again.status, 201);
      assert.equal(listOrganizations(db).length, 1);
      assert.equal(activeOrgs(db).length, 1);
    } finally {
      restore();
    }
  });

  it('refuses to add an organization that is already live', async () => {
    const response = await send('POST', '/api/organizations', {
      organizationId: ORG_ID,
      token: 'another',
    });
    assert.equal(response.status, 409);
  });

  it('refuses an organization id that is not the numeric id', async () => {
    const response = await send('POST', '/api/organizations', {
      organizationId: 'my-org-handle',
      token: 'whatever',
    });
    assert.equal(response.status, 400);
    assert.match((await json(response)).error, /number in your Partner dashboard URL/);
  });
});

/**
 * The token, from the outside.
 *
 * `describeOrganization` is the only shape allowed out of the store, and this
 * asserts the property that matters rather than the implementation: no route on
 * the admin API returns the string, whatever it is asked.
 */
describe('the token never leaves the server', () => {
  let server: Server;
  let origin: string;
  const SECRET = 'prtapi-not-a-real-token-0000';

  before(async () => {
    resetEnvironment({ PARTNER_API_TOKEN: SECRET });
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    getDb();
  });

  after(() => server.close());

  it('is absent from every admin route that touches an organization', async () => {
    for (const path of [
      '/api/organizations',
      '/api/apps',
      '/api/status',
      `/api/apps?orgId=${ORG_ID}`,
    ]) {
      const text = await (await fetch(`${origin}${path}`)).text();
      assert.equal(text.includes(SECRET), false, `${path} leaked the token`);
    }
  });

  it('is absent from the described row, and the hint is four characters', () => {
    const org = readOrganization(getDb(), ORG_ID)!;
    const view = describeOrganization(org) as Record<string, unknown>;
    assert.equal('token' in view, false);
    assert.equal(view.tokenHint, SECRET.slice(-4));
    assert.equal(JSON.stringify(view).includes(SECRET), false);
  });
});

/* --------------------------------------------------------- report scoping */

describe('scoping reports to one organization', () => {
  let server: Server;
  let origin: string;

  before(async () => {
    resetEnvironment({ PARTNER_APP_IDS: '' });
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    resetEnvironment({
      PARTNER_APP_IDS: '',
      PARTNER_ORG_2_ID: OTHER_ORG_ID,
      PARTNER_ORG_2_TOKEN: 'second-token',
    });
    const db = getDb();
    upsertApp(db, { id: 'gid://partners/App/111', name: 'First App', apiKey: null }, ORG_ID);
    upsertApp(db, { id: 'gid://partners/App/222', name: 'Second App', apiKey: null }, OTHER_ORG_ID);
    seedForApp('111', 'charge-a', '10', ORG_ID);
    seedForApp('222', 'charge-b', '20', OTHER_ORG_ID);
  });

  const overview = async (query: string): Promise<any> =>
    (await fetch(`${origin}/api/overview?metrics=mrr&period=all_time${query}`)).json();

  /**
   * The default, and the contract every existing reader depends on: unscoped
   * means everything this instance covers. A dashboard nobody has touched must
   * read exactly as it did before the selector existed.
   */
  it('covers every organization when none is named', async () => {
    const apps = await (await fetch(`${origin}/api/apps`)).json();
    assert.deepEqual(
      apps.apps.map((app: { id: string }) => app.id).sort(),
      ['111', '222'],
    );

    const all = await overview('');
    assert.equal(all.mrr.value, 50, 'both organizations, summed');
  });

  it('narrows every figure to the organization named', async () => {
    const apps = await (await fetch(`${origin}/api/apps?orgId=${ORG_ID}`)).json();
    assert.deepEqual(apps.apps.map((app: { id: string }) => app.id), ['111']);

    assert.equal((await overview(`&orgId=${ORG_ID}`)).mrr.value, 25);
    assert.equal((await overview(`&orgId=${OTHER_ORG_ID}`)).mrr.value, 25);
  });

  /**
   * Scoping is a permission gate as well as a filter: an app outside the named
   * organization is refused rather than returned empty, which is the same rule
   * `buildContext` already applies to the configured scope.
   */
  it('refuses an app that is not in the named organization', async () => {
    const response = await fetch(
      `${origin}/api/overview?metrics=mrr&orgId=${ORG_ID}&appIds=222`,
    );
    assert.equal(response.status, 403);
  });

  it('narrows the customer list too', async () => {
    const scoped = await (
      await fetch(`${origin}/api/customers?orgId=${OTHER_ORG_ID}`)
    ).json();
    const all = await (await fetch(`${origin}/api/customers`)).json();
    assert.ok(all.total >= scoped.total);
    assert.ok(scoped.total > 0);
  });
});

/* ------------------------------------------------------------- admin only */

describe('organization management is admin only', () => {
  let server: Server;
  let origin: string;
  const PASSWORD = 'correct-horse-battery';

  before(async () => {
    resetEnvironment({ DASHBOARD_PASSWORD: PASSWORD });
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  const call = (method: string, path: string, cookie?: string): Promise<Response> =>
    fetch(`${origin}${path}`, {
      method,
      headers: cookie ? { cookie } : {},
    });

  it('closes every organization route to a caller with no session', async () => {
    for (const [method, path] of [
      ['GET', '/api/organizations'],
      ['POST', '/api/organizations'],
      ['PATCH', `/api/organizations/${ORG_ID}`],
      ['DELETE', `/api/organizations/${ORG_ID}`],
      ['POST', `/api/organizations/${ORG_ID}/check`],
    ] as const) {
      const response = await call(method, path);
      assert.equal(response.status, 401, `${method} ${path} was open`);
    }
  });

  /**
   * The two realms share no cookie name, no path and no signing key, and this
   * is the assertion that the second of those actually holds: an affiliate
   * portal session is not a dashboard session by any route, including the one
   * that holds live Partner credentials.
   */
  it('does not accept an affiliate portal session', async () => {
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const admin = login.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(admin, /^partnerdex_session=/);

    // The same token value under the portal's cookie name reaches nothing.
    const portal = admin.replace('partnerdex_session=', 'partnerdex_affiliate=');
    assert.equal((await call('GET', '/api/organizations', portal)).status, 401);
    // And the admin cookie does work, so the test is not passing for the wrong reason.
    assert.equal((await call('GET', '/api/organizations', admin)).status, 200);
  });
});

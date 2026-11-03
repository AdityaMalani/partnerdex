import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { listContacts } from '../src/contacts/list.js';
import { matchContactToShop, suppressContact, unsuppressContact, upsertContact } from '../src/contacts/upsert.js';
import { createApp } from '../src/server/index.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

const OTHER_APP = '999';

function seedShop(id: string, domain: string, name = `Shop ${id}`): void {
  getDb()
    .prepare(
      `INSERT INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         myshopify_domain = excluded.myshopify_domain`,
    )
    .run(id, name, domain);
}

function insertContact(input: {
  email: string;
  firstName?: string;
  lastName?: string;
  suppressed?: boolean;
  shopId?: string;
  appId?: string;
  role?: string;
  matchMethod?: string;
}): void {
  const now = '2026-08-01T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO contacts (
         email, first_name, last_name, is_suppressed, source,
         first_seen_at, last_seen_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'csv_import', ?, ?, ?, ?)`,
    )
    .run(
      input.email,
      input.firstName ?? null,
      input.lastName ?? null,
      input.suppressed ? 1 : 0,
      now,
      now,
      now,
      now,
    );
  if (input.shopId) {
    getDb()
      .prepare(
        `INSERT INTO contact_shops (
           email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.email,
        input.appId ?? APP_ID,
        input.shopId,
        input.role ?? 'staff',
        input.matchMethod ?? 'auto',
        now,
        now,
      );
  }
}

describe('contacts list', () => {
  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
    seedShop('10', 'acme.myshopify.com', 'Acme');
    seedShop('20', 'solo.myshopify.com', 'Solo Store');
    seedShop('30', 'twin.myshopify.com', 'Twin A');
  });

  afterEach(() => closeDb());

  it('lists people with linked stores, searchable by name and email', () => {
    insertContact({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      shopId: '10',
      role: 'owner',
    });
    insertContact({
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'Builder',
      shopId: '20',
    });

    const all = listContacts();
    assert.equal(all.total, 2);
    assert.equal(all.contacts[0]!.email, 'ada@example.com');
    assert.equal(all.contacts[0]!.primaryShop?.name, 'Acme');
    assert.equal(all.contacts[0]!.role, 'owner');
    assert.equal(all.contacts[0]!.source, 'csv_import');
    assert.equal(all.contacts[0]!.createdAt, '2026-08-01T00:00:00.000Z');
    assert.equal(all.contacts[0]!.lastSeenAt, '2026-08-01T00:00:00.000Z');

    const byName = listContacts({ search: 'Lovelace' });
    assert.equal(byName.total, 1);
    assert.equal(byName.contacts[0]!.email, 'ada@example.com');

    const byEmail = listContacts({ search: 'bob@' });
    assert.equal(byEmail.total, 1);
    assert.equal(byEmail.contacts[0]!.firstName, 'Bob');
  });

  it('shows every store for a multi-store contact and flags +N via shops.length', () => {
    insertContact({
      email: 'agency@example.com',
      firstName: 'Pat',
      lastName: 'Agency',
      shopId: '10',
      role: 'staff',
    });
    getDb()
      .prepare(
        `INSERT INTO contact_shops (email, app_id, shop_id, role, match_method)
         VALUES ('agency@example.com', ?, '20', 'staff', 'auto')`,
      )
      .run(APP_ID);

    const row = listContacts({ search: 'agency@example.com' }).contacts[0]!;
    assert.equal(row.shops.length, 2);
    assert.ok(row.primaryShop);
  });

  it('filters to one store, without unlinked people, and carries per-store seen dates', () => {
    insertContact({ email: 'owner@acme.test', firstName: 'Olive', shopId: '10', role: 'owner' });
    insertContact({ email: 'solo@solo.test', firstName: 'Sol', shopId: '20' });
    insertContact({ email: 'loose@nowhere.test', firstName: 'Lou' });
    getDb()
      .prepare(
        `INSERT INTO contact_shops (
           email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
         ) VALUES ('solo@solo.test', ?, '10', 'collaborator', 'auto', ?, ?)`,
      )
      .run(APP_ID, '2026-09-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z');

    const result = listContacts({ shopId: '10' });
    assert.deepEqual(
      result.contacts.map((row) => row.email).sort(),
      ['owner@acme.test', 'solo@solo.test'],
    );
    assert.equal(result.total, 2);
    assert.equal(result.totals.all, 2);

    const sol = result.contacts.find((row) => row.email === 'solo@solo.test')!;
    // Every store the person manages comes back, not only the filtered one.
    assert.equal(sol.shops.length, 2);
    const here = sol.shops.find((shop) => shop.shopId === '10')!;
    assert.equal(here.role, 'collaborator');
    assert.equal(here.firstSeenAt, '2026-09-01T00:00:00.000Z');
    assert.equal(here.lastSeenAt, '2026-09-20T00:00:00.000Z');
    assert.equal(sol.firstSeenAt, '2026-08-01T00:00:00.000Z');
  });

  it('returns nobody for a store with no linked contacts', () => {
    insertContact({ email: 'owner@acme.test', firstName: 'Olive', shopId: '10', role: 'owner' });
    insertContact({ email: 'loose@nowhere.test', firstName: 'Lou' });
    assert.equal(listContacts({ shopId: '30' }).total, 0);
  });

  it('pulls live store MRR from the existing as-of predicate', () => {
    seed(
      [
        {
          chargeRef: 'c10',
          shopId: '10',
          amount: 39,
          activatedAt: '2024-01-01T00:00:00Z',
          firstSaleAt: '2024-01-01T00:00:00Z',
        },
      ],
      { installs: [{ shopId: '10', at: '2024-01-01T00:00:00Z' }] },
    );
    // seed() writes shops as s10.example / Shop 10; keep that identity.
    insertContact({
      email: 'payer@example.com',
      firstName: 'Pay',
      lastName: 'Er',
      shopId: '10',
      role: 'owner',
    });

    const row = listContacts({ search: 'payer@' }).contacts[0]!;
    assert.equal(row.primaryShop?.shopId, '10');
    assert.equal(row.primaryShop?.mrr, 39);
  });

  it('keeps unlinked contacts and exposes them through the Unlinked filter', () => {
    insertContact({ email: 'ghost@example.com', firstName: 'Ghost', lastName: 'User' });
    insertContact({
      email: 'linked@example.com',
      firstName: 'Linked',
      lastName: 'Person',
      shopId: '10',
    });

    const all = listContacts();
    assert.equal(all.total, 2);
    assert.equal(all.totals.unlinked, 1);

    const unlinked = listContacts({ linked: 'unlinked' });
    assert.equal(unlinked.total, 1);
    assert.equal(unlinked.contacts[0]!.email, 'ghost@example.com');
    assert.equal(unlinked.contacts[0]!.primaryShop, null);
    assert.equal(unlinked.contacts[0]!.matchMethod, 'none');
  });

  it('flags ambiguous rows and filters to them', () => {
    insertContact({
      email: 'twin@example.com',
      firstName: 'Twin',
      lastName: 'Match',
      shopId: '30',
      matchMethod: 'ambiguous',
    });

    const row = listContacts().contacts[0]!;
    assert.equal(row.matchMethod, 'ambiguous');
    assert.equal(listContacts({ linked: 'ambiguous' }).total, 1);
  });

  it('does not leak a contact linked only to an out-of-scope app', () => {
    insertContact({
      email: 'other@example.com',
      firstName: 'Other',
      lastName: 'App',
      shopId: '10',
      appId: OTHER_APP,
    });
    insertContact({
      email: 'ours@example.com',
      firstName: 'Ours',
      lastName: 'App',
      shopId: '10',
    });

    const listed = listContacts();
    assert.equal(listed.total, 1);
    assert.equal(listed.contacts[0]!.email, 'ours@example.com');
  });

  it('orders by created_at when asked', () => {
    insertContact({ email: 'old@example.com', firstName: 'Old', lastName: 'One', shopId: '10' });
    getDb()
      .prepare(`UPDATE contacts SET created_at = ? WHERE email = ?`)
      .run('2025-01-01T00:00:00.000Z', 'old@example.com');
    insertContact({ email: 'new@example.com', firstName: 'New', lastName: 'One', shopId: '20' });
    getDb()
      .prepare(`UPDATE contacts SET created_at = ? WHERE email = ?`)
      .run('2026-08-01T00:00:00.000Z', 'new@example.com');

    const newest = listContacts({ sort: 'created' });
    assert.equal(newest.contacts[0]!.email, 'new@example.com');
    assert.equal(newest.contacts[1]!.email, 'old@example.com');
  });

  it('orders by first name, and the reverse flips that order', () => {
    insertContact({
      email: 'zoe@example.com',
      firstName: 'Zoe',
      lastName: 'Anderson',
      shopId: '10',
    });
    insertContact({
      email: 'aaron@example.com',
      firstName: 'Aaron',
      lastName: 'Zimmerman',
      shopId: '20',
    });

    const byFirst = listContacts({ sort: 'name' });
    assert.deepEqual(
      byFirst.contacts.map((row) => row.email),
      ['aaron@example.com', 'zoe@example.com'],
    );
    const flipped = listContacts({ sort: 'name_desc' });
    assert.deepEqual(
      flipped.contacts.map((row) => row.email),
      ['zoe@example.com', 'aaron@example.com'],
    );
  });

  it('orders customers by account name, not by role', () => {
    insertContact({
      email: 'staff@example.com',
      firstName: 'Sam',
      lastName: 'Staff',
      shopId: '10',
      role: 'staff',
    });
    insertContact({
      email: 'owner@example.com',
      firstName: 'Olivia',
      lastName: 'Owner',
      shopId: '20',
      role: 'owner',
    });

    const byAccount = listContacts({ sort: 'customer' });
    assert.deepEqual(
      byAccount.contacts.map((row) => row.primaryShop?.name),
      ['Acme', 'Solo Store'],
    );
    const flipped = listContacts({ sort: 'customer_desc' });
    assert.deepEqual(
      flipped.contacts.map((row) => row.primaryShop?.name),
      ['Solo Store', 'Acme'],
    );
  });
});

describe('manual match and suppression', () => {
  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
    seedShop('10', 'acme.myshopify.com', 'Acme');
    seedShop('20', 'solo.myshopify.com', 'Solo Store');
  });

  afterEach(() => closeDb());

  it('writes match_method = manual and a later upsert leaves that row untouched', () => {
    insertContact({ email: 'fixme@example.com', firstName: 'Fix', lastName: 'Me' });

    const result = matchContactToShop('FixMe@example.com', { shopId: '20' });
    assert.deepEqual(result, {
      email: 'fixme@example.com',
      shopId: '20',
      appId: APP_ID,
      matchMethod: 'manual',
    });

    const link = getDb()
      .prepare(`SELECT shop_id, match_method, role FROM contact_shops WHERE email = ?`)
      .get('fixme@example.com') as { shop_id: string; match_method: string; role: string };
    assert.deepEqual(link, { shop_id: '20', match_method: 'manual', role: 'staff' });

    upsertContact(
      {
        email: 'fixme@example.com',
        shop: { appId: APP_ID, shopId: '10' },
        source: 'app_capture',
        role: 'owner',
      },
      getDb(),
    );

    const after = getDb()
      .prepare(`SELECT shop_id, match_method, role FROM contact_shops WHERE email = ? AND shop_id = ?`)
      .get('fixme@example.com', '20') as { shop_id: string; match_method: string; role: string };
    assert.equal(after.match_method, 'manual');
    assert.equal(after.role, 'staff');
  });

  it('replaces an ambiguous guess instead of stacking a second row for the same app', () => {
    insertContact({
      email: 'amb@example.com',
      firstName: 'Amb',
      lastName: 'Iguous',
      shopId: '10',
      matchMethod: 'ambiguous',
    });

    matchContactToShop('amb@example.com', { shopId: '20' });

    const links = getDb()
      .prepare(`SELECT shop_id, match_method FROM contact_shops WHERE email = ? ORDER BY shop_id`)
      .all('amb@example.com') as Array<{ shop_id: string; match_method: string }>;
    assert.deepEqual(links, [{ shop_id: '20', match_method: 'manual' }]);
  });

  it('suppress and unsuppress write the register and mirror contacts.is_suppressed', () => {
    insertContact({ email: 'mute@example.com', firstName: 'Mute', lastName: 'Me', shopId: '10' });

    suppressContact('mute@example.com', { source: 'manual', reason: 'asked' });
    const suppressed = getDb()
      .prepare(`SELECT is_suppressed FROM contacts WHERE email = ?`)
      .get('mute@example.com') as { is_suppressed: number };
    assert.equal(suppressed.is_suppressed, 1);
    const register = getDb()
      .prepare(`SELECT source, reason FROM contact_suppressions WHERE email = ?`)
      .get('mute@example.com') as { source: string; reason: string };
    assert.deepEqual(register, { source: 'manual', reason: 'asked' });
    assert.equal(listContacts({ linked: 'suppressed' }).total, 1);

    unsuppressContact('mute@example.com');
    const lifted = getDb()
      .prepare(`SELECT is_suppressed FROM contacts WHERE email = ?`)
      .get('mute@example.com') as { is_suppressed: number };
    assert.equal(lifted.is_suppressed, 0);
    assert.equal(
      getDb().prepare(`SELECT email FROM contact_suppressions WHERE email = ?`).get('mute@example.com'),
      undefined,
    );
  });
});

describe('GET /api/contacts dashboard routes', () => {
  let server: Server;
  let origin: string;

  before(async () => {
    resetEnvironment({
      PARTNER_APP_IDS: APP_ID,
      DASHBOARD_PASSWORD: '',
      CONTACTS_INGEST_TOKEN: 'ingest-token',
    });
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    closeDb();
  });

  beforeEach(() => {
    closeDb();
    getDb();
    seedShop('10', 'acme.myshopify.com', 'Acme');
    insertContact({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      shopId: '10',
      role: 'owner',
    });
  });

  it('lists contacts without an ingest token (dashboard session)', async () => {
    const response = await fetch(`${origin}/api/contacts`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { total: number; contacts: Array<{ email: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.contacts[0]!.email, 'ada@example.com');
  });

  it('filters by shopId on the query string', async () => {
    insertContact({ email: 'elsewhere@example.com', firstName: 'Else' });
    const response = await fetch(`${origin}/api/contacts?shopId=10`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { total: number; contacts: Array<{ email: string }> };
    assert.equal(body.total, 1);
    assert.equal(body.contacts[0]!.email, 'ada@example.com');
  });

  it('matches a store and suppresses through the dashboard writes', async () => {
    insertContact({ email: 'open@example.com', firstName: 'Open', lastName: 'Seat' });

    const matched = await fetch(`${origin}/api/contacts/${encodeURIComponent('open@example.com')}/shop`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shopId: '10' }),
    });
    assert.equal(matched.status, 200);
    assert.equal((await matched.json() as { matchMethod: string }).matchMethod, 'manual');

    const suppressed = await fetch(
      `${origin}/api/contacts/${encodeURIComponent('open@example.com')}/suppression`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ suppressed: true }),
      },
    );
    assert.equal(suppressed.status, 200);
    const row = getDb()
      .prepare(`SELECT is_suppressed FROM contacts WHERE email = ?`)
      .get('open@example.com') as { is_suppressed: number };
    assert.equal(row.is_suppressed, 1);
  });
});

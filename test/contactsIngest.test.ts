import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb } from '../src/db/index.js';
import { importContacts } from '../src/contacts/import.js';
import { upsertContact } from '../src/contacts/upsert.js';
import { createApp } from '../src/server/index.js';
import { APP_ID, resetEnvironment } from './helpers.js';

const TOKEN = 'test-ingest-token-please';
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

describe('POST /api/contacts/ingest', () => {
  let server: Server;
  let origin: string;

  before(async () => {
    resetEnvironment({
      CONTACTS_INGEST_TOKEN: TOKEN,
      PARTNER_APP_IDS: APP_ID,
      DASHBOARD_PASSWORD: 'dashboard-password',
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
    // Fresh DB each case — reopen via close + getDb after env already set.
    closeDb();
    getDb();
    seedShop('10', 'acme.myshopify.com');
  });

  async function ingest(body: unknown, token: string | null = TOKEN) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return fetch(`${origin}/api/contacts/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('rejects a bad or blank token with 401 (no dashboard cookie needed)', async () => {
    const missing = await ingest(
      { email: 'a@example.com', appId: APP_ID, shopId: '10' },
      null,
    );
    assert.equal(missing.status, 401);

    const wrong = await ingest(
      { email: 'a@example.com', appId: APP_ID, shopId: '10' },
      'nope',
    );
    assert.equal(wrong.status, 401);
  });

  it('upserts idempotently with a valid token', async () => {
    const body = {
      email: 'Ada@Example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      appId: APP_ID,
      shopId: '10',
      role: 'owner',
      source: 'app_capture',
      seenAt: '2026-08-06T12:00:00.000Z',
    };

    const first = await ingest(body);
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { matched: string; created: boolean };
    assert.deepEqual(firstJson, { matched: 'auto', created: true });

    const second = await ingest(body);
    assert.equal(second.status, 200);
    const secondJson = (await second.json()) as { matched: string; created: boolean };
    assert.equal(secondJson.created, false);

    const db = getDb();
    const contacts = db.prepare(`SELECT email, first_name FROM contacts`).all();
    assert.equal(contacts.length, 1);
    assert.deepEqual(contacts[0], { email: 'ada@example.com', first_name: 'Ada' });

    const links = db.prepare(`SELECT email, app_id, shop_id, match_method FROM contact_shops`).all();
    assert.equal(links.length, 1);
    assert.deepEqual(links[0], {
      email: 'ada@example.com',
      app_id: APP_ID,
      shop_id: '10',
      match_method: 'auto',
    });
  });

  it('stamps created_at on first ingest from seenAt and never overwrites it', async () => {
    const firstSeen = '2026-08-06T12:00:00.000Z';
    const laterSeen = '2026-08-13T18:00:00.000Z';
    const body = {
      email: 'new@example.com',
      firstName: 'New',
      lastName: 'Person',
      appId: APP_ID,
      shopId: '10',
      source: 'app_capture',
      seenAt: firstSeen,
    };

    const first = await ingest(body);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { created: boolean }).created, true);

    const db = getDb();
    const afterCreate = db
      .prepare(
        `SELECT created_at, first_seen_at, last_seen_at FROM contacts WHERE email = ?`,
      )
      .get('new@example.com') as {
      created_at: string;
      first_seen_at: string | null;
      last_seen_at: string | null;
    };
    assert.equal(afterCreate.created_at, firstSeen);
    assert.equal(afterCreate.first_seen_at, firstSeen);
    assert.equal(afterCreate.last_seen_at, firstSeen);

    const second = await ingest({ ...body, seenAt: laterSeen });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { created: boolean }).created, false);

    const afterUpdate = db
      .prepare(
        `SELECT created_at, first_seen_at, last_seen_at FROM contacts WHERE email = ?`,
      )
      .get('new@example.com') as {
      created_at: string;
      first_seen_at: string | null;
      last_seen_at: string | null;
    };
    assert.equal(afterUpdate.created_at, firstSeen);
    assert.equal(afterUpdate.first_seen_at, firstSeen);
    assert.equal(afterUpdate.last_seen_at, laterSeen);
  });

  it('rejects an out-of-scope app_id with 403', async () => {
    const response = await ingest({
      email: 'x@example.com',
      appId: OTHER_APP,
      shopId: '10',
    });
    assert.equal(response.status, 403);
  });

  it('matches by myshopify domain: auto / ambiguous / none', async () => {
    seedShop('11', 'twin.myshopify.com');
    seedShop('12', 'twin.myshopify.com');

    const auto = await ingest({
      email: 'one@example.com',
      appId: APP_ID,
      myshopifyDomain: 'https://Acme.myshopify.com/',
    });
    assert.equal((await auto.json() as { matched: string }).matched, 'auto');

    const ambiguous = await ingest({
      email: 'two@example.com',
      appId: APP_ID,
      myshopifyDomain: 'twin.myshopify.com',
    });
    assert.equal((await ambiguous.json() as { matched: string }).matched, 'ambiguous');
    const link = getDb()
      .prepare(`SELECT shop_id, match_method FROM contact_shops WHERE email = ?`)
      .get('two@example.com') as { shop_id: string; match_method: string };
    assert.equal(link.match_method, 'ambiguous');
    assert.ok(link.shop_id === '11' || link.shop_id === '12');

    const none = await ingest({
      email: 'ghost@example.com',
      appId: APP_ID,
      myshopifyDomain: 'missing.myshopify.com',
    });
    assert.equal((await none.json() as { matched: string }).matched, 'none');
    const ghostLinks = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM contact_shops WHERE email = ?`)
      .get('ghost@example.com') as { n: number };
    assert.equal(ghostLinks.n, 0);
    const ghostContact = getDb()
      .prepare(`SELECT email FROM contacts WHERE email = ?`)
      .get('ghost@example.com');
    assert.ok(ghostContact, 'unmatched contact is kept');
  });

  it('never modifies a contact_shops row already marked manual', async () => {
    upsertContact(
      {
        email: 'manual@example.com',
        shop: { appId: APP_ID, shopId: '10' },
        source: 'app_capture',
        role: 'staff',
        seenAt: '2026-01-01T00:00:00.000Z',
      },
      getDb(),
    );
    getDb()
      .prepare(
        `UPDATE contact_shops SET match_method = 'manual', role = 'owner'
          WHERE email = ?`,
      )
      .run('manual@example.com');

    const response = await ingest({
      email: 'manual@example.com',
      appId: APP_ID,
      shopId: '10',
      role: 'staff',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { matched: string }).matched, 'manual');

    const row = getDb()
      .prepare(`SELECT match_method, role FROM contact_shops WHERE email = ?`)
      .get('manual@example.com') as { match_method: string; role: string };
    assert.deepEqual(row, { match_method: 'manual', role: 'owner' });
  });
});

describe('contacts:import CSV', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetEnvironment({ PARTNER_APP_IDS: APP_ID });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partnerdex-import-'));
    seedShop('10', 'acme.myshopify.com');
    seedShop('20', 'solo.myshopify.com');
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCsv(name: string, body: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, body, 'utf8');
    return filePath;
  }

  const csv = `email,first_name,last_name,myshopify_domain,role,suppressed
ada@example.com,Ada,Lovelace,acme.myshopify.com,owner,false
ada@example.com,Ada,Lovelace,acme.myshopify.com,owner,false
bob@example.com,Bob,Builder,solo.myshopify.com,staff,true
ghost@example.com,Ghost,User,missing.myshopify.com,staff,false
`;

  it('preview prints match counts and writes nothing', () => {
    const csvPath = writeCsv('contacts.csv', csv);
    const summary = importContacts({
      csvPath,
      appId: APP_ID,
      commit: false,
    });

    assert.equal(summary.committed, false);
    assert.equal(summary.uniqueEmails, 3);
    assert.equal(summary.matchCounts.auto, 2);
    assert.equal(summary.matchCounts.none, 1);
    assert.equal(summary.contactsWritten, 0);
    assert.equal(summary.suppressionMarked, 1);
    assert.equal(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n,
      0,
    );
    assert.equal(summary.roleCounts.owner, 1);
    assert.equal(summary.roleCounts.staff, 2);
  });

  it('commit writes contacts + suppressions and is idempotent', () => {
    const csvPath = writeCsv('contacts.csv', csv);

    const first = importContacts({
      csvPath,
      appId: APP_ID,
      commit: true,
    });
    assert.equal(first.committed, true);
    assert.equal(first.suppressionMarked, 1);

    const db = getDb();
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n, 3);
    const bob = db
      .prepare(`SELECT is_suppressed FROM contacts WHERE email = ?`)
      .get('bob@example.com') as { is_suppressed: number };
    assert.equal(bob.is_suppressed, 1);
    assert.ok(
      db.prepare(`SELECT email FROM contact_suppressions WHERE email = ?`).get('bob@example.com'),
    );

    const ada = db
      .prepare(
        `SELECT first_seen_at, last_seen_at, created_at, source FROM contacts WHERE email = ?`,
      )
      .get('ada@example.com') as {
      first_seen_at: string | null;
      last_seen_at: string | null;
      created_at: string;
      source: string;
    };
    assert.equal(ada.first_seen_at, null);
    assert.equal(ada.last_seen_at, null);
    assert.ok(ada.created_at, 'CSV import stamps created_at as row-insert time');
    assert.equal(ada.source, 'csv_import');

    const second = importContacts({
      csvPath,
      appId: APP_ID,
      commit: true,
    });
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n,
      3,
      're-run must not duplicate',
    );
    assert.equal(second.matchCounts.auto, 2);
  });

  it('rejects CSVs that omit a required header', () => {
    const csvPath = writeCsv(
      'bad.csv',
      `email,first_name,last_name,myshopify_domain,role
ada@example.com,Ada,Lovelace,acme.myshopify.com,owner
`,
    );
    assert.throws(() => importContacts({ csvPath, appId: APP_ID }), /suppressed/);
  });

  it('rejects invalid role values', () => {
    const csvPath = writeCsv(
      'bad-role.csv',
      `email,first_name,last_name,myshopify_domain,role,suppressed
ada@example.com,Ada,Lovelace,acme.myshopify.com,primary,false
`,
    );
    assert.throws(() => importContacts({ csvPath, appId: APP_ID }), /Invalid role/);
  });
});

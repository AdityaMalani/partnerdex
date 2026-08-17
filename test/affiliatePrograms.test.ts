import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { createProgram, getProgram, updateProgram } from '../src/affiliates/programAdmin.js';
import { recomputeCommissions, rulesFromPrograms } from '../src/affiliates/commissionRun.js';
import { upsertAffiliate, upsertAttribution, upsertMembership } from '../src/affiliates/store.js';
import { listingUrlForProgram, destinationFor } from '../src/server/referralRedirect.js';
import { REVENUE_COMPONENTS } from '../src/affiliates/commission.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * Standing a program up from nothing.
 *
 * The question this file exists to answer is the one that separates a migration
 * from a feature: can somebody who has never run an importer create a program,
 * set its terms, hand an affiliate a link, and be paid the right amount? Every
 * test below is a step of that, run against a database whose affiliate tables
 * start empty.
 *
 * The other half is what happens when the terms are wrong. A program's terms
 * are the only settings in this system where a typo costs money in both
 * directions, so the validation is asserted as carefully as the arithmetic.
 */

let server: Server;
let origin: string;
let db: Db;

const json = async (path: string, init?: RequestInit): Promise<[number, any]> => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return [response.status, await response.json()];
};

const post = (path: string, body: unknown): Promise<[number, any]> =>
  json(path, { method: 'POST', body: JSON.stringify(body) });

const patch = (path: string, body: unknown): Promise<[number, any]> =>
  json(path, { method: 'PATCH', body: JSON.stringify(body) });

/** A usage charge, which `seed` does not produce — it only writes subscriptions. */
function insertUsageSale(
  database: Db,
  id: string,
  shopId: string,
  gross: number,
  at: string,
  type = 'AppUsageSale',
): void {
  database
    .prepare(
      `INSERT INTO transactions (id, type, app_id, shop_id, created_at, gross_amount, currency)
       VALUES (?, ?, ?, ?, ?, ?, 'USD')`,
    )
    .run(id, type, APP_ID, shopId, at, gross);
}

before(async () => {
  resetEnvironment();
  seed([
    {
      chargeRef: 'c1',
      shopId: '10',
      amount: 100,
      activatedAt: '2024-01-05T00:00:00Z',
      firstSaleAt: '2024-02-05T00:00:00Z',
    },
  ]);
  db = getDb();

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('creating a program from scratch', () => {
  it('starts with no programs at all', () => {
    const rows = db.prepare('SELECT COUNT(*) AS n FROM affiliate_programs').get() as { n: number };
    assert.equal(rows.n, 0, 'the fixture runs no importer');
  });

  it('creates one over the API, with its terms, and pays on it', async () => {
    const [status, body] = await post('/api/affiliates/programs', {
      name: 'Launch Partners',
      appId: APP_ID,
      listingUrl: 'https://apps.example.com/my-app',
      commissionRate: 0.2,
      revenueComponents: ['subscription'],
      durationMonths: 24,
      unassignAfterUninstallDays: 30,
      requireApproval: true,
    });
    assert.equal(status, 201);

    const program = body.program;
    assert.equal(program.name, 'Launch Partners');
    assert.equal(program.commissionRate, 0.2);
    assert.deepEqual(program.revenueComponents, ['subscription']);
    assert.equal(program.durationMonths, 24);
    assert.equal(program.unassignAfterUninstallDays, 30);
    assert.equal(program.requireApproval, true);
    assert.equal(program.status, 'active');
    assert.equal(program.externalId, '', 'nothing imported it');
    assert.equal(program.affiliates, 0);

    // The whole point: attribution and commissions work off a program nobody
    // imported, with no code change and no restart.
    const affiliateId = upsertAffiliate({ name: 'Ada', email: 'ada@example.com' }, db);
    upsertMembership(
      {
        affiliateId,
        programId: program.id,
        handle: 'aaaa1111',
        status: 'enrolled',
        joinedAt: '2024-01-01T00:00:00Z',
      },
      db,
    );
    upsertAttribution(
      {
        affiliateId,
        programId: program.id,
        shopId: '10',
        myshopifyDomain: 's10.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
        handle: 'aaaa1111',
      },
      db,
    );

    const run = recomputeCommissions(db);
    assert.equal(run.written, 1);
    assert.equal(run.amount, 20, '20% of one $100 subscription charge');
  });

  it('serves the referral link from the program row, and never guesses one', () => {
    const program = db.prepare('SELECT id FROM affiliate_programs').get() as { id: string };
    assert.equal(
      listingUrlForProgram(db, program.id),
      'https://apps.example.com/my-app',
      'the URL the operator typed, not one inferred from the name',
    );

    const destination = destinationFor(db, 'aaaa1111');
    assert.equal(destination.known, true);
    assert.equal(destination.url, 'https://apps.example.com/my-app');
  });

  it('refuses to invent a listing for a program that has none', async () => {
    const [, body] = await post('/api/affiliates/programs', {
      name: 'No Listing Yet',
      commissionRate: 0.1,
    });
    const affiliateId = upsertAffiliate({ name: 'Bo', email: 'bo@example.com' }, db);
    upsertMembership(
      {
        affiliateId,
        programId: body.program.id,
        handle: 'cccc3333',
        status: 'enrolled',
        joinedAt: '2024-01-01T00:00:00Z',
      },
      db,
    );

    assert.equal(listingUrlForProgram(db, body.program.id), null);
    const destination = destinationFor(db, 'cccc3333');
    assert.equal(destination.known, true);
    assert.equal(
      destination.url,
      null,
      'a guessed slug sends the visitor to install the wrong app, silently',
    );
  });

  it('publishes the revenue-component vocabulary alongside the programs', async () => {
    const [status, body] = await json('/api/affiliates/programs');
    assert.equal(status, 200);
    assert.deepEqual(body.revenueComponents, [...REVENUE_COMPONENTS]);
    assert.equal(body.programs.length, 2);
  });
});

describe('a program\'s terms are validated before they are stored', () => {
  const bad = async (body: Record<string, unknown>, expected: RegExp): Promise<void> => {
    const [status, response] = await post('/api/affiliates/programs', {
      name: `Bad ${Math.random()}`,
      commissionRate: 0.2,
      ...body,
    });
    assert.equal(status, 400, `expected a 400 for ${JSON.stringify(body)}`);
    assert.match(response.error, expected);
  };

  it('rejects a rate expressed as a percentage', async () => {
    // The mistake that overpays by a factor of a hundred on the next recompute.
    await bad({ commissionRate: 20 }, /fraction between 0 and 1/);
    await bad({ commissionRate: -0.1 }, /fraction between 0 and 1/);
    await bad({ commissionRate: 'a lot' }, /must be a number/);
  });

  it('rejects a revenue component nothing pays on', async () => {
    await bad({ revenueComponents: ['subscriptions'] }, /is not a revenue component/);
    await bad({ revenueComponents: ['subscription', 'tips'] }, /earns nothing on it/);
    await bad({ revenueComponents: [] }, /non-empty array/);
  });

  it('rejects a duration or grace period that cannot have been meant', async () => {
    await bad({ durationMonths: 0 }, /durationMonths/);
    await bad({ durationMonths: 1.5 }, /durationMonths/);
    await bad({ unassignAfterUninstallDays: -1 }, /unassignAfterUninstallDays/);
  });

  it('rejects a listing URL that is not an absolute http(s) URL', async () => {
    await bad({ listingUrl: '/my-app' }, /absolute URL/);
    await bad({ listingUrl: 'javascript:alert(1)' }, /http or https/);
  });

  it('rejects an app id this deployment has never seen', async () => {
    await bad({ appId: '999999' }, /No app with id/);
  });

  it('requires a name and a rate', async () => {
    const [nameless] = await post('/api/affiliates/programs', { commissionRate: 0.2 });
    assert.equal(nameless, 400);
    const [rateless] = await post('/api/affiliates/programs', { name: 'Rateless' });
    assert.equal(rateless, 400);
  });

  it('refuses a second program with the same name on the same app', async () => {
    const [status, body] = await post('/api/affiliates/programs', {
      name: 'Launch Partners',
      appId: APP_ID,
      commissionRate: 0.2,
    });
    assert.equal(status, 409);
    assert.match(body.error, /already exists/);
  });

  it('allows a blank app id, for a program set up before the first sync', () => {
    const program = createProgram({ name: 'Pre-sync', commissionRate: 0.15 }, db);
    assert.equal(program.appId, '');
    assert.deepEqual(program.revenueComponents, ['subscription'], 'the defaulted component');
    assert.equal(program.durationMonths, null);
  });
});

describe('editing a program', () => {
  let programId: string;

  before(() => {
    programId = createProgram(
      {
        name: 'Editable',
        appId: APP_ID,
        commissionRate: 0.1,
        durationMonths: 12,
        listingUrl: 'https://apps.example.com/editable',
      },
      db,
    ).id;
  });

  it('changes only the fields that were sent', async () => {
    const [status, body] = await patch(`/api/affiliates/programs/${programId}`, {
      commissionRate: 0.25,
    });
    assert.equal(status, 200);
    assert.equal(body.program.commissionRate, 0.25);
    assert.equal(body.program.durationMonths, 12, 'a field the form did not send is untouched');
    assert.equal(body.program.listingUrl, 'https://apps.example.com/editable');
    assert.equal(body.program.name, 'Editable');
  });

  it('clears a duration cap with an explicit null', async () => {
    const [status, body] = await patch(`/api/affiliates/programs/${programId}`, {
      durationMonths: null,
    });
    assert.equal(status, 200);
    assert.equal(body.program.durationMonths, null);
  });

  it('validates an edit exactly as it validates a creation', async () => {
    const [status, body] = await patch(`/api/affiliates/programs/${programId}`, {
      commissionRate: 25,
    });
    assert.equal(status, 400);
    assert.match(body.error, /fraction between 0 and 1/);
    assert.equal(
      getProgram(programId, db)?.commissionRate,
      0.25,
      'a rejected edit changes nothing',
    );
  });

  it('never rewrites external_id or created_at', () => {
    const before = getProgram(programId, db)!;
    updateProgram(programId, { name: 'Editable Still' }, db);
    const after = getProgram(programId, db)!;
    assert.equal(after.externalId, before.externalId);
    assert.equal(after.createdAt, before.createdAt);
  });

  it('404s on a program that does not exist', async () => {
    const [status] = await patch('/api/affiliates/programs/not-a-real-id', { name: 'X' });
    assert.equal(status, 404);
  });

  it('restates the commissions the edited terms produce, and moves no payment', async () => {
    // A fresh program, its own affiliate, its own merchant, so the assertion is
    // about this edit and nothing else.
    seed([
      {
        chargeRef: 'c2',
        shopId: '20',
        amount: 200,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
    ]);
    const program = createProgram(
      { name: 'Repriced', appId: APP_ID, commissionRate: 0.1 },
      db,
    );
    const affiliateId = upsertAffiliate({ name: 'Cy', email: 'cy@example.com' }, db);
    upsertMembership(
      {
        affiliateId,
        programId: program.id,
        handle: 'dddd4444',
        status: 'enrolled',
        joinedAt: '2024-01-01T00:00:00Z',
      },
      db,
    );
    const attributionId = upsertAttribution(
      {
        affiliateId,
        programId: program.id,
        shopId: '20',
        myshopifyDomain: 's20.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
      },
      db,
    );
    recomputeCommissions(db);
    const earned = (): number =>
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM affiliate_commissions
              WHERE attribution_id = ? AND cancelled_at IS NULL`,
          )
          .get(attributionId) as { total: number }
      ).total;
    assert.equal(earned(), 20, '10% of $200');

    const [status] = await patch(`/api/affiliates/programs/${program.id}`, {
      commissionRate: 0.3,
    });
    assert.equal(status, 200);

    // The charge is from February and the new rate is effective from now, so
    // the engine still prices it against the version that was in force when it
    // happened. This is the whole point of versioning the terms: an operator
    // correcting a rate is deciding about the future, not restating two years
    // of payments.
    assert.equal(earned(), 20, 'an edit effective from now does not re-price a past charge');

    const versions = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_program_terms WHERE program_id = ?')
      .get(program.id) as { n: number };
    assert.equal(versions.n, 2, 'the edit recorded a second version rather than overwriting');

    const paid = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_commissions WHERE paid_at IS NOT NULL')
      .get() as { n: number };
    assert.equal(paid.n, 0, 'nothing about an edit touches a payment record');

    // Correcting the past is still possible, and it is a different request.
    const [backdated] = await patch(`/api/affiliates/programs/${program.id}`, {
      commissionRate: 0.3,
      effectiveFrom: '2024-01-01T00:00:00Z',
      note: 'Rate was entered wrong at launch.',
    });
    assert.equal(backdated, 200);
    assert.equal(earned(), 60, 'a backdated version re-prices the charges behind it');
  });

  it('refuses a backdated edit that would re-price a commission already paid', async () => {
    seed([
      {
        chargeRef: 'c9',
        shopId: '90',
        amount: 200,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
    ]);
    const program = createProgram({ name: 'Settled', appId: APP_ID, commissionRate: 0.1 }, db);
    const affiliateId = upsertAffiliate({ name: 'Dee', email: 'dee@example.com' }, db);
    upsertMembership(
      {
        affiliateId,
        programId: program.id,
        handle: 'eeee5555',
        status: 'enrolled',
        joinedAt: '2024-01-01T00:00:00Z',
      },
      db,
    );
    upsertAttribution(
      {
        affiliateId,
        programId: program.id,
        shopId: '90',
        myshopifyDomain: 's90.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
      },
      db,
    );
    recomputeCommissions(db);

    const before = db
      .prepare(
        `SELECT id, amount FROM affiliate_commissions
          WHERE program_id = ? AND cancelled_at IS NULL`,
      )
      .all(program.id) as Array<{ id: string; amount: number }>;
    assert.equal(before.length, 1);

    // The money left the building. From here the ledger under it is not
    // rewritten to match a new rate.
    db.prepare(
      `UPDATE affiliate_commissions
          SET paid_at = '2024-03-01T00:00:00Z', paid_amount = 20 WHERE id = ?`,
    ).run(before[0]!.id);

    const [status, body] = await patch(`/api/affiliates/programs/${program.id}`, {
      commissionRate: 0.3,
      effectiveFrom: '2024-01-01T00:00:00Z',
    });
    assert.equal(status, 409, 'refused, not confirmed');
    assert.match(String((body as { error?: string }).error), /already been paid/);

    const after = db
      .prepare('SELECT amount, paid_amount AS paidAmount FROM affiliate_commissions WHERE id = ?')
      .get(before[0]!.id) as { amount: number; paidAmount: number };
    assert.equal(after.amount, 20, 'the refused edit moved nothing');
    assert.equal(after.paidAmount, 20);

    const versions = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_program_terms WHERE program_id = ?')
      .get(program.id) as { n: number };
    assert.equal(versions.n, 1, 'and wrote no version');

    // An edit that takes effect after the paid commission is still allowed —
    // the rule bounds restatement, it does not freeze the program.
    const [forward] = await patch(`/api/affiliates/programs/${program.id}`, {
      commissionRate: 0.3,
    });
    assert.equal(forward, 200);
  });
});

describe('revenue components decide what earns', () => {
  it('pays on usage charges when the program says usage', () => {
    seed([
      {
        chargeRef: 'c3',
        shopId: '30',
        amount: 40,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
    ]);
    insertUsageSale(db, 'usage-1', '30', 100, '2024-03-05T00:00:00Z');

    const program = createProgram(
      { name: 'Usage Only', commissionRate: 0.5, revenueComponents: ['usage'] },
      db,
    );
    // The program has no app id, so the referral carries one — the same path a
    // manual assignment takes.
    const affiliateId = upsertAffiliate({ name: 'Di', email: 'di@example.com' }, db);
    const attributionId = upsertAttribution(
      {
        affiliateId,
        programId: program.id,
        shopId: '30',
        myshopifyDomain: 's30.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
      },
      db,
    );

    recomputeCommissions(db);
    const rows = db
      .prepare(
        `SELECT transaction_id AS transactionId, amount FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NULL`,
      )
      .all(attributionId) as Array<{ transactionId: string; amount: number }>;

    assert.deepEqual(
      rows.map((row) => row.transactionId),
      ['usage-1'],
      'the usage charge earns and the subscription charge does not',
    );
    assert.equal(rows[0]!.amount, 50);
  });

  it('pays on both when the program names both', () => {
    const program = db
      .prepare(`SELECT id FROM affiliate_programs WHERE name = 'Usage Only'`)
      .get() as { id: string };
    // Backdated, because the charges being tested are historical and a version
    // effective from now would (correctly) leave them priced under the old
    // component list. Nothing on this program has been paid, so the
    // restatement guard allows it.
    updateProgram(
      program.id,
      { revenueComponents: ['subscription', 'usage'], effectiveFrom: '2020-01-01T00:00:00Z' },
      db,
    );
    recomputeCommissions(db);

    const total = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM affiliate_commissions c
           JOIN affiliate_attributions a ON a.id = c.attribution_id
          WHERE a.program_id = ? AND c.cancelled_at IS NULL`,
      )
      .get(program.id) as { total: number };
    assert.equal(total.total, 70, '50% of a $100 usage charge and a $40 subscription charge');
  });

  it('drops an unknown stored component rather than obeying it', () => {
    const rules = rulesFromPrograms([
      {
        id: 'p1',
        app_id: APP_ID,
        commission_rate: 0.2,
        revenue_components: '["subscription","tips"]',
        duration_months: null,
        unassign_after_uninstall_days: null,
      },
      {
        id: 'p2',
        app_id: APP_ID,
        commission_rate: 0.2,
        revenue_components: '["tips"]',
        duration_months: null,
        unassign_after_uninstall_days: null,
      },
      {
        id: 'p3',
        app_id: APP_ID,
        commission_rate: 0.2,
        revenue_components: 'not json at all',
        duration_months: null,
        unassign_after_uninstall_days: null,
      },
    ]);

    assert.deepEqual(rules.get('p1')!.revenueComponents, ['subscription']);
    assert.deepEqual(
      rules.get('p2')!.revenueComponents,
      ['subscription'],
      'a program left with nothing falls back rather than silently earning zero',
    );
    assert.deepEqual(rules.get('p3')!.revenueComponents, ['subscription']);
  });

  it('never treats an adjustment or a credit as a revenue stream', () => {
    seed([
      {
        chargeRef: 'c4',
        shopId: '40',
        amount: 10,
        activatedAt: '2024-01-05T00:00:00Z',
        firstSaleAt: '2024-02-05T00:00:00Z',
      },
    ]);
    insertUsageSale(db, 'adjust-1', '40', 500, '2024-03-05T00:00:00Z', 'AppSaleAdjustment');
    insertUsageSale(db, 'credit-1', '40', 500, '2024-03-06T00:00:00Z', 'AppSaleCredit');

    const program = createProgram(
      {
        name: 'Everything',
        commissionRate: 0.2,
        revenueComponents: [...REVENUE_COMPONENTS],
      },
      db,
    );
    const affiliateId = upsertAffiliate({ name: 'Ed', email: 'ed@example.com' }, db);
    const attributionId = upsertAttribution(
      {
        affiliateId,
        programId: program.id,
        shopId: '40',
        myshopifyDomain: 's40.example',
        appId: APP_ID,
        referredAt: '2024-01-01T00:00:00Z',
        source: 'manual',
      },
      db,
    );

    recomputeCommissions(db);
    const rows = db
      .prepare(
        `SELECT transaction_id AS transactionId FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NULL`,
      )
      .all(attributionId) as Array<{ transactionId: string }>;
    assert.equal(rows.length, 1, 'the subscription charge only');
    assert.equal(rows[0]!.transactionId.includes('adjust'), false);
  });
});

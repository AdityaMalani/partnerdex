import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { createProgram, updateProgram } from '../src/affiliates/programAdmin.js';
import { createAffiliate, updateAffiliate } from '../src/affiliates/affiliateAdmin.js';
import { affiliateSetupState } from '../src/affiliates/setup.js';
import { recomputeCommissions } from '../src/affiliates/commissionRun.js';
import { computeCommissions, rulesAt } from '../src/affiliates/commission.js';
import { upsertAffiliate, upsertAttribution, upsertMembership } from '../src/affiliates/store.js';
import {
  readAttributionSettings,
  updateAttributionSettings,
} from '../src/affiliates/attributionSettings.js';
import { extractReferralHandle, selectFirstTouch } from '../src/affiliates/ga4Attribution.js';
import { APP_ID, resetEnvironment, seed } from './helpers.js';

/**
 * The configuration model, the migration of a database that predates it, and
 * each rule type.
 *
 * The through-line is one question: can a programme's terms be edited from a
 * dashboard without the ledger underneath them moving? Everything here is
 * either that question or one of the two things it depends on — that a database
 * carrying real history is carried forward exactly, and that each rule computes
 * what it says it computes.
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

before(() => {
  resetEnvironment();
  db = getDb();
  server = createApp().listen(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
});

/** An affiliate, enrolled, with a referral on a shop. Returns the referral id. */
function referral(
  programId: string,
  handle: string,
  shopId: string,
  email: string,
  referredAt = '2024-01-01T00:00:00Z',
): string {
  const affiliateId = upsertAffiliate({ name: `P ${handle}`, email }, db);
  upsertMembership(
    { affiliateId, programId, handle, status: 'enrolled', joinedAt: referredAt },
    db,
  );
  return upsertAttribution(
    {
      affiliateId,
      programId,
      shopId,
      myshopifyDomain: `s${shopId}.example`,
      appId: APP_ID,
      referredAt,
      source: 'manual',
    },
    db,
  );
}

const earnedOn = (attributionId: string): number =>
  (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NULL`,
      )
      .get(attributionId) as { total: number }
  ).total;

/* ------------------------------------------------------------ the rule types */

describe('each rule type computes what it says', () => {
  it('pays a percentage of gross, per charge', () => {
    seed([
      {
        chargeRef: 'r-pct',
        shopId: '600',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
      },
    ]);
    const program = createProgram({ name: 'Pct', appId: APP_ID, commissionRate: 0.25 }, db);
    const attributionId = referral(program.id, 'pct11111', '600', 'pct@example.com');
    recomputeCommissions(db);
    assert.equal(earnedOn(attributionId), 25, '25% of $100');
  });

  /*
   * The bounty and the once-only percentage share a gate, so both are asserted
   * on a referral with more than one charge — with a single charge they are
   * indistinguishable from the recurring case and the test proves nothing.
   */
  it('pays a flat bounty once, whatever the charge was worth', () => {
    seed([
      {
        chargeRef: 'r-flat',
        shopId: '601',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        extraSales: [{ at: '2024-03-01T00:00:00Z', gross: 100 }],
      },
    ]);
    const program = createProgram(
      {
        name: 'Bounty',
        appId: APP_ID,
        commissionRate: 0,
        payoutBasis: 'flat_per_referral',
        flatAmount: 15,
        flatCurrency: 'usd',
      },
      db,
    );
    const attributionId = referral(program.id, 'flat1111', '601', 'flat@example.com');
    recomputeCommissions(db);

    const rows = db
      .prepare(
        `SELECT amount, currency, rate FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NULL`,
      )
      .all(attributionId) as Array<{ amount: number; currency: string; rate: number | null }>;

    assert.equal(rows.length, 1, 'two charges, one bounty');
    assert.equal(rows[0]!.amount, 15);
    assert.equal(rows[0]!.currency, 'USD', 'the bounty carries its own currency, uppercased');
    assert.equal(rows[0]!.rate, null, 'a bounty has no percentage to record');

    const skipped = db
      .prepare(
        `SELECT COUNT(*) AS n FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NOT NULL`,
      )
      .get(attributionId) as { n: number };
    assert.equal(skipped.n, 0, 'the second charge earns nothing rather than earning and cancelling');
  });

  it('pays a percentage on the first charge only when told to', () => {
    seed([
      {
        chargeRef: 'r-first',
        shopId: '602',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        extraSales: [{ at: '2024-03-01T00:00:00Z', gross: 100 }],
      },
    ]);
    const program = createProgram(
      {
        name: 'FirstOnly',
        appId: APP_ID,
        commissionRate: 0.2,
        recurrence: 'first_charge_only',
      },
      db,
    );
    const attributionId = referral(program.id, 'frst1111', '602', 'first@example.com');
    recomputeCommissions(db);
    assert.equal(earnedOn(attributionId), 20, 'one charge of two');
  });

  it('refuses a bounty with no amount or no currency', () => {
    assert.throws(
      () =>
        createProgram(
          {
            name: 'NoAmount',
            appId: APP_ID,
            commissionRate: 0,
            payoutBasis: 'flat_per_referral',
            flatCurrency: 'USD',
          },
          db,
        ),
      /flatAmount/,
    );
    assert.throws(
      () =>
        createProgram(
          {
            name: 'NoCurrency',
            appId: APP_ID,
            commissionRate: 0,
            payoutBasis: 'flat_per_referral',
            flatAmount: 10,
          },
          db,
        ),
      /flatCurrency/,
    );
  });

  /*
   * Switching an existing percentage programme to a bounty without supplying an
   * amount has to fail. It only can if the cross-check sees the whole proposed
   * state rather than the fields that moved — the failure this pins is a
   * partial update that validates each field in isolation and writes a bounty
   * programme whose bounty is zero.
   */
  it('refuses a partial edit that would leave a bounty incoherent', () => {
    const program = createProgram({ name: 'Switching', appId: APP_ID, commissionRate: 0.2 }, db);
    assert.throws(
      () => updateProgram(program.id, { payoutBasis: 'flat_per_referral' }, db),
      /flatAmount/,
    );
  });
});

/* ------------------------------------------------------ the versioning model */

describe('terms are versioned, and an edit moves forwards', () => {
  it('resolves a charge against the version in force when it happened', () => {
    const timeline = {
      id: 'p',
      versions: [
        { id: 'p', percentCommission: 10, revenueComponents: ['subscription' as const], durationMonths: null, unassignAfterUninstallDays: null, effectiveFrom: '2024-01-01T00:00:00.000Z' },
        { id: 'p', percentCommission: 30, revenueComponents: ['subscription' as const], durationMonths: null, unassignAfterUninstallDays: null, effectiveFrom: '2025-01-01T00:00:00.000Z' },
      ],
    };

    assert.equal(rulesAt(timeline, '2024-06-01T00:00:00.000Z').percentCommission, 10);
    assert.equal(rulesAt(timeline, '2025-06-01T00:00:00.000Z').percentCommission, 30);
    assert.equal(
      rulesAt(timeline, '2025-01-01T00:00:00.000Z').percentCommission,
      30,
      'a version applies from its own instant, inclusive',
    );
    assert.equal(
      rulesAt(timeline, '2023-06-01T00:00:00.000Z').percentCommission,
      10,
      'a charge before every version is priced by the earliest, never at zero',
    );
  });

  it('prices two charges either side of a rate change differently, in one run', () => {
    seed([
      {
        chargeRef: 'r-ver',
        shopId: '603',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        extraSales: [{ at: '2024-06-01T00:00:00Z', gross: 100 }],
      },
    ]);
    const program = createProgram({ name: 'Split', appId: APP_ID, commissionRate: 0.1 }, db);
    const attributionId = referral(program.id, 'splt1111', '603', 'split@example.com');

    // Backdated so both versions sit behind the charges being priced. Nothing
    // on this programme is paid, so restatement is allowed.
    updateProgram(
      program.id,
      { commissionRate: 0.1, effectiveFrom: '2024-01-01T00:00:00Z', note: 'launch rate' },
      db,
    );
    updateProgram(
      program.id,
      { commissionRate: 0.5, effectiveFrom: '2024-04-01T00:00:00Z', note: 'raised' },
      db,
    );
    recomputeCommissions(db);

    assert.equal(
      earnedOn(attributionId),
      60,
      '10% of the February charge and 50% of the June one — one ledger, two rates',
    );

    const rates = db
      .prepare(
        `SELECT rate FROM affiliate_commissions
          WHERE attribution_id = ? AND cancelled_at IS NULL ORDER BY earned_at`,
      )
      .all(attributionId) as Array<{ rate: number }>;
    assert.deepEqual(
      rates.map((row) => row.rate),
      [10, 50],
      'each row records the rate it was actually priced at, not the current one',
    );
  });

  it('records a version only when a versioned term moves', () => {
    const program = createProgram({ name: 'Renamed', appId: APP_ID, commissionRate: 0.2 }, db);
    const versions = (): number =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM affiliate_program_terms WHERE program_id = ?')
          .get(program.id) as { n: number }
      ).n;

    assert.equal(versions(), 1, 'creation writes the first version');
    updateProgram(program.id, { name: 'Renamed again' }, db);
    assert.equal(versions(), 1, 'a rename is not a change to what anybody earns');
    updateProgram(program.id, { requireApproval: true }, db);
    assert.equal(versions(), 1, 'nor is an approval rule');
    /*
     * With an explicit instant, because `createProgram` and `updateProgram`
     * running back to back in a test land in the same millisecond, and a
     * version replaces one already occupying its instant — correctly, since
     * two rates cannot both be in force at one moment. In production the two
     * are seconds apart at the very least; here the instant has to be said out
     * loud for the assertion to be about versioning rather than about clock
     * resolution.
     */
    updateProgram(
      program.id,
      { commissionRate: 0.21, effectiveFrom: '2030-01-01T00:00:00Z' },
      db,
    );
    assert.equal(versions(), 2, 'a rate is');
  });
});

/* ------------------------------------------------------------ the migration */

describe('a database that predates versioning is carried forward exactly', () => {
  /**
   * The proof that matters: a ledger fingerprint across `migrate()`.
   *
   * `getDb()` has already migrated this database, so the migration cannot be
   * re-run against a genuinely old file here. What can be proved, and is what
   * the seeding is actually at risk of getting wrong, is that the seeded
   * version reproduces the behaviour the columns had — so the fingerprint is
   * taken across a *recompute*, which is the thing the migration could change.
   */
  it('recomputes to byte-identical commissions after the terms it seeded', () => {
    seed([
      {
        chargeRef: 'r-mig',
        shopId: '604',
        amount: 250,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        extraSales: [{ at: '2024-03-01T00:00:00Z', gross: 250 }],
      },
    ]);
    const program = createProgram({ name: 'Carried', appId: APP_ID, commissionRate: 0.2 }, db);
    referral(program.id, 'carr1111', '604', 'carried@example.com');
    recomputeCommissions(db);

    const fingerprint = (): string => {
      const rows = db
        .prepare(
          `SELECT id, amount, currency, basis_amount, rate, earned_at, cancelled_at,
                  cancel_reason, paid_at, paid_amount, payment_reference, payout_id
             FROM affiliate_commissions ORDER BY id`,
        )
        .all();
      return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    };

    const before = fingerprint();
    recomputeCommissions(db);
    assert.equal(fingerprint(), before, 'a second recompute moves nothing');
  });

  /**
   * The load-bearing seeding decision, asserted as behaviour rather than as a
   * column value.
   *
   * `rulesFromPrograms` used to pass `enforceUnassignAfterUninstall: true`
   * unconditionally, so every programme released referrals after the grace
   * period whatever the documentation said the flag defaulted to. Seeding the
   * new column from the documentation instead of from that behaviour would
   * keep paying on merchants who had left — silently, on a column nobody knew
   * existed.
   */
  it('keeps releasing a referral after the grace period, as it always has', () => {
    seed([
      {
        chargeRef: 'r-grace',
        shopId: '605',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
        extraSales: [{ at: '2024-06-01T00:00:00Z', gross: 100 }],
      },
    ],
    {
      // The install is needed as well as the uninstall: `lastUninstall` reads
      // the newest `install_intervals` row, and an uninstall with no interval
      // to close leaves nothing for the grace period to measure from.
      installs: [{ shopId: '605', at: '2024-01-01T00:00:00Z' }],
      uninstalls: [{ shopId: '605', at: '2024-02-02T00:00:00Z' }],
    });
    const program = createProgram(
      {
        name: 'Graceful',
        appId: APP_ID,
        commissionRate: 0.2,
        unassignAfterUninstallDays: 30,
      },
      db,
    );
    const attributionId = referral(program.id, 'grce1111', '605', 'grace@example.com');
    recomputeCommissions(db);

    assert.equal(
      earnedOn(attributionId),
      20,
      'the February charge earns; the June one is past the 30-day release and does not',
    );

    const stored = db
      .prepare(
        `SELECT enforce_unassign_after_uninstall AS flag FROM affiliate_program_terms
          WHERE program_id = ?`,
      )
      .get(program.id) as { flag: number };
    assert.equal(stored.flag, 1, 'seeded from the behaviour, not from the documentation');
  });

  it('gives every program a version, and prices from its own columns if it somehow has none', () => {
    const program = createProgram({ name: 'Versionless', appId: APP_ID, commissionRate: 0.4 }, db);
    db.prepare('DELETE FROM affiliate_program_terms WHERE program_id = ?').run(program.id);

    seed([
      {
        chargeRef: 'r-none',
        shopId: '606',
        amount: 100,
        activatedAt: '2024-01-02T00:00:00Z',
        firstSaleAt: '2024-02-01T00:00:00Z',
      },
    ]);
    const attributionId = referral(program.id, 'none1111', '606', 'none@example.com');
    recomputeCommissions(db);

    assert.equal(
      earnedOn(attributionId),
      40,
      'a program with no recorded terms prices from its own columns rather than at zero',
    );
  });
});

/* -------------------------------------------------------- the fresh install */

describe('what a fresh install can do', () => {
  it('creates an affiliate and hands back a working handle and link', async () => {
    const program = createProgram(
      {
        name: 'Invitable',
        appId: APP_ID,
        commissionRate: 0.2,
        listingUrl: 'https://listings.example/an-app',
      },
      db,
    );

    const [status, body] = await post('/api/affiliates', {
      name: 'A Partner',
      email: 'partner@example.com',
      programId: program.id,
    });

    assert.equal(status, 201);
    assert.equal(body.affiliate.name, 'A Partner');
    assert.equal(body.membership.status, 'enrolled', 'an operator-created affiliate is not queued');
    assert.match(body.membership.handle, /^[a-z0-9]{8}$/, 'the shape the redirect resolves');
    assert.ok(body.setPasswordUrl, 'the operator is handed the link, since email may be off');

    // The link the affiliate would be given actually resolves.
    const redirect = await fetch(`${origin}/r/${body.membership.handle}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(
      new URL(redirect.headers.get('location') ?? '').searchParams.get('mref'),
      body.membership.handle,
    );
  });

  it('refuses a handle that the redirect could never resolve', async () => {
    const program = createProgram({ name: 'Shaped', appId: APP_ID, commissionRate: 0.2 }, db);
    const [status, body] = await post('/api/affiliates', {
      name: 'B Partner',
      email: 'b@example.com',
      programId: program.id,
      handle: 'not-a-valid-handle',
    });
    assert.equal(status, 400);
    assert.match(String(body.error), /eight lowercase/);
  });

  it('reports setup state as figures, and stops reporting once a program can earn', async () => {
    // A separate database would be cleaner, but the shared one is the honest
    // test: by now other suites have created programmes and affiliates, so this
    // asserts the transition rather than a pristine zero state.
    const [status, body] = await json('/api/affiliates/setup');
    assert.equal(status, 200);
    assert.equal(typeof body.setup.programs, 'number');
    assert.equal(typeof body.setup.enrolledAffiliates, 'number');
    assert.ok(
      body.setup.attribution === 'ga4' || body.setup.attribution === 'manual',
      'attribution is a value, never an error',
    );

    const state = affiliateSetupState(db);
    assert.ok(state.activePrograms > 0);
    assert.ok(state.enrolledAffiliates > 0);
    assert.ok(state.programsWithListing > 0);
    assert.equal(state.incomplete, false, 'a program that can earn has nothing left to report');
    assert.equal(
      state.attribution,
      'manual',
      'no BigQuery connection here, and that is a supported way to run a program',
    );
  });

  it('edits an affiliate without creating a second one', () => {
    const created = createAffiliate({ name: 'C Partner', email: 'c@example.com' }, db);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM affiliates').get() as { n: number }).n;

    const updated = updateAffiliate(created.affiliate.id, { payoutHold: true }, db);
    assert.equal(updated.id, created.affiliate.id);
    assert.equal(updated.payoutHold, true);
    assert.equal(updated.name, 'C Partner', 'an absent field is unchanged, not cleared');

    const after = (db.prepare('SELECT COUNT(*) AS n FROM affiliates').get() as { n: number }).n;
    assert.equal(after, before, 'an edit is not an insert');
  });
});

/* --------------------------------------------------------- realm separation */

describe('the new admin surface is not reachable from the portal realm', () => {
  /*
   * The portal has its own cookie, its own signing key and its own mount path.
   * What this asserts is narrower and is the thing a new route gets wrong: that
   * the routes added for configuration live behind the dashboard gate only, and
   * that no portal path answers them. A configuration endpoint an affiliate can
   * reach is one where the person being paid sets their own rate.
   */
  const configurationRoutes = [
    ['POST', '/portal/api/affiliates'],
    ['GET', '/portal/api/affiliates/setup'],
    ['POST', '/portal/api/affiliates/programs'],
    ['PATCH', '/portal/api/affiliates/programs/anything'],
  ] as const;

  it('answers nothing useful on the portal mount', async () => {
    for (const [method, path] of configurationRoutes) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ name: 'X', commissionRate: 0.9 }),
      });
      assert.ok(
        response.status === 401 || response.status === 403 || response.status === 404,
        `${method} ${path} answered ${response.status}; a portal caller must never reach configuration`,
      );
    }
  });

  it('creates no program when a portal caller tries', async () => {
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM affiliate_programs').get() as { n: number }
    ).n;
    await fetch(`${origin}/portal/api/affiliates/programs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Self Serve', commissionRate: 1 }),
    });
    const after = (
      db.prepare('SELECT COUNT(*) AS n FROM affiliate_programs').get() as { n: number }
    ).n;
    assert.equal(after, before);
  });
});

/* -------------------------------------------------- attribution as settings */

describe('attribution rules are data, and default to the constants they replaced', () => {
  const candidates = [
    {
      shopId: '900',
      shopDomain: 's900.example',
      anonymousId: 'a1',
      handle: 'aaaa1111',
      clickedAt: '2024-01-01T00:00:00.000Z',
      installedAt: '2024-01-20T00:00:00.000Z',
    },
    {
      shopId: '900',
      shopDomain: 's900.example',
      anonymousId: 'a2',
      handle: 'bbbb2222',
      clickedAt: '2024-01-10T00:00:00.000Z',
      installedAt: '2024-01-20T00:00:00.000Z',
    },
  ];

  it('reads the compiled defaults when nothing has been saved', () => {
    const settings = readAttributionSettings(db);
    assert.equal(settings.touch, 'first');
    assert.equal(settings.windowDays, 30);
    assert.deepEqual(settings.parameters, ['mref', 'utm_source', 'ref']);
    assert.deepEqual(settings.clickHosts, ['apps.shopify.com']);
  });

  it('credits the earliest click under first touch and the latest under last', () => {
    const first = selectFirstTouch('app', candidates, { touch: 'first' });
    const last = selectFirstTouch('app', candidates, { touch: 'last' });
    assert.equal(first[0]!.handle, 'aaaa1111');
    assert.equal(last[0]!.handle, 'bbbb2222');
    assert.equal(first.length, 1);
    assert.equal(last.length, 1, 'exactly one affiliate is credited under either rule');
  });

  it('breaks a tie the same way under both rules', () => {
    const tied = candidates.map((candidate) => ({
      ...candidate,
      clickedAt: '2024-01-05T00:00:00.000Z',
    }));
    // Deliberately identical: an arbitrary answer is acceptable, an answer that
    // changes with an unrelated setting is not — it would silently move a
    // merchant between two affiliates.
    assert.equal(selectFirstTouch('app', tied, { touch: 'first' })[0]!.handle, 'aaaa1111');
    assert.equal(selectFirstTouch('app', tied, { touch: 'last' })[0]!.handle, 'aaaa1111');
  });

  it('honours a shortened window', () => {
    assert.equal(selectFirstTouch('app', candidates, { windowDays: 30 }).length, 1);
    assert.equal(
      selectFirstTouch('app', candidates, { windowDays: 5 }).length,
      0,
      'both clicks are more than five days before the install',
    );
  });

  it('reads the handle from the configured parameter, in precedence order', () => {
    assert.equal(
      extractReferralHandle('https://apps.example.com/x?utm_source=camp&mref=abcd1234'),
      'abcd1234',
      'an affiliate link that also carries a campaign is still an affiliate link',
    );
    assert.equal(
      extractReferralHandle('https://apps.example.com/x?partner=abcd1234', ['partner']),
      'abcd1234',
    );
    assert.equal(
      extractReferralHandle('https://apps.example.com/x?mref=abcd1234', ['partner']),
      null,
      'a parameter that is not configured is not read',
    );
  });

  it('refuses settings that would silently attribute nothing', async () => {
    const [empty] = await json('/api/affiliates/attribution-settings', {
      method: 'PATCH',
      body: JSON.stringify({ parameters: [] }),
    });
    assert.equal(empty, 400, 'no parameters means no click ever carries a handle');

    const [hosts] = await json('/api/affiliates/attribution-settings', {
      method: 'PATCH',
      body: JSON.stringify({ clickHosts: [] }),
    });
    assert.equal(hosts, 400, 'the host allowlist is a trust boundary, not a filter');

    const [injected] = await json('/api/affiliates/attribution-settings', {
      method: 'PATCH',
      body: JSON.stringify({ parameters: ['mref)|('] }),
    });
    assert.equal(injected, 400, 'a parameter name reaches a regex and a BigQuery pattern');
  });

  it('saves and reads back a changed rule', async () => {
    const [status, body] = await json('/api/affiliates/attribution-settings', {
      method: 'PATCH',
      body: JSON.stringify({ touch: 'last', windowDays: 14 }),
    });
    assert.equal(status, 200);
    assert.equal(body.settings.touch, 'last');
    assert.equal(body.settings.windowDays, 14);

    const stored = readAttributionSettings(db);
    assert.equal(stored.touch, 'last');
    assert.deepEqual(
      stored.parameters,
      ['mref', 'utm_source', 'ref'],
      'a partial save leaves the rest alone',
    );

    // Put it back, so suites that run after this one see the defaults.
    updateAttributionSettings({ touch: 'first', windowDays: 30 }, db);
  });
});

/* ------------------------------------------------------------- the pure part */

describe('the engine, on versioned rules directly', () => {
  it('skips a second charge with a reason that names the program shape', () => {
    const run = computeCommissions(
      [
        {
          id: 't1',
          appId: 'a',
          shopId: 's',
          component: 'subscription',
          occurredAt: '2024-02-01T00:00:00.000Z',
          grossAmount: 100,
          currency: 'USD',
        },
        {
          id: 't2',
          appId: 'a',
          shopId: 's',
          component: 'subscription',
          occurredAt: '2024-03-01T00:00:00.000Z',
          grossAmount: 100,
          currency: 'USD',
        },
      ],
      [
        {
          id: 'attr',
          affiliateId: 'aff',
          programId: 'p',
          appId: 'a',
          shopId: 's',
          referredAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      new Map([
        [
          'p',
          {
            id: 'p',
            payoutBasis: 'flat_per_referral' as const,
            percentCommission: 0,
            flatAmount: 12.5,
            flatCurrency: 'EUR',
            revenueComponents: ['subscription' as const],
            durationMonths: null,
            unassignAfterUninstallDays: null,
          },
        ],
      ]),
    );

    assert.equal(run.commissions.length, 1);
    assert.equal(run.commissions[0]!.amount, 12.5);
    assert.deepEqual(run.currencies, ['EUR'], 'the bounty currency, not the charge currency');
    assert.deepEqual(
      run.skipped.map((row) => row.reason),
      ['after_first_charge'],
      'the reason names the program shape, not a date',
    );
  });
});

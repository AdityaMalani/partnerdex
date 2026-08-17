import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb, type Db } from '../src/db/index.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import { importMantleExport } from '../src/affiliates/import.js';
import type { MantleExport, MantleProgram } from '../src/affiliates/mantle.js';
import {
  markCommissionPaid,
  membershipsByHandle,
  resolveAttributionShops,
  upsertCommission,
} from '../src/affiliates/store.js';
import { APP_ID, resetEnvironment } from './helpers.js';

/**
 * The affiliate ledger is the one table set in this store that no API can
 * re-serve, so the tests are pointed at the ways that could quietly stop being
 * true: a sync wiping a referral, a second import duplicating one, a merchant
 * who had not synced yet being dropped instead of held, and a recomputed
 * commission erasing the fact that it was already paid.
 *
 * The fixture is a miniature of the real export — two programs, a handle reused
 * across both, an approval queue, a soft-deleted referral that still carries
 * commissions, and one merchant who is not in `shops` — because every one of
 * those is a real shape in the 2026-08 Mantle data rather than an invented edge
 * case.
 */

const STOQ_PROGRAM = 'prog-stoq';
const FILEMONK_PROGRAM = 'prog-filemonk';

function program(id: string, appName: string, durationMonths?: number): MantleProgram {
  return {
    id,
    appId: `mantle-app-${id}`,
    rules: {
      percentCommission: 20,
      revenueComponents: ['subscription'],
      ...(durationMonths ? { durationMonths } : {}),
    },
    requireApprovalToJoin: appName === 'STOQ',
    removeOnUninstallDays: 30,
    app: { id: `mantle-app-${id}`, name: appName, displayName: appName },
  };
}

const STOQ = program(STOQ_PROGRAM, 'STOQ');
const FILEMONK = program(FILEMONK_PROGRAM, 'Filemonk', 24);

function fixture(): MantleExport {
  return {
    affiliates: [
      {
        id: 'aff-1',
        name: 'Both Programs Ltd',
        email: 'both@example.com',
        paypalEmail: 'pay@example.com',
        payoutHold: false,
        createdAt: '2025-01-01T00:00:00.000Z',
        memberships: [
          {
            id: 'mem-1',
            affiliateId: 'aff-1',
            affiliateProgramId: STOQ_PROGRAM,
            handle: 'shared01',
            status: 'enrolled',
            createdAt: '2025-01-01T00:00:00.000Z',
            approvedAt: '2025-01-02T00:00:00.000Z',
            affiliateProgram: STOQ,
          },
          // The same code in the other program. Two affiliates in the real
          // export do exactly this, which is why the handle is unique per
          // program and not globally.
          {
            id: 'mem-2',
            affiliateId: 'aff-1',
            affiliateProgramId: FILEMONK_PROGRAM,
            handle: 'shared01',
            status: 'enrolled',
            createdAt: '2025-01-01T00:00:00.000Z',
            affiliateProgram: FILEMONK,
          },
        ],
      },
      {
        id: 'aff-2',
        name: 'Waiting Approval',
        email: 'pending@example.com',
        payoutHold: true,
        createdAt: '2025-06-01T00:00:00.000Z',
        memberships: [
          {
            id: 'mem-3',
            affiliateId: 'aff-2',
            affiliateProgramId: STOQ_PROGRAM,
            handle: 'pending1',
            status: 'pending',
            createdAt: '2025-06-01T00:00:00.000Z',
            affiliateProgram: STOQ,
          },
        ],
      },
      {
        id: 'aff-3',
        name: 'Turned Down',
        email: 'rejected@example.com',
        createdAt: '2025-07-01T00:00:00.000Z',
        memberships: [
          {
            id: 'mem-4',
            affiliateId: 'aff-3',
            affiliateProgramId: STOQ_PROGRAM,
            handle: 'rejectd1',
            status: 'rejected',
            createdAt: '2025-07-01T00:00:00.000Z',
            rejectedAt: '2025-07-02T00:00:00.000Z',
            affiliateProgram: STOQ,
          },
        ],
      },
    ],
    attributions: [
      {
        id: 'attr-known',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        date: '2025-02-01T00:00:00.000Z',
        createdAt: '2025-02-01T00:00:00.000Z',
        appListingPageViewId: 'view-1',
        affiliateProgram: STOQ,
        appInstallation: { myshopifyDomain: 'known.myshopify.com', platformId: '900001' },
      },
      // The merchant the Partner API sync has not reached yet.
      {
        id: 'attr-unsynced',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        date: '2025-03-01T00:00:00.000Z',
        createdAt: '2025-03-01T00:00:00.000Z',
        appListingPageViewId: null,
        affiliateProgram: STOQ,
        appInstallation: { myshopifyDomain: 'later.myshopify.com', platformId: '900002' },
      },
      // Soft-deleted, on the same program and merchant as the live referral
      // above. Two merchants in the real export are in exactly this state, and
      // it is the shape that most easily collapses two facts into one row.
      {
        id: 'attr-superseded',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        date: '2024-11-01T00:00:00.000Z',
        createdAt: '2024-11-01T00:00:00.000Z',
        deletedAt: '2025-02-01T00:00:00.000Z',
        affiliateProgram: STOQ,
        appInstallation: { myshopifyDomain: 'known.myshopify.com', platformId: '900001' },
      },
      // Soft-deleted in Mantle and still owed on: recovered from the commission
      // rows that pointed at it.
      {
        id: 'attr-deleted',
        affiliateId: 'aff-1',
        affiliateProgramId: FILEMONK_PROGRAM,
        date: '2025-04-01T00:00:00.000Z',
        createdAt: '2025-04-01T00:00:00.000Z',
        deletedAt: '2025-09-01T00:00:00.000Z',
        affiliateProgram: FILEMONK,
        appInstallation: { myshopifyDomain: 'known.myshopify.com', platformId: '900001' },
      },
    ],
    commissions: [
      {
        id: 'comm-paid',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        affiliateAttributionId: 'attr-known',
        transactionId: 'mantle-txn-1',
        amount: 2,
        date: '2025-05-01T00:00:00.000Z',
        payoutId: 'payout-1',
        transaction: {
          date: '2025-05-01T00:00:00.000Z',
          grossAmount: 10,
          grossAmountCurrencyCode: 'USD',
        },
      },
      {
        id: 'comm-unpaid',
        affiliateId: 'aff-1',
        affiliateProgramId: STOQ_PROGRAM,
        affiliateAttributionId: 'attr-known',
        transactionId: 'mantle-txn-2',
        amount: 4,
        date: '2025-06-01T00:00:00.000Z',
        transaction: {
          date: '2025-06-01T00:00:00.000Z',
          grossAmount: 20,
          grossAmountCurrencyCode: 'USD',
        },
      },
      // Attached to the soft-deleted referral, and still money owed.
      {
        id: 'comm-on-deleted',
        affiliateId: 'aff-1',
        affiliateProgramId: FILEMONK_PROGRAM,
        affiliateAttributionId: 'attr-deleted',
        transactionId: 'mantle-txn-3',
        amount: 1,
        date: '2025-07-01T00:00:00.000Z',
        // Paid under a payout that has been requested but not settled.
        payoutId: 'payout-2',
        transaction: {
          date: '2025-07-01T00:00:00.000Z',
          grossAmount: 5,
          grossAmountCurrencyCode: 'USD',
        },
      },
    ],
    payouts: [
      { id: 'payout-1', status: 'paid', paidAt: '2025-08-01T00:00:00.000Z' },
      { id: 'payout-2', status: 'requested', paidAt: null },
    ],
  };
}

/** The local shops the import can join to. `later` deliberately arrives late. */
function seedShops(db: Db, domains: Array<[string, string]>): void {
  const statement = db.prepare(
    'INSERT OR REPLACE INTO shops (id, name, myshopify_domain) VALUES (?, ?, ?)',
  );
  for (const [id, domain] of domains) statement.run(id, domain, domain);
}

function seedApps(db: Db): void {
  const statement = db.prepare(
    'INSERT OR REPLACE INTO apps (id, name, discovered_at) VALUES (?, ?, ?)',
  );
  statement.run(APP_ID, 'STOQ', '2024-01-01T00:00:00.000Z');
  statement.run('222', 'Filemonk', '2024-01-01T00:00:00.000Z');
}

describe('affiliate import', () => {
  let db: Db;

  beforeEach(() => {
    resetEnvironment();
    db = getDb();
    seedApps(db);
    seedShops(db, [['900001', 'known.myshopify.com']]);
  });

  afterEach(() => closeDb());

  it('imports affiliates, memberships, referrals and commissions', () => {
    const report = importMantleExport(fixture(), { db });

    assert.equal(report.affiliates, 3);
    assert.equal(report.memberships.total, 4);
    assert.deepEqual(report.memberships.byStatus, { enrolled: 2, pending: 1, rejected: 1 });
    assert.equal(report.commissions.imported, 3);
    assert.equal(report.commissions.totalAmount, 7);

    // Only the payout that was actually settled marks its commission paid.
    assert.equal(report.commissions.paid, 1);
    assert.equal(report.commissions.paidAmount, 2);

    const programs = db
      .prepare('SELECT app_id, commission_rate, duration_months, require_approval FROM affiliate_programs ORDER BY app_id')
      .all() as Array<{
      app_id: string;
      commission_rate: number;
      duration_months: number | null;
      require_approval: number;
    }>;
    assert.deepEqual(programs, [
      { app_id: '111', commission_rate: 0.2, duration_months: null, require_approval: 1 },
      { app_id: '222', commission_rate: 0.2, duration_months: 24, require_approval: 0 },
    ]);
  });

  it('names every referral it could not match to a shop instead of dropping it', () => {
    const report = importMantleExport(fixture(), { db });

    assert.equal(report.attributions.total, 4);
    assert.equal(report.attributions.matched, 3);
    assert.equal(report.attributions.unmatched, 1);
    assert.equal(report.attributions.live, 2);
    assert.equal(report.attributions.deleted, 2);
    assert.deepEqual(
      report.attributions.misses.map((miss) => miss.myshopifyDomain),
      ['later.myshopify.com'],
    );

    // Imported anyway, with the domain kept so it can be resolved later.
    const row = db
      .prepare('SELECT shop_id, myshopify_domain FROM affiliate_attributions WHERE external_id = ?')
      .get('attr-unsynced') as { shop_id: string; myshopify_domain: string };
    assert.equal(row.shop_id, '');
    assert.equal(row.myshopify_domain, 'later.myshopify.com');
  });

  it('fills in the shop once the merchant syncs, without a re-import', () => {
    importMantleExport(fixture(), { db });
    seedShops(db, [['900002', 'later.myshopify.com']]);

    assert.equal(resolveAttributionShops(db), 1);
    const row = db
      .prepare('SELECT shop_id FROM affiliate_attributions WHERE external_id = ?')
      .get('attr-unsynced') as { shop_id: string };
    assert.equal(row.shop_id, '900002');

    // And nothing left to do on a second call.
    assert.equal(resolveAttributionShops(db), 0);
  });

  it('is idempotent, and a later run only adds what it learned', () => {
    const first = importMantleExport(fixture(), { db });
    const ids = () =>
      db.prepare('SELECT id FROM affiliate_attributions ORDER BY external_id').all() as Array<{
        id: string;
      }>;
    const before = ids();

    seedShops(db, [['900002', 'later.myshopify.com']]);
    const second = importMantleExport(fixture(), { db });

    const expected: Record<string, number> = {
      affiliates: 3,
      affiliate_programs: 2,
      affiliate_memberships: 4,
      affiliate_attributions: 4,
      affiliate_commissions: 3,
    };
    for (const [table, count] of Object.entries(expected)) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      assert.equal(n, count, `${table} duplicated on the second run`);
    }

    // Same rows, not replacements: the ids a portal or a payout would have
    // handed out are stable across runs.
    assert.deepEqual(ids(), before);
    assert.equal(first.attributions.matched, 3);
    assert.equal(second.attributions.matched, 4);
  });

  it('keeps a superseded referral and the live one that replaced it apart', () => {
    importMantleExport(fixture(), { db });

    const rows = db
      .prepare(
        `SELECT external_id AS externalId, deleted_at AS deletedAt
           FROM affiliate_attributions
          WHERE myshopify_domain = 'known.myshopify.com'
            AND program_id = (SELECT id FROM affiliate_programs WHERE app_id = ?)
          ORDER BY referred_at`,
      )
      .all(APP_ID) as Array<{ externalId: string; deletedAt: string | null }>;

    // Two facts, two rows. Collapsing them would hand one affiliate's history to
    // whichever of the pair the import happened to read second.
    assert.deepEqual(rows, [
      { externalId: 'attr-superseded', deletedAt: '2025-02-01T00:00:00.000Z' },
      { externalId: 'attr-known', deletedAt: null },
    ]);
  });

  it('keeps one handle usable in both programs', () => {
    importMantleExport(fixture(), { db });

    const memberships = membershipsByHandle('shared01', db);
    assert.equal(memberships.length, 2);
    assert.equal(new Set(memberships.map((m) => m.programId)).size, 2);

    // The handle comes off a URL, so case must not decide whether it resolves.
    assert.equal(membershipsByHandle('SHARED01', db).length, 2);
  });

  it('refuses a second live referral for the same merchant and program', () => {
    importMantleExport(fixture(), { db });

    const attribution = db
      .prepare(
        'SELECT affiliate_id AS affiliateId, program_id AS programId FROM affiliate_attributions WHERE external_id = ?',
      )
      .get('attr-known') as { affiliateId: string; programId: string };

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO affiliate_attributions (id, affiliate_id, program_id, myshopify_domain,
                                                 referred_at, source, created_at)
             VALUES ('duplicate', @affiliateId, @programId, 'known.myshopify.com',
                     '2026-01-01T00:00:00.000Z', 'manual', '2026-01-01T00:00:00.000Z')`,
          )
          .run(attribution),
      /UNIQUE/,
    );
  });

  it('survives a sync', () => {
    importMantleExport(fixture(), { db });
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_attributions')
      .get() as { n: number };

    // The whole reason these are source tables. `rebuildDerivedTables` drops and
    // rewrites everything it owns on every sync; a referral must not be in that
    // blast radius.
    rebuildDerivedTables(db);

    const after = db.prepare('SELECT COUNT(*) AS n FROM affiliate_attributions').get() as {
      n: number;
    };
    const commissions = db.prepare('SELECT COUNT(*) AS n FROM affiliate_commissions').get() as {
      n: number;
    };
    assert.equal(after.n, before.n);
    assert.equal(commissions.n, 3);
  });

  it('recomputing an amount never erases the record of payment', () => {
    importMantleExport(fixture(), { db });

    const commission = db
      .prepare('SELECT id, attribution_id, affiliate_id, program_id FROM affiliate_commissions WHERE external_id = ?')
      .get('comm-unpaid') as {
      id: string;
      attribution_id: string;
      affiliate_id: string;
      program_id: string;
    };

    markCommissionPaid(
      commission.id,
      { paidAt: '2026-01-15T00:00:00.000Z', reference: 'paypal-batch-9' },
      db,
    );

    // The engine recomputes: the charge was actually $25, not $20.
    upsertCommission(
      {
        attributionId: commission.attribution_id,
        affiliateId: commission.affiliate_id,
        programId: commission.program_id,
        amount: 5,
        basisAmount: 25,
        rate: 0.2,
        earnedAt: '2025-06-01T00:00:00.000Z',
        externalId: 'comm-unpaid',
      },
      db,
    );

    const row = db
      .prepare('SELECT amount, paid_at, paid_amount, payment_reference FROM affiliate_commissions WHERE id = ?')
      .get(commission.id) as {
      amount: number;
      paid_at: string;
      paid_amount: number;
      payment_reference: string;
    };
    assert.equal(row.amount, 5);
    assert.equal(row.paid_at, '2026-01-15T00:00:00.000Z');
    // The discrepancy stays visible rather than being tidied away: $4 was paid
    // against a commission now computed at $5.
    assert.equal(row.paid_amount, 4);
    assert.equal(row.payment_reference, 'paypal-batch-9');
  });

  it('leaves an unrecognised app unresolved rather than guessing', () => {
    const data = fixture();
    for (const affiliate of data.affiliates) {
      for (const membership of affiliate.memberships ?? []) {
        if (membership.affiliateProgram?.app) membership.affiliateProgram.app.name = 'Unknown App';
        if (membership.affiliateProgram?.app) membership.affiliateProgram.app.displayName = 'Unknown App';
      }
    }

    const report = importMantleExport(data, { db });
    const unresolved = report.programs.filter((entry) => entry.appId === '');
    assert.ok(unresolved.length > 0);

    // And the override is how a human settles it.
    const overridden = importMantleExport(data, {
      db,
      appIds: { [`mantle-app-${STOQ_PROGRAM}`]: APP_ID },
    });
    assert.equal(overridden.programs.find((p) => p.externalId === STOQ_PROGRAM)?.appId, APP_ID);
  });
});

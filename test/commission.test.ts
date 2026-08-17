import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonths,
  commissionAmount,
  computeCommissions,
  type CommissionAttribution,
  type CommissionTransaction,
  type ProgramRules,
} from '../src/affiliates/commission.js';
import { diffAgainstLedger, type LedgerCommission } from '../src/affiliates/commissionValidation.js';

const LIFETIME: ProgramRules = {
  id: 'stoq',
  percentCommission: 20,
  revenueComponents: ['subscription'],
  durationMonths: null,
  unassignAfterUninstallDays: 30,
  enforceUnassignAfterUninstall: true,
};

const CAPPED: ProgramRules = { ...LIFETIME, id: 'filemonk', durationMonths: 24 };

const RULES = new Map([
  [LIFETIME.id, LIFETIME],
  [CAPPED.id, CAPPED],
]);

function referral(overrides: Partial<CommissionAttribution> = {}): CommissionAttribution {
  return {
    id: 'attr-1',
    affiliateId: 'aff-1',
    programId: 'stoq',
    appId: 'app-1',
    shopId: 'shop-1',
    referredAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function charge(overrides: Partial<CommissionTransaction> = {}): CommissionTransaction {
  return {
    id: 'tx-1',
    appId: 'app-1',
    shopId: 'shop-1',
    component: 'subscription',
    occurredAt: '2024-02-01T00:00:00.000Z',
    grossAmount: 10,
    currency: 'USD',
    ...overrides,
  };
}

describe('commission rate', () => {
  it('takes 20% of gross, not of net', () => {
    assert.equal(commissionAmount(10, 20), 2);
    assert.equal(commissionAmount(29, 20), 5.8);
    assert.equal(commissionAmount(69, 20), 13.8);
  });

  it('rounds to cents rather than carrying the float product', () => {
    // Mantle's own ledger holds 251.8000000000001 for this one.
    assert.equal(commissionAmount(1259, 20), 251.8);
    assert.equal(commissionAmount(17.74, 20), 3.55);
  });
});

describe('eligibility', () => {
  it('pays on subscription sales', () => {
    const run = computeCommissions([charge()], [referral()], RULES);
    assert.equal(run.commissions.length, 1);
    assert.equal(run.commissions[0]?.amount, 2);
  });

  it('pays nothing on usage or one-time charges', () => {
    const run = computeCommissions(
      [charge({ id: 'u', component: 'usage' }), charge({ id: 'o', component: 'one_time' })],
      [referral()],
      RULES,
    );
    assert.equal(run.commissions.length, 0);
    assert.deepEqual(
      run.skipped.map((s) => s.reason),
      ['component_excluded', 'component_excluded'],
    );
  });

  it('does not claw back on a credit', () => {
    const run = computeCommissions([charge({ grossAmount: -57.03 })], [referral()], RULES);
    assert.equal(run.commissions.length, 0);
    assert.equal(run.skipped[0]?.reason, 'non_positive_gross');
  });

  it('ignores charges billed before the referral existed', () => {
    const run = computeCommissions(
      [charge({ occurredAt: '2023-12-31T23:59:59.000Z' })],
      [referral()],
      RULES,
    );
    assert.equal(run.commissions.length, 0);
    assert.equal(run.skipped[0]?.reason, 'before_referral');
  });

  it('reports a charge on a shop nobody referred rather than dropping it', () => {
    const run = computeCommissions([charge({ shopId: 'shop-999' })], [referral()], RULES);
    assert.equal(run.commissions.length, 0);
    assert.equal(run.skipped[0]?.reason, 'unattributed');
  });
});

describe('duration window', () => {
  it('never expires on a lifetime program', () => {
    const run = computeCommissions(
      [charge({ id: 'a', occurredAt: '2024-02-01T00:00:00.000Z' }), charge({ id: 'b', occurredAt: '2029-02-01T00:00:00.000Z' })],
      [referral()],
      RULES,
    );
    assert.equal(run.commissions.length, 2);
  });

  /**
   * The rule that costs money if it is wrong. A referral in January whose first
   * charge lands in June has a window running to the June two years later, not
   * the January. The lag between referral and first commission in the real data
   * is routinely weeks and can exceed a year, so anchoring at the referral
   * would quietly shorten every capped window by that lag.
   */
  it('anchors the 24-month cap at the first commission, not the referral', () => {
    const attribution = referral({ programId: 'filemonk', referredAt: '2024-01-01T00:00:00.000Z' });
    const run = computeCommissions(
      [
        charge({ id: 'first', occurredAt: '2024-07-01T00:00:00.000Z' }),
        // 25 months after the referral, but only 19 after the first charge.
        charge({ id: 'late', occurredAt: '2026-02-01T00:00:00.000Z' }),
      ],
      [attribution],
      RULES,
    );
    assert.equal(run.commissions.length, 2, 'the late charge is still inside the window');
  });

  it('stops paying once 24 months from the first commission have passed', () => {
    const attribution = referral({ programId: 'filemonk' });
    const run = computeCommissions(
      [
        charge({ id: 'first', occurredAt: '2024-07-01T00:00:00.000Z' }),
        charge({ id: 'edge', occurredAt: '2026-07-01T00:00:00.000Z' }),
        charge({ id: 'past', occurredAt: '2026-07-02T00:00:00.000Z' }),
      ],
      [attribution],
      RULES,
    );
    assert.deepEqual(run.commissions.map((c) => c.transactionId), ['first', 'edge']);
    assert.equal(run.skipped.at(-1)?.reason, 'after_duration_window');
  });

  it('does not let an ineligible charge start the clock', () => {
    const attribution = referral({ programId: 'filemonk' });
    const run = computeCommissions(
      [
        charge({ id: 'usage', component: 'usage', occurredAt: '2024-01-02T00:00:00.000Z' }),
        charge({ id: 'first', occurredAt: '2024-07-01T00:00:00.000Z' }),
        charge({ id: 'late', occurredAt: '2026-06-01T00:00:00.000Z' }),
      ],
      [attribution],
      RULES,
    );
    assert.equal(run.commissions.length, 2, 'the window runs from July, not from the usage charge');
  });

  it('clamps month arithmetic at the end of a short month', () => {
    assert.equal(addMonths('2024-02-29T00:00:00.000Z', 24), '2026-02-28T00:00:00.000Z');
    assert.equal(addMonths('2024-01-31T00:00:00.000Z', 1), '2024-02-29T00:00:00.000Z');
  });
});

describe('unassignment', () => {
  it('stops earning 30 days after the merchant uninstalls', () => {
    const attribution = referral({ uninstalledAt: '2024-03-01T00:00:00.000Z' });
    const run = computeCommissions(
      [
        charge({ id: 'inside', occurredAt: '2024-03-20T00:00:00.000Z' }),
        charge({ id: 'outside', occurredAt: '2024-04-05T00:00:00.000Z' }),
      ],
      [attribution],
      RULES,
    );
    assert.deepEqual(run.commissions.map((c) => c.transactionId), ['inside']);
    assert.equal(run.skipped[0]?.reason, 'after_uninstall_grace');
  });

  it('keeps paying when the grace rule is switched off', () => {
    const rules = new Map([['stoq', { ...LIFETIME, enforceUnassignAfterUninstall: false }]]);
    const attribution = referral({ uninstalledAt: '2024-03-01T00:00:00.000Z' });
    const run = computeCommissions(
      [charge({ occurredAt: '2024-06-01T00:00:00.000Z' })],
      [attribution],
      rules,
    );
    assert.equal(run.commissions.length, 1);
  });

  it('honours an explicit unassignment even with no uninstall', () => {
    const attribution = referral({ unassignedAt: '2024-03-01T00:00:00.000Z' });
    const run = computeCommissions(
      [charge({ occurredAt: '2024-04-01T00:00:00.000Z' })],
      [attribution],
      RULES,
    );
    assert.equal(run.commissions.length, 0);
    assert.equal(run.skipped[0]?.reason, 'after_unassignment');
  });
});

describe('currency', () => {
  it('surfaces every currency it saw, because nothing here converts', () => {
    const run = computeCommissions(
      [charge({ id: 'a' }), charge({ id: 'b', currency: 'CAD' })],
      [referral()],
      RULES,
    );
    assert.deepEqual(run.currencies, ['CAD', 'USD']);
  });
});

describe('ledger diff', () => {
  const ledgerRow = (overrides: Partial<LedgerCommission> = {}): LedgerCommission => ({
    id: 'l1',
    attributionId: 'attr-1',
    affiliateId: 'aff-1',
    programId: 'stoq',
    occurredAt: '2024-02-01T00:00:00.000Z',
    amount: 2,
    grossAmount: 10,
    currency: 'USD',
    ...overrides,
  });

  it('treats a float artifact as agreement, not as variance', () => {
    const run = computeCommissions([charge({ grossAmount: 1259 })], [referral()], RULES);
    const diff = diffAgainstLedger(run.commissions, [
      ledgerRow({ amount: 251.8000000000001, grossAmount: 1259 }),
    ]);
    assert.equal(diff.agreeing, 1);
    assert.equal(diff.netVariance, 0);
  });

  /**
   * Two charges can land on the same referral in the same second — a couple of
   * dozen of the few thousand real ledger rows do, as consecutive Shopify
   * transaction ids on one subscription. Keying the diff on (referral, instant)
   * collapsed each pair and reported perfect agreement over fewer rows than exist.
   */
  it('keeps both halves of a double charge billed in the same second', () => {
    const run = computeCommissions(
      [charge({ id: 'a' }), charge({ id: 'b' })],
      [referral()],
      RULES,
    );
    const diff = diffAgainstLedger(run.commissions, [
      ledgerRow({ id: 'l1' }),
      ledgerRow({ id: 'l2' }),
    ]);
    assert.equal(diff.ledgerRows, 2);
    assert.equal(diff.computedRows, 2);
    assert.equal(diff.agreeing, 2);
  });

  it('names a commission we produce that the ledger never paid', () => {
    const run = computeCommissions([charge()], [referral()], RULES);
    const diff = diffAgainstLedger(run.commissions, []);
    assert.equal(diff.differences[0]?.kind, 'extra_in_ours');
    assert.equal(diff.netVariance, 2);
    assert.equal(diff.absoluteVariance, 2);
  });

  it('names a ledger payment we fail to reproduce', () => {
    const diff = diffAgainstLedger([], [ledgerRow()]);
    assert.equal(diff.differences[0]?.kind, 'missing_from_ours');
    assert.equal(diff.agreementRate, 0);
    assert.equal(diff.netVariance, -2);
  });

  it('reports a real disagreement in amount', () => {
    const run = computeCommissions([charge({ grossAmount: 10 })], [referral()], RULES);
    const diff = diffAgainstLedger(run.commissions, [ledgerRow({ amount: 3 })]);
    assert.equal(diff.differences[0]?.kind, 'amount_mismatch');
    assert.equal(diff.netVariance, -1);
    assert.equal(diff.absoluteVariance, 1);
  });
});

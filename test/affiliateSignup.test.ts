import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { createApp } from '../src/server/index.js';
import { applyForSignup, generateHandle, SignupError } from '../src/affiliates/signup.js';
import { listReferrals, listPrograms } from '../src/affiliates/admin.js';
import {
  upsertAffiliate,
  upsertAttribution,
  upsertMembership,
  upsertProgram,
} from '../src/affiliates/store.js';
import { issueResetToken } from '../src/server/portalAuth.js';
import { resetSignupThrottle } from '../src/server/signup.js';
import { resetEnvironment } from './helpers.js';

/**
 * Affiliate self-signup, exercised over a real socket.
 *
 * This is the first fully public write in this product, so the tests are aimed
 * at the failures that are *silent* — the ones where the form still says thank
 * you and something is wrong underneath:
 *
 *   - A pending applicant handed a working referral link. They would promote it,
 *     send real installs, and be credited nothing, because the attribution
 *     pipeline only credits `enrolled` memberships. Nobody finds out until
 *     somebody asks why a balance never moved.
 *   - A second `affiliates` row for a person who already has one, splitting
 *     their commissions across two balances that nothing joins back together.
 *   - A duplicate handle inside one program, which would credit one affiliate's
 *     clicks to another.
 *   - A response that answers differently for an address that is already ours,
 *     which turns the form into a roster oracle. The review found exactly this
 *     shape on the login (finding 4) and it is easier to reintroduce here.
 *
 * Everything asserted about approval reads the program row rather than naming a
 * program, because that is what the implementation does and a test that
 * hardcoded "Stoq needs approval" would pass against an implementation that
 * hardcoded it too.
 */

const ADMIN_PASSWORD = 'correct-horse-battery';

let server: Server;
let origin: string;
let db: Db;

const ids = { approvalProgram: '', openProgram: '' };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, cookie?: string) =>
  fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} });

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  return header.split(';')[0]!;
}

/** The shape every handle in the imported data has, and the one `/r` accepts. */
const HANDLE_SHAPE = /^[a-z0-9]{8}$/;

function seed(): void {
  db.prepare(`INSERT INTO apps (id, name, discovered_at) VALUES ('111', 'STOQ', '2024-01-01')`).run();
  db.prepare(
    `INSERT INTO apps (id, name, discovered_at) VALUES ('222', 'Filemonk', '2024-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO app_listings (app_id, handle, url, source, created_at, updated_at)
     VALUES ('111', 'back-in-stock-restock-alerts',
             'https://apps.shopify.com/back-in-stock-restock-alerts', 'manual',
             '2024-01-01', '2024-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO app_listings (app_id, handle, url, source, created_at, updated_at)
     VALUES ('222', 'filemonk', 'https://apps.shopify.com/filemonk', 'manual',
             '2024-01-01', '2024-01-01')`,
  ).run();

  // The real shape: one program that reviews applications and one that does not.
  ids.approvalProgram = upsertProgram(
    { appId: '111', name: 'STOQ', commissionRate: 0.2, requireApproval: true },
    db,
  );
  ids.openProgram = upsertProgram(
    {
      appId: '222',
      name: 'Filemonk',
      commissionRate: 0.2,
      durationMonths: 24,
      unassignAfterUninstallDays: 30,
      requireApproval: false,
    },
    db,
  );
}

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: ADMIN_PASSWORD });
  db = getDb();
  seed();

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  // Every test that posts spends the same per-address budget, and the window is
  // minutes long. Nothing here should have to wait one out.
  resetSignupThrottle();
});

/* ------------------------------------------------------------------ handles */

describe('handle generation', () => {
  it('mints eight lowercase alphanumerics, all distinct, in the existing format', () => {
    const handles = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const handle = generateHandle(db, ids.openProgram);
      assert.match(handle, HANDLE_SHAPE, `"${handle}" is not the format the redirect route accepts`);
      // Written into the table each time, so every later draw is checked against
      // a growing population rather than against an empty one.
      upsertMembership(
        {
          affiliateId: upsertAffiliate({ name: `Filler ${i}`, email: `filler${i}@example.com` }, db),
          programId: ids.openProgram,
          handle,
          status: 'enrolled',
          joinedAt: '2026-01-01T00:00:00.000Z',
        },
        db,
      );
      handles.add(handle);
    }
    assert.equal(handles.size, 200, 'every generated handle should be distinct');
  });

  it('re-rolls when the draw is already taken in that program', (t) => {
    // 36 does not divide 256, so a byte maps to a letter by index — 0 is 'a',
    // 1 is 'b'. Two fixed draws: the first collides, the second must be used.
    const draws = [Buffer.alloc(8, 0), Buffer.alloc(8, 1)];
    t.mock.method(crypto, 'randomBytes', () => draws.shift() ?? Buffer.alloc(8, 2));

    upsertMembership(
      {
        affiliateId: upsertAffiliate({ name: 'Holder', email: 'holder@example.com' }, db),
        programId: ids.approvalProgram,
        handle: 'aaaaaaaa',
        status: 'enrolled',
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
      db,
    );

    assert.equal(generateHandle(db, ids.approvalProgram), 'bbbbbbbb');
  });

  it('is unique per program, not globally — two programs may share a handle', (t) => {
    // The imported data contains exactly this: two affiliates holding one handle
    // across both programs. A global unique index would have rejected them, so a
    // generator that treated the handle space as global would be enforcing a
    // constraint the schema deliberately does not have.
    t.mock.method(crypto, 'randomBytes', () => Buffer.alloc(8, 2));

    const affiliate = upsertAffiliate({ name: 'Both', email: 'both@example.com' }, db);
    upsertMembership(
      {
        affiliateId: affiliate,
        programId: ids.approvalProgram,
        handle: 'cccccccc',
        status: 'enrolled',
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
      db,
    );

    // Taken in the other program, therefore free here.
    assert.equal(generateHandle(db, ids.openProgram), 'cccccccc');
  });

  it('gives up loudly rather than looping when every draw collides', (t) => {
    t.mock.method(crypto, 'randomBytes', () => Buffer.alloc(8, 3));

    upsertMembership(
      {
        affiliateId: upsertAffiliate({ name: 'Blocker', email: 'blocker@example.com' }, db),
        programId: ids.approvalProgram,
        handle: 'dddddddd',
        status: 'enrolled',
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
      db,
    );

    assert.throws(
      () => generateHandle(db, ids.approvalProgram),
      (error: unknown) => error instanceof SignupError && error.status === 500,
    );
  });
});

/* ----------------------------------------------------------------- approval */

describe('approval, per program', () => {
  it('makes an applicant to a program that requires approval pending, with no link', async () => {
    const applied = await post('/portal/api/signup', {
      name: 'Pending Pat',
      email: 'pat@example.com',
      programIds: [ids.approvalProgram],
    });
    assert.equal(applied.status, 200);

    const membership = db
      .prepare(
        `SELECT m.status, m.handle, m.approved_at AS approvedAt
           FROM affiliate_memberships m
           JOIN affiliates a ON a.id = m.affiliate_id
          WHERE LOWER(a.email) = 'pat@example.com'`,
      )
      .get() as { status: string; handle: string; approvedAt: string | null };

    assert.equal(membership.status, 'pending');
    assert.equal(membership.approvedAt, null);
    // The handle exists — every membership has one, imported or not — which is
    // exactly why "no link" has to be enforced at the portal rather than by not
    // having a code to hand over.
    assert.match(membership.handle, HANDLE_SHAPE);

    // And the portal refuses to give it to them. Read through the real session,
    // because this is the assertion the whole rule is about.
    const affiliateId = db
      .prepare(`SELECT id FROM affiliates WHERE LOWER(email) = 'pat@example.com'`)
      .get() as { id: string };
    const { token } = issueResetToken(db, affiliateId.id);
    assert.equal(
      (await post('/portal/api/auth/set-password', { token, password: 'pat-password-1' })).status,
      200,
    );
    const cookie = cookieFrom(
      await post('/portal/api/auth/login', {
        email: 'pat@example.com',
        password: 'pat-password-1',
      }),
    );

    const me = (await (await get('/portal/api/me', cookie)).json()) as {
      memberships: Array<{ status: string; referralUrl: string | null }>;
    };
    assert.deepEqual(
      me.memberships.map((row) => [row.status, row.referralUrl]),
      [['pending', null]],
      'a pending membership must not carry a referral link',
    );

    const programs = (await (await get('/portal/api/programs', cookie)).json()) as {
      programs: Array<{ status: string; referralUrl: string | null }>;
    };
    assert.equal(programs.programs[0]!.referralUrl, null);

    // The handle itself must not be reachable as a working link either: the
    // response body is the whole surface, so search it for the code.
    const body = await (await get('/portal/api/programs', cookie)).text();
    assert.ok(
      !body.includes('mref='),
      'no shareable link should appear anywhere in a pending applicant\'s payload',
    );
  });

  it('enrols an applicant to a program that does not require approval, with a link', async () => {
    assert.equal(
      (
        await post('/portal/api/signup', {
          name: 'Open Olly',
          email: 'olly@example.com',
          programIds: [ids.openProgram],
        })
      ).status,
      200,
    );

    const membership = db
      .prepare(
        `SELECT m.status, m.approved_at AS approvedAt FROM affiliate_memberships m
           JOIN affiliates a ON a.id = m.affiliate_id
          WHERE LOWER(a.email) = 'olly@example.com'`,
      )
      .get() as { status: string; approvedAt: string | null };
    assert.equal(membership.status, 'enrolled');
    assert.ok(membership.approvedAt, 'an auto-enrolment should record when it started earning');

    const affiliateId = (
      db.prepare(`SELECT id FROM affiliates WHERE LOWER(email) = 'olly@example.com'`).get() as {
        id: string;
      }
    ).id;
    const { token } = issueResetToken(db, affiliateId);
    await post('/portal/api/auth/set-password', { token, password: 'olly-password-1' });
    const cookie = cookieFrom(
      await post('/portal/api/auth/login', {
        email: 'olly@example.com',
        password: 'olly-password-1',
      }),
    );

    const me = (await (await get('/portal/api/me', cookie)).json()) as {
      memberships: Array<{ status: string; referralUrl: string | null }>;
    };
    assert.equal(me.memberships[0]!.status, 'enrolled');
    assert.ok(me.memberships[0]!.referralUrl, 'an enrolled membership should carry a link');
  });

  it('follows the program row rather than the program, when the flag is flipped', () => {
    // The rule is a column, not a name. Flip it and the same code path has to
    // produce the other outcome — which is what makes a third program safe.
    db.prepare(`UPDATE affiliate_programs SET require_approval = 1 WHERE id = ?`).run(
      ids.openProgram,
    );
    const outcome = applyForSignup(
      { name: 'Flipped', email: 'flipped@example.com', programIds: [ids.openProgram] },
      db,
    );
    assert.equal(outcome.memberships[0]!.status, 'pending');
    db.prepare(`UPDATE affiliate_programs SET require_approval = 0 WHERE id = ?`).run(
      ids.openProgram,
    );
  });

  it('leaves the 17 pending and 22 rejected memberships alone, and does not re-admit a rejection', () => {
    const affiliate = upsertAffiliate({ name: 'Turned Down', email: 'rejected@example.com' }, db);
    upsertMembership(
      {
        affiliateId: affiliate,
        programId: ids.approvalProgram,
        handle: 'rejected',
        status: 'rejected',
        joinedAt: '2025-01-01T00:00:00.000Z',
        rejectedAt: '2025-02-01T00:00:00.000Z',
      },
      db,
    );

    const outcome = applyForSignup(
      { name: 'Turned Down', email: 'rejected@example.com', programIds: [ids.approvalProgram] },
      db,
    );
    assert.equal(outcome.memberships[0]!.alreadyApplied, true);
    assert.equal(outcome.memberships[0]!.status, 'rejected');

    const after = db
      .prepare(
        `SELECT status, handle, rejected_at AS rejectedAt FROM affiliate_memberships
          WHERE affiliate_id = ? AND program_id = ?`,
      )
      .get(affiliate, ids.approvalProgram) as {
      status: string;
      handle: string;
      rejectedAt: string;
    };
    assert.equal(after.status, 'rejected', 're-applying must not walk around a decision');
    assert.equal(after.handle, 'rejected', 'an existing handle must not be reissued');
    assert.equal(after.rejectedAt, '2025-02-01T00:00:00.000Z');
  });
});

/* ------------------------------------------------- one person, one account */

describe('an existing affiliate joining a second program', () => {
  it('attaches a membership to the account they already have', async () => {
    // Imported the way they all were: an external id, a handle, one program.
    const existing = upsertAffiliate(
      { name: 'Imported Ivy', email: 'Ivy@Example.com', source: 'imported', externalId: 'mantle-1' },
      db,
    );
    upsertMembership(
      {
        affiliateId: existing,
        programId: ids.approvalProgram,
        handle: 'ivyivyiv',
        status: 'enrolled',
        joinedAt: '2024-06-01T00:00:00.000Z',
      },
      db,
    );

    // She applies to the other program, typing her address in a different case
    // than the import stored it — which is how a person types an address.
    const response = await post('/portal/api/signup', {
      name: 'Ivy Renamed By An Attacker',
      email: 'ivy@example.com',
      programIds: [ids.openProgram],
    });
    assert.equal(response.status, 200);

    const affiliates = db
      .prepare(`SELECT id, name, source FROM affiliates WHERE LOWER(email) = 'ivy@example.com'`)
      .all() as Array<{ id: string; name: string; source: string }>;
    assert.equal(affiliates.length, 1, 'a second row would split her balance in two');
    assert.equal(affiliates[0]!.id, existing);
    // The name is not overwritten: anyone who knows an address could otherwise
    // rename the affiliate an operator reads when deciding who to pay.
    assert.equal(affiliates[0]!.name, 'Imported Ivy');
    assert.equal(affiliates[0]!.source, 'imported');

    const memberships = db
      .prepare(
        `SELECT program_id AS programId, handle, status FROM affiliate_memberships
          WHERE affiliate_id = ? ORDER BY joined_at`,
      )
      .all(existing) as Array<{ programId: string; handle: string; status: string }>;
    assert.equal(memberships.length, 2);
    assert.equal(memberships[0]!.handle, 'ivyivyiv', 'the existing link must keep working');
    assert.equal(memberships[1]!.programId, ids.openProgram);
    assert.equal(memberships[1]!.status, 'enrolled');
    assert.match(memberships[1]!.handle, HANDLE_SHAPE);
    assert.notEqual(
      memberships[1]!.handle,
      'ivyivyiv',
      'a fresh handle per program keeps a click unambiguous about which listing it meant',
    );
  });

  it('is idempotent for a program they are already in', async () => {
    await post('/portal/api/signup', {
      name: 'Repeat',
      email: 'repeat@example.com',
      programIds: [ids.openProgram],
    });
    const first = db
      .prepare(
        `SELECT m.handle, m.joined_at AS joinedAt FROM affiliate_memberships m
           JOIN affiliates a ON a.id = m.affiliate_id
          WHERE LOWER(a.email) = 'repeat@example.com'`,
      )
      .get() as { handle: string; joinedAt: string };

    resetSignupThrottle();
    await post('/portal/api/signup', {
      name: 'Repeat',
      email: 'repeat@example.com',
      programIds: [ids.openProgram],
    });

    const rows = db
      .prepare(
        `SELECT m.handle, m.joined_at AS joinedAt FROM affiliate_memberships m
           JOIN affiliates a ON a.id = m.affiliate_id
          WHERE LOWER(a.email) = 'repeat@example.com'`,
      )
      .all() as Array<{ handle: string; joinedAt: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.handle, first.handle, 'a second application must not reissue the link');
  });
});

/* -------------------------------------------------------------- disclosure */

describe('what signup tells a stranger', () => {
  it('answers identically for a known address and an unknown one', async () => {
    upsertAffiliate({ name: 'Known', email: 'known@example.com' }, db);

    const known = await post('/portal/api/signup', {
      name: 'Probe',
      email: 'known@example.com',
      programIds: [ids.openProgram],
    });
    resetSignupThrottle();
    const unknown = await post('/portal/api/signup', {
      name: 'Probe',
      email: 'definitely-nobody@example.com',
      programIds: [ids.openProgram],
    });

    assert.equal(known.status, unknown.status);
    assert.deepEqual(await known.json(), await unknown.json());
  });

  /**
   * The clock, which is the half the review found the login failing (finding 4).
   *
   * **This test asserts no wall-clock number, and no fixed ratio between the two
   * paths either.** It used to assert "the two medians are within 4× of each
   * other", and that is a claim about how quiet the machine is as much as about
   * the code. Unlike the login there is no scrypt here to dominate, so a signup
   * costs a couple of milliseconds and a single GC pause is larger than the
   * whole measurement. It failed about one run in four, in *both* directions —
   * sometimes the known path looked slower, sometimes the unknown one — which is
   * the signature of a test reading noise rather than a property.
   *
   * The property underneath does not need a constant, it needs a control. Three
   * series are measured instead of two:
   *
   *   - `known`   — an address that is already ours,
   *   - `unknown` — a fresh address every round, so it is the unknown path each
   *                 time rather than the first-round-only version of it,
   *   - `control` — a *second* address that is also already ours.
   *
   * `control` runs exactly the same branch as `known`, so the separation between
   * those two is this machine's noise floor and nothing else. The separation
   * between `known` and `unknown` is that same noise plus whatever the code
   * actually does differently. The assertion is that the second is not much
   * bigger than the first — a ratio between measurements taken on the same box
   * in the same second, so contention inflates both together and cancels.
   *
   * The three are interleaved and their order rotates each round, so a GC pause
   * or a frequency change lands on all three rather than on whichever one
   * happened to be running in its own phase. That interleaving is the other half
   * of the fix: the old version measured one path to completion and then the
   * other, so any drift between the two phases was read as signal.
   *
   * What this catches is the only thing it is for: an expensive branch that one
   * path takes and the other does not, which is finding 4's shape. Measured
   * against that defect deliberately reintroduced — a hash on the known path
   * only — `observed` comes back around 125× against a floor that does not move,
   * because the control pays the same cost the known path does.
   *
   * What it does *not* catch, and no wall-clock test at this endpoint can: a
   * branch that merely skips a few in-memory statements. That is worth about
   * 0.05 ms against a request of roughly 0.45 ms, so it never rises above the
   * noise floor of any machine. The test this replaces did not catch it either.
   * The defence against that one is the assertion above this test, which
   * compares the two responses byte for byte.
   */
  it('takes comparable time on both paths', async () => {
    upsertAffiliate({ name: 'Timed', email: 'timed@example.com' }, db);
    upsertAffiliate({ name: 'Timed Control', email: 'timed-control@example.com' }, db);

    type Series = 'known' | 'unknown' | 'control';
    const ORDER: Series[] = ['known', 'unknown', 'control'];
    const ROUNDS = 60;
    const samples: Record<Series, number[]> = { known: [], unknown: [], control: [] };

    const probe = async (email: string): Promise<number> => {
      resetSignupThrottle();
      const started = performance.now();
      await post('/portal/api/signup', {
        name: 'Probe',
        email,
        programIds: [ids.openProgram],
      });
      return performance.now() - started;
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      for (let slot = 0; slot < ORDER.length; slot += 1) {
        const series = ORDER[(round + slot) % ORDER.length]!;
        const email =
          series === 'known'
            ? 'timed@example.com'
            : series === 'control'
              ? 'timed-control@example.com'
              : `nobody-${round}-${slot}-${Date.now()}@example.com`;
        samples[series].push(await probe(email));
      }
    }

    /*
     * Mean of the fastest 60% of a series. A plain median over seven samples was
     * what the old test used and it was still noisy enough to fail one run in
     * four: one scheduling hiccup in a short series moves the middle value. The
     * upper tail here is always the machine and never the code, so dropping it
     * and averaging what is left leaves a figure that repeats to within a few
     * percent, loaded or idle.
     */
    const typical = (xs: number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b);
      const kept = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.6)));
      return kept.reduce((total, x) => total + x, 0) / kept.length;
    };
    const separation = (a: number, b: number): number =>
      Math.max(a, b) / Math.max(Math.min(a, b), 0.01);

    const knownMs = typical(samples.known);
    const unknownMs = typical(samples.unknown);
    const controlMs = typical(samples.control);

    const observed = separation(knownMs, unknownMs);
    const noiseFloor = separation(knownMs, controlMs);

    /*
     * Loose on purpose. On a healthy tree `observed` measures 1.07–1.35 and the
     * floor 1.01–1.35, and those ranges were taken with the box loaded to twice
     * its core count as well as idle — they barely move, which is the point of
     * measuring a control. The `1.8` is a minimum ceiling for the case where the
     * floor comes back unusually tight, so a quiet machine cannot make this test
     * *stricter* than a busy one. The defect it exists for lands two orders of
     * magnitude past either bound, so there is nothing to be gained by cutting
     * the headroom finer.
     */
    assert.ok(
      observed <= Math.max(noiseFloor * 2, 1.8),
      `the known and unknown paths must not separate by more than two known paths do: ` +
        `known ${knownMs.toFixed(2)}ms vs unknown ${unknownMs.toFixed(2)}ms is ${observed.toFixed(2)}×, ` +
        `against a same-branch noise floor of ${noiseFloor.toFixed(2)}× ` +
        `(control ${controlMs.toFixed(2)}ms)`,
    );
  });

  it('never writes a set-password link or token to a log', async () => {
    const written: string[] = [];
    const channels = ['log', 'warn', 'error'] as const;
    const originals = channels.map((channel) => console[channel]);
    channels.forEach((channel) => {
      console[channel] = (...args: unknown[]) => {
        written.push(args.map((arg) => String(arg)).join(' '));
      };
    });

    try {
      await post('/portal/api/signup', {
        name: 'Logged',
        email: 'logged@example.com',
        programIds: [ids.openProgram],
      });
    } finally {
      channels.forEach((channel, index) => {
        console[channel] = originals[index]!;
      });
    }

    const all = written.join('\n');
    assert.ok(!all.includes('set-password/'), 'a link in the log is an account-takeover URL');
    const stored = db
      .prepare(
        `SELECT c.reset_token_hash AS hash FROM affiliate_credentials c
           JOIN affiliates a ON a.id = c.affiliate_id
          WHERE LOWER(a.email) = 'logged@example.com'`,
      )
      .get() as { hash: string } | undefined;
    assert.ok(stored?.hash, 'the token should still be minted and stored as a digest');
  });

  it('exposes nothing but the offer on the public program list', async () => {
    const response = await get('/portal/api/signup/programs');
    assert.equal(response.status, 200);
    const body = await response.text();

    // Neither an affiliate nor a merchant is named or counted anywhere in it.
    for (const leak of ['appId', 'app_id', 'affiliates', 'externalId', 'myshopify', 'email']) {
      assert.ok(!body.includes(leak), `the public program list must not carry "${leak}"`);
    }

    const parsed = JSON.parse(body) as {
      programs: Array<{ id: string; requiresApproval: boolean; unassignAfterUninstallDays: number | null }>;
      termsUrl: string;
    };
    assert.ok(parsed.programs.length >= 2);
    assert.equal(parsed.termsUrl, '', 'no terms document is configured, and none is invented');
    const approval = parsed.programs.find((program) => program.id === ids.approvalProgram);
    assert.equal(approval?.requiresApproval, true);
  });

  it('refuses input that is not plausible, and bounds what it stores', async () => {
    const cases: Array<[string, unknown]> = [
      ['no name', { name: '', email: 'a@b.com', programIds: [ids.openProgram] }],
      ['name too long', { name: 'x'.repeat(500), email: 'a@b.com', programIds: [ids.openProgram] }],
      ['not an email', { name: 'A', email: 'not-an-email', programIds: [ids.openProgram] }],
      [
        'an email carrying a newline, which would forge a log record',
        { name: 'A', email: 'a@b.com\nINFO fake', programIds: [ids.openProgram] },
      ],
      ['email too long', { name: 'A', email: `${'x'.repeat(250)}@b.com`, programIds: [ids.openProgram] }],
      ['no program', { name: 'A', email: 'a@b.com', programIds: [] }],
      ['a program that does not exist', { name: 'A', email: 'a@b.com', programIds: ['nope'] }],
    ];

    for (const [label, body] of cases) {
      resetSignupThrottle();
      const response = await post('/portal/api/signup', body);
      assert.equal(response.status, 400, `${label} should be refused`);
    }

    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM affiliates WHERE email LIKE 'a@b.com%'`).get() as {
        n: number;
      }).n,
      0,
      'nothing refused should have been written',
    );
  });
});

/* ------------------------------------------------------------ rate limiting */

describe('rate limiting', () => {
  it('stops a run of applications from one client, and says how long for', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await post('/portal/api/signup', {
        name: `Flood ${i}`,
        email: `flood${i}@example.com`,
        programIds: [ids.openProgram],
      });
      statuses.push(response.status);
      if (response.status === 429) {
        const body = (await response.json()) as { error: string };
        assert.match(body.error, /Try again in \d+ second\(s\)/);
      }
    }

    assert.ok(statuses.includes(429), 'a public write endpoint must have a ceiling');
    // And it is the *existing* throttle, so the free attempts come first and the
    // lockout follows — not a limiter that refuses from the first request.
    assert.equal(statuses[0], 200);
    assert.equal(statuses[statuses.length - 1], 429);

    const created = (
      db.prepare(`SELECT COUNT(*) AS n FROM affiliates WHERE email LIKE 'flood%'`).get() as {
        n: number;
      }
    ).n;
    assert.ok(created < 12, 'a throttled application must not still be written');
  });

  it('counts refused applications too, so the counter is not an oracle', async () => {
    // Every request spends budget whatever its outcome. A counter that only bit
    // on one outcome would be a signal about which outcome happened.
    let refused = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await post('/portal/api/signup', {
        name: '',
        email: 'invalid',
        programIds: [],
      });
      if (response.status === 429) refused += 1;
    }
    assert.ok(refused > 0, 'invalid submissions must spend the budget too');
  });
});

/* ------------------------------------------------------------- the API gaps */

describe('GET /api/affiliates/referrals', () => {
  let adminCookie: string;

  before(async () => {
    const affiliate = upsertAffiliate({ name: 'Feed', email: 'feed@example.com' }, db);
    upsertMembership(
      {
        affiliateId: affiliate,
        programId: ids.approvalProgram,
        handle: 'feedfeed',
        status: 'enrolled',
        joinedAt: '2025-01-01T00:00:00.000Z',
      },
      db,
    );
    db.prepare(`INSERT INTO shops (id, name, myshopify_domain)
                VALUES ('s-9', 'Feed Store', 'feedstore.myshopify.com')`).run();

    upsertAttribution(
      {
        affiliateId: affiliate,
        programId: ids.approvalProgram,
        shopId: 's-9',
        myshopifyDomain: 'feedstore.myshopify.com',
        referredAt: '2025-03-01T00:00:00.000Z',
        source: 'ga4',
        handle: 'feedfeed',
      },
      db,
    );
    upsertAttribution(
      {
        affiliateId: affiliate,
        programId: ids.approvalProgram,
        myshopifyDomain: 'gone.myshopify.com',
        referredAt: '2025-02-01T00:00:00.000Z',
        source: 'manual',
        handle: 'feedfeed',
        deletedAt: '2025-06-01T00:00:00.000Z',
      },
      db,
    );

    adminCookie = cookieFrom(await post('/api/auth/login', { password: ADMIN_PASSWORD }));
  });

  it('is behind the dashboard gate', async () => {
    assert.equal((await get('/api/affiliates/referrals')).status, 401);
  });

  it('returns soft-deleted referrals with their standing, and counts both', async () => {
    const body = (await (await get('/api/affiliates/referrals?limit=500', adminCookie)).json()) as {
      referrals: Array<{ standing: string; unassignedAt: string | null; source: string }>;
      counts: { total: number; live: number; unassigned: number };
    };

    assert.equal(body.counts.total, body.counts.live + body.counts.unassigned);
    assert.ok(body.counts.unassigned >= 1, 'the unassigned population is the paged-total-versus-real-total gap');
    const unassigned = body.referrals.filter((row) => row.standing === 'unassigned');
    assert.ok(unassigned.length >= 1);
    assert.ok(unassigned.every((row) => row.unassignedAt !== null));
  });

  it('filters by source, affiliate and program, and pages', () => {
    const ga4 = listReferrals({ source: 'ga4' }, db);
    assert.ok(ga4.referrals.every((row) => row.source === 'ga4'));
    assert.ok(ga4.total >= 1);

    const manual = listReferrals({ source: 'manual' }, db);
    assert.ok(manual.referrals.every((row) => row.source === 'manual'));

    // An unrecognised source is ignored rather than returning an empty page that
    // reads as "no referrals".
    assert.equal(listReferrals({ source: 'nonsense' }, db).total, listReferrals({}, db).total);

    const all = listReferrals({ limit: 500 }, db);
    const firstPage = listReferrals({ limit: 1, page: 1 }, db);
    assert.equal(firstPage.referrals.length, 1);
    assert.equal(firstPage.total, all.total);
    assert.equal(firstPage.hasNextPage, all.total > 1);
    assert.equal(firstPage.hasPreviousPage, false);
    assert.equal(listReferrals({ limit: 1, page: 2 }, db).hasPreviousPage, true);

    const byProgram = listReferrals({ programId: ids.approvalProgram }, db);
    assert.ok(byProgram.referrals.every((row) => row.programId === ids.approvalProgram));

    const one = byProgram.referrals[0]!;
    assert.ok(listReferrals({ affiliateId: one.affiliateId }, db)
      .referrals.every((row) => row.affiliateId === one.affiliateId));
  });

  it('refuses an unknown sort rather than putting it in the SQL', () => {
    const injected = listReferrals({ sort: "t.id; DROP TABLE affiliates--" }, db);
    assert.ok(injected.total >= 1, 'an unknown sort falls back rather than throwing');
    assert.ok(
      db.prepare(`SELECT COUNT(*) AS n FROM affiliates`).get(),
      'the table is still there',
    );
  });
});

describe('GET /api/affiliates/programs', () => {
  it('carries the three fields the database already held', () => {
    const program = listPrograms(db).find((row) => row.id === ids.openProgram);
    assert.ok(program);
    assert.deepEqual(program.revenueComponents, ['subscription']);
    // The figure `web/src/portal/terms.ts` hardcodes today, now sourceable.
    assert.equal(program.unassignAfterUninstallDays, 30);
    assert.equal(typeof program.listingUrl, 'string');
  });
});

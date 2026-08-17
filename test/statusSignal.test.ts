import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server/index.js';
import { getDb } from '../src/db/index.js';
import { resetEnvironment, seed } from './helpers.js';

/**
 * What `/api/status` tells the shell about an empty store.
 *
 * The row counts became opt-in because counting every transaction is O(n) on a
 * route the dashboard polls on every navigation. The shell had been using those
 * counts for something else as well — deciding whether the store holds anything
 * at all — and that question does not survive the counts going away: they stop
 * arriving, the absence reads as zero, and a full store reports itself empty.
 *
 * So the cases here are the pairing. The counts must stay off unless asked for,
 * and the emptiness answer must arrive regardless.
 */

const PASSWORD = 'correct-horse-battery';

let server: Server;
let origin: string;
let cookie: string;

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: PASSWORD });
  seed([{ shopId: '10', chargeRef: 'c1', amount: 25, activatedAt: '2024-01-05T00:00:00Z' }]);

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});

after(() => server?.close());

const status = async (query = ''): Promise<Record<string, unknown>> => {
  const response = await fetch(`${origin}/api/status${query}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
};

describe('the status a dashboard shell polls', () => {
  it('does not send row counts unless they are asked for', async () => {
    const body = await status();
    for (const key of ['apps', 'shops', 'events', 'transactions', 'subscriptions']) {
      assert.equal(key in body, false, `${key} should be opt-in`);
    }
  });

  it('sends them on request', async () => {
    const body = await status('?counts=1');
    assert.equal(typeof body.transactions, 'number');
    assert.equal(typeof body.subscriptions, 'number');
  });

  /**
   * The pairing. Without this the opt-in above is a regression: the shell asks
   * "does this store hold anything", the counts it used to read are gone, and
   * every instance answers no.
   */
  it('always says whether the store holds anything, counts or no counts', async () => {
    const body = await status();
    assert.equal('hasData' in body, true, 'hasData is not opt-in');
    assert.equal(body.hasData, true, 'the seeded store holds something');
  });

  it('says so truthfully when the store is empty', async () => {
    const db = getDb();
    db.prepare('DELETE FROM transactions').run();
    db.prepare('DELETE FROM subscriptions').run();

    const body = await status();
    assert.equal(body.hasData, false);
  });
});

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, describe, it } from 'node:test';
import { ConfigError, getConfig } from '../src/config.js';
import { createApp } from '../src/server/index.js';
import { resetEnvironment } from './helpers.js';

/**
 * How many proxies this process believes are in front of it.
 *
 * This is the number that decides whether `request.ip` — the key under every
 * throttle in the server — is chosen by the deployment or by the client, and it
 * used to be the literal `1` compiled into `index.ts`. It is configuration now
 * because the answer is different for the deployment we have and the one the
 * runbook proposes, and because getting it wrong is silent in both directions:
 *
 *   - **Too low:** a proxy's own appended entry is read as the client, so every
 *     user on earth shares one bucket and one guesser locks out the population.
 *   - **Too high:** the walk runs into the part of the header the client wrote,
 *     so a client picks its own bucket and every limit becomes optional.
 *
 * The behavioural tests below are the ones worth having, because they assert
 * what an attacker actually experiences rather than what a setting says.
 */

const PASSWORD = 'correct-horse-battery';
const servers: Server[] = [];

after(() => {
  for (const server of servers) server.close();
});

async function appWith(env: Record<string, string>): Promise<string> {
  resetEnvironment({ DASHBOARD_PASSWORD: PASSWORD, ...env });
  const server = createApp().listen(0);
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A failed dashboard login, with a hand-written `X-Forwarded-For`. */
const guess = (origin: string, forwardedFor: string): Promise<Response> =>
  fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ password: 'not-the-password' }),
  });

describe('the trusted hop count', () => {
  it('defaults to the single hop the code used to compile in', async () => {
    resetEnvironment({ TRUST_PROXY: 'true' });
    assert.equal(getConfig().runtime.trustProxyHops, 1);
    // The setting reaches Express, rather than being read and dropped.
    assert.equal(createApp().get('trust proxy'), 1);
  });

  it('takes the count from the environment, for the two-hop deployment', () => {
    resetEnvironment({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' });
    assert.equal(getConfig().runtime.trustProxyHops, 2);
    assert.equal(createApp().get('trust proxy'), 2);
  });

  /**
   * Zero would mean "there is a proxy and it is no hops away", which is not a
   * deployment; it is a typo in the one number that decides whether clients can
   * choose their own rate-limit key. Fail at startup, where somebody is looking.
   */
  it('refuses a hop count that cannot describe a real deployment', () => {
    for (const hops of ['0', '-1']) {
      resetEnvironment({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: hops });
      assert.throws(() => getConfig(), ConfigError, `TRUST_PROXY_HOPS=${hops} should be refused`);
    }
  });

  /**
   * The measured shape of the current deployment: Fly appends the true client
   * address, so with one trusted hop the spoofed entries a client writes sit to
   * the *left* of it and are ignored. Rotating them buys no fresh bucket.
   *
   * This is the test that would catch someone "fixing" the hop count upward
   * without a second proxy actually being there.
   */
  it('ignores a spoofed entry when one appending proxy sits in front', async () => {
    const origin = await appWith({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '1' });

    let last = 200;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // A fresh forged client address each time, with the proxy's appended entry
      // for the real client behind it — exactly what Fly produces.
      last = (await guess(origin, `198.51.100.${attempt}, 203.0.113.10`)).status;
    }
    assert.equal(last, 429, 'rotating X-Forwarded-For must not buy a fresh lockout bucket');
  });

  /**
   * And the failure mode in the other direction, asserted so the cost of an
   * over-set hop count is written down in something that runs. With two hops
   * trusted but only one proxy appending, the client's own first entry becomes
   * the key and the lockout never fires.
   *
   * Nothing to fix here — it is what "trust two hops" means. It is the reason
   * the count must be measured against the real deployment rather than guessed,
   * and the reason the default did not change.
   */
  it('lets a client choose its own bucket when more hops are trusted than exist', async () => {
    const origin = await appWith({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await guess(origin, `192.0.2.${attempt}, 203.0.113.11`)).status);
    }
    assert.ok(
      statuses.every((status) => status === 401),
      'with a hop count higher than reality, the throttle is bypassable by design',
    );
  });
});

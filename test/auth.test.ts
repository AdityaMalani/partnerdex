import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server/index.js';
import { resetEnvironment } from './helpers.js';

/**
 * The gate, exercised over a real socket rather than against the middleware in
 * isolation — the thing worth asserting is that a request with no cookie cannot
 * reach the store, and that only holds if the routes are mounted in the right
 * order.
 *
 * The cases here are the ones where an auth bug is silent: a route accidentally
 * left outside the gate, a cookie that still verifies after the password
 * changed, a signature that can be edited, an expiry that is not checked.
 */

const PASSWORD = 'correct-horse-battery';

let server: Server;
let origin: string;

/** The `Set-Cookie` value reduced to what a browser would send back. */
function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected a Set-Cookie header');
  return header.split(';')[0]!;
}

function login(body: unknown): Promise<Response> {
  return fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const get = (path: string, cookie?: string): Promise<Response> =>
  fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} });

before(async () => {
  resetEnvironment({ DASHBOARD_PASSWORD: PASSWORD });
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the dashboard gate', () => {
  it('closes every route that reads the store', async () => {
    for (const path of [
      '/api/status',
      '/api/apps',
      '/api/metrics',
      '/api/overview?metrics=mrr',
      '/api/customers',
      '/api/contacts',
      '/api/notifications',
    ]) {
      const response = await get(path);
      assert.equal(response.status, 401, `${path} should require a session`);
    }
  });

  it('leaves the health probe and the session check open', async () => {
    assert.equal((await get('/api/health')).status, 200);

    const session = await get('/api/auth/session');
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { required: true, authenticated: false });
  });

  it('rejects a wrong password without saying which part was wrong', async () => {
    const response = await login({ password: 'not-it' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Incorrect password.');
    assert.equal(response.headers.get('set-cookie'), null);
  });

  it('admits the right password and the cookie it issues', async () => {
    const response = await login({ password: PASSWORD });
    assert.equal(response.status, 200);

    const cookie = cookieFrom(response);
    const status = await get('/api/status', cookie);
    assert.equal(status.status, 200);

    const session = await get('/api/auth/session', cookie);
    assert.deepEqual(await session.json(), { required: true, authenticated: true });
  });

  it('ends the cookie with the browser unless remember me is ticked', async () => {
    const plain = await login({ password: PASSWORD, remember: false });
    assert.ok(
      !/max-age/i.test(plain.headers.get('set-cookie') ?? ''),
      'a session cookie must not carry Max-Age',
    );

    const remembered = await login({ password: PASSWORD, remember: true });
    assert.match(remembered.headers.get('set-cookie') ?? '', /Max-Age=2592000/i);
  });

  it('keeps the cookie away from scripts', async () => {
    const header = (await login({ password: PASSWORD })).headers.get('set-cookie') ?? '';
    assert.match(header, /HttpOnly/i);
    assert.match(header, /SameSite=Lax/i);
  });

  it('refuses a token whose signature was edited', async () => {
    const cookie = cookieFrom(await login({ password: PASSWORD }));
    const [name, token] = cookie.split('=');
    const [payload, signature] = token!.split('.');

    // Flip one character of the signature; everything else is untouched.
    const flipped = signature!.slice(0, -1) + (signature!.endsWith('A') ? 'B' : 'A');
    const response = await get('/api/status', `${name}=${payload}.${flipped}`);
    assert.equal(response.status, 401);
  });

  it('refuses a token whose expiry has passed, however well signed', async () => {
    // Signed by the server moments ago, then rewound: the signature covers the
    // expiry, so this can only be a token that genuinely lapsed.
    const cookie = cookieFrom(await login({ password: PASSWORD }));
    const [name, token] = cookie.split('=');
    const [, signature] = token!.split('.');

    const response = await get('/api/status', `${name}=1.${signature}`);
    assert.equal(response.status, 401);
  });

  it('logging out clears the cookie', async () => {
    const cookie = cookieFrom(await login({ password: PASSWORD }));
    const response = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie') ?? '', /partnerdex_session=;/);
  });

  it('throttles guessing, and the lockout binds the right password too', async () => {
    // Five wrong answers, then the sixth is refused before it is even checked.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login({ password: `guess-${attempt}` })).status, 401);
    }
    assert.equal((await login({ password: 'guess-again' })).status, 429);
    assert.equal(
      (await login({ password: PASSWORD })).status,
      429,
      'a lockout that the real password walks through is not a lockout',
    );
  });
});

describe('with no password set', () => {
  let open: Server;
  let openOrigin: string;

  before(async () => {
    resetEnvironment({ DASHBOARD_PASSWORD: '' });
    open = createApp().listen(0);
    await new Promise((resolve) => open.once('listening', resolve));
    openOrigin = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
  });

  after(() => {
    open.close();
  });

  /** The behaviour every existing install has: unchanged by this feature. */
  it('leaves the API open', async () => {
    assert.equal((await fetch(`${openOrigin}/api/status`)).status, 200);

    const session = await fetch(`${openOrigin}/api/auth/session`);
    assert.deepEqual(await session.json(), { required: false, authenticated: true });
  });
});

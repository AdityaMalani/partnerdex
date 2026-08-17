import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb, type Db } from '../src/db/index.js';
import { getConfig } from '../src/config.js';
import { upsertAffiliate } from '../src/affiliates/store.js';
import { issueSetPasswordLink } from '../src/server/portalAuth.js';
import {
  buildSetPasswordEmail,
  emailDeliveryFor,
  recordEmailAttempt,
  resolveSender,
  sendSetPasswordEmail,
  SET_PASSWORD_EMAIL,
} from '../src/notifications/affiliateEmail.js';
import { buildMime, sendMail, type SmtpSettings } from '../src/notifications/email.js';
import { planOnboarding, runOnboarding } from '../src/notifications/onboarding.js';
import { resetEnvironment } from './helpers.js';

/**
 * The email delivery path, against a mail server that really speaks SMTP.
 *
 * The client here is hand-written over `node:net` rather than pulled in as a
 * dependency, which means the protocol itself is our code and has to be tested
 * as such: multi-line EHLO replies, both AUTH mechanisms, dot-stuffing, a
 * refused recipient, and a cleartext session that must be refused rather than
 * quietly used. The fake server below is deliberately literal — it answers with
 * real reply codes and captures what it was actually sent, so a test that passes
 * says the bytes were right, not that a mock was called.
 *
 * The other half of this file is the property the security review cares about:
 * a set-password token is a 24-hour account takeover, and it must appear in
 * exactly one place — the message handed to the relay. Not the log, not the
 * delivery ledger, not an error string. Those assertions search for the token as
 * a substring rather than checking a particular line, because the failure they
 * are guarding against is somebody adding a helpful debug line later.
 */

/* ------------------------------------------------------------ fake server */

interface Captured {
  ehlo: string[];
  authMechanism: string | null;
  authUser: string | null;
  authPassword: string | null;
  mailFrom: string | null;
  rcptTo: string[];
  data: string | null;
}

interface FakeOptions {
  /** Advertise AUTH with these mechanisms. Empty means no AUTH line at all. */
  auth?: string[];
  advertiseStartTls?: boolean;
  /** Addresses the server refuses with a permanent 550. */
  rejectRecipients?: string[];
}

class FakeSmtpServer {
  readonly sessions: Captured[] = [];
  private server: net.Server;

  constructor(private options: FakeOptions = {}) {
    this.server = net.createServer((socket) => this.serve(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  close(): void {
    this.server.close();
  }

  /** The most recent conversation, which is what every test asserts on. */
  get last(): Captured {
    const session = this.sessions[this.sessions.length - 1];
    assert.ok(session, 'the fake server was never connected to');
    return session;
  }

  private serve(socket: net.Socket): void {
    const captured: Captured = {
      ehlo: [],
      authMechanism: null,
      authUser: null,
      authPassword: null,
      mailFrom: null,
      rcptTo: [],
      data: null,
    };
    this.sessions.push(captured);

    let buffer = '';
    let inData = false;
    let body = '';
    // 'user' then 'password': AUTH LOGIN is three round trips and the server has
    // to remember which of the two base64 blobs it is looking at.
    let loginStep: 'user' | 'password' | null = null;

    const say = (line: string): void => void socket.write(`${line}\r\n`);
    const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');

    socket.setEncoding('utf8');
    say('220 fake.test ESMTP ready');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);

        if (inData) {
          if (line === '.') {
            inData = false;
            captured.data = body;
            say('250 2.0.0 Ok: queued as FAKE1');
          } else {
            // Undo the client's dot-stuffing, which is the only transformation
            // the DATA phase applies.
            body += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          at = buffer.indexOf('\n');
          continue;
        }

        if (loginStep === 'user') {
          captured.authUser = decode(line);
          loginStep = 'password';
          say('334 UGFzc3dvcmQ6');
        } else if (loginStep === 'password') {
          captured.authPassword = decode(line);
          loginStep = null;
          say('235 2.7.0 Authentication successful');
        } else {
          this.handle(line, captured, say, {
            startData: () => {
              inData = true;
              body = '';
            },
            startLogin: () => {
              loginStep = 'user';
            },
            end: () => socket.end(),
          });
        }

        at = buffer.indexOf('\n');
      }
    });

    socket.on('error', () => undefined);
  }

  private handle(
    line: string,
    captured: Captured,
    say: (line: string) => void,
    control: { startData: () => void; startLogin: () => void; end: () => void },
  ): void {
    const verb = line.split(' ')[0]?.toUpperCase() ?? '';

    if (verb === 'EHLO' || verb === 'HELO') {
      captured.ehlo.push(line.slice(verb.length).trim());
      const caps: string[] = ['SIZE 10240000'];
      if (this.options.advertiseStartTls) caps.push('STARTTLS');
      if (this.options.auth && this.options.auth.length > 0) {
        caps.push(`AUTH ${this.options.auth.join(' ')}`);
      }
      say('250-fake.test greets you');
      for (const cap of caps.slice(0, -1)) say(`250-${cap}`);
      say(`250 ${caps[caps.length - 1]}`);
      return;
    }

    if (verb === 'AUTH') {
      const [, mechanism = '', payload] = line.split(' ');
      captured.authMechanism = mechanism.toUpperCase();
      if (captured.authMechanism === 'PLAIN') {
        const parts = Buffer.from(payload ?? '', 'base64').toString('utf8').split('\0');
        captured.authUser = parts[1] ?? null;
        captured.authPassword = parts[2] ?? null;
        say('235 2.7.0 Authentication successful');
        return;
      }
      if (captured.authMechanism === 'LOGIN') {
        control.startLogin();
        say('334 VXNlcm5hbWU6');
        return;
      }
      say('504 5.5.4 Unrecognized authentication type');
      return;
    }

    if (verb === 'MAIL') {
      captured.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? null;
      say('250 2.1.0 Ok');
      return;
    }

    if (verb === 'RCPT') {
      const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
      if (this.options.rejectRecipients?.includes(address)) {
        say('550 5.1.1 No such user here');
        return;
      }
      captured.rcptTo.push(address);
      say('250 2.1.5 Ok');
      return;
    }

    if (verb === 'DATA') {
      control.startData();
      say('354 End data with <CR><LF>.<CR><LF>');
      return;
    }

    if (verb === 'QUIT') {
      say('221 2.0.0 Bye');
      control.end();
      return;
    }

    say('500 5.5.2 Command unrecognized');
  }
}

/* ------------------------------------------------------------- test setup */

const FROM = 'Acme Partners <partners@example.test>';
const PORTAL = 'https://partners.example.test';

function settingsFor(port: number, overrides: Partial<SmtpSettings> = {}): SmtpSettings {
  return {
    host: '127.0.0.1',
    port,
    user: 'relay-user',
    password: 'relay-password',
    from: FROM,
    fromAddress: 'partners@example.test',
    implicitTls: false,
    // The fake server speaks no TLS, so every test that reaches AUTH has to say
    // out loud that it accepts a cleartext hop. That is the point: the client
    // refuses by default, and one test below pins that refusal.
    allowInsecure: true,
    ...overrides,
  };
}

/**
 * The mail variables, cleared before every fixture.
 *
 * `resetEnvironment` writes into the real `process.env` and only overwrites the
 * keys it is given, so a test that switches the mailer on would otherwise leave
 * it on for every test after it — and the whole point of half this file is what
 * happens when it is *off*. Clearing the set explicitly is the only way a test
 * here means what it says.
 */
const MAIL_VARS = [
  'EMAIL_ENABLED',
  'EMAIL_SEND_SPACING_MS',
  'PORTAL_BASE_URL',
  'SMTP_ALLOW_INSECURE',
  'SMTP_FROM',
  'SMTP_HOST',
  'SMTP_IMPLICIT_TLS',
  'SMTP_PASSWORD',
  'SMTP_PORT',
  'SMTP_USER',
];

function env(overrides: Record<string, string> = {}): void {
  for (const name of MAIL_VARS) delete process.env[name];
  resetEnvironment(overrides);
}

/** Env for a working, configured mailer pointed at the fake server. */
function mailEnv(port: number, overrides: Record<string, string> = {}): void {
  env({
    PORTAL_BASE_URL: PORTAL,
    EMAIL_ENABLED: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_USER: 'relay-user',
    SMTP_PASSWORD: 'relay-password',
    SMTP_FROM: FROM,
    SMTP_ALLOW_INSECURE: 'true',
    // No spacing between sends: the rate limit is real behaviour, not something
    // the suite should wait out.
    EMAIL_SEND_SPACING_MS: '0',
    ...overrides,
  });
}

/** Everything written to stdout/stderr while `run` executes. */
async function captureLogs(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join('\n');
}

/** Pull the two body parts back out of the MIME the server received. */
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers = '', ...rest] = raw.split('\r\n\r\n');
  const boundary = /boundary="([^"]+)"/.exec(headers)?.[1];
  assert.ok(boundary, 'the message declared no multipart boundary');

  const sections = rest.join('\r\n\r\n').split(`--${boundary}`);
  const decoded = sections
    .filter((section) => section.includes('Content-Type:'))
    .map((section) => {
      const [head = '', ...body] = section.split('\r\n\r\n');
      return {
        type: /Content-Type:\s*([^;]+)/.exec(head)?.[1]?.trim() ?? '',
        body: Buffer.from(body.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8'),
      };
    });

  return {
    headers,
    text: decoded.find((part) => part.type === 'text/plain')?.body ?? '',
    html: decoded.find((part) => part.type === 'text/html')?.body ?? '',
  };
}

/* -------------------------------------------------------- the SMTP client */

describe('the SMTP client', () => {
  let server: FakeSmtpServer;
  let port = 0;

  before(async () => {
    server = new FakeSmtpServer({ auth: ['PLAIN', 'LOGIN'] });
    port = await server.listen();
  });
  after(() => server.close());

  it('completes a full session and delivers the message', async () => {
    const result = await sendMail(settingsFor(port), {
      to: 'partner@example.org',
      toName: 'Ada Lovelace',
      subject: 'Set your password',
      text: 'plain body',
      html: '<p>html body</p>',
    });

    assert.equal(result.error, null);
    assert.equal(result.ok, true);

    const session = server.last;
    assert.deepEqual(session.ehlo, ['example.test']);
    assert.equal(session.mailFrom, 'partners@example.test');
    assert.deepEqual(session.rcptTo, ['partner@example.org']);

    const { headers, text, html } = partsOf(session.data ?? '');
    assert.match(headers, /^From: Acme Partners <partners@example\.test>$/m);
    assert.match(headers, /^To: "Ada Lovelace" <partner@example\.org>$/m);
    assert.match(headers, /^Subject: Set your password$/m);
    assert.match(headers, /^Message-ID: <[^>]+@example\.test>$/m);
    assert.match(headers, /^Content-Type: multipart\/alternative/m);
    assert.equal(text, 'plain body');
    assert.equal(html, '<p>html body</p>');
  });

  it('prefers AUTH PLAIN and sends the right credentials', async () => {
    await sendMail(settingsFor(port), {
      to: 'partner@example.org',
      subject: 'x',
      text: 'x',
      html: 'x',
    });
    assert.equal(server.last.authMechanism, 'PLAIN');
    assert.equal(server.last.authUser, 'relay-user');
    assert.equal(server.last.authPassword, 'relay-password');
  });

  /**
   * A body line of "." is what ends the DATA phase, so an unstuffed one would
   * truncate the message and leave the rest to be read as SMTP commands. Base64
   * bodies cannot produce one today, which is exactly why this is pinned: the
   * framing must not silently depend on the encoding.
   */
  it('dot-stuffs the payload', async () => {
    const body = 'first line\n.\nafter the dot';
    await sendMail(settingsFor(port), {
      to: 'partner@example.org',
      subject: 'x',
      text: body,
      html: 'x',
    });
    assert.equal(partsOf(server.last.data ?? '').text, body);
  });

  it('reports a refused recipient as a permanent failure rather than throwing', async () => {
    const refusing = new FakeSmtpServer({
      auth: ['PLAIN'],
      rejectRecipients: ['nobody@example.org'],
    });
    const refusingPort = await refusing.listen();
    try {
      const result = await sendMail(settingsFor(refusingPort), {
        to: 'nobody@example.org',
        subject: 'x',
        text: 'x',
        html: 'x',
      });
      assert.equal(result.ok, false);
      assert.equal(result.permanent, true);
      assert.match(result.error ?? '', /550/);
    } finally {
      refusing.close();
    }
  });

  it('refuses to authenticate over a cleartext hop unless told to', async () => {
    const result = await sendMail(settingsFor(port, { allowInsecure: false }), {
      to: 'partner@example.org',
      subject: 'x',
      text: 'x',
      html: 'x',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /STARTTLS/);
    // The credential must not have been offered before the refusal.
    assert.equal(server.last.authMechanism, null);
    assert.equal(server.last.authPassword, null);
  });

  it('reports an unreachable server as transient', async () => {
    // Port 1 on the loopback: nothing listens, and nothing is allowed to.
    const result = await sendMail(settingsFor(1), {
      to: 'partner@example.org',
      subject: 'x',
      text: 'x',
      html: 'x',
    });
    assert.equal(result.ok, false);
    assert.equal(result.permanent, false);
  });
});

/* ------------------------------------------------------ choosing a sender */

describe('choosing a sender', () => {
  it('is the no-op sender when nothing is configured', () => {
    env();
    const sender = resolveSender();
    assert.equal(sender.kind, 'noop');
    assert.match(sender.kind === 'noop' ? sender.reason : '', /EMAIL_ENABLED/);
  });

  it('is the no-op sender when SMTP is on but the portal has no origin', () => {
    mailEnv(25, { PORTAL_BASE_URL: '' });
    const sender = resolveSender();
    assert.equal(sender.kind, 'noop');
    assert.match(sender.kind === 'noop' ? sender.reason : '', /PORTAL_BASE_URL/);
  });

  it('is SMTP once host, from and portal origin are all set', () => {
    mailEnv(2525);
    const sender = resolveSender();
    assert.equal(sender.kind, 'smtp');
    assert.equal(sender.kind === 'smtp' ? sender.settings.fromAddress : '', 'partners@example.test');
  });

  it('refuses to start half-configured rather than pretending to send', () => {
    // The toggle on with no host is the one shape that crashes: every other
    // absence means "off", and off is a complete state.
    env({ EMAIL_ENABLED: 'true' });
    assert.throws(() => getConfig(), /SMTP_HOST/);

    env({ EMAIL_ENABLED: 'true', SMTP_HOST: 'relay.example', SMTP_FROM: 'not-an-address' });
    assert.throws(() => getConfig(), /SMTP_FROM/);

    env();
  });
});

/* ------------------------------------------------------- delivery records */

describe('delivery records', () => {
  let db: Db;
  let alice = '';

  beforeEach(() => {
    env();
    db = getDb();
    alice = upsertAffiliate({ name: 'Alice', email: 'alice@example.org' }, db);
  });

  it('records one row per affiliate and message, however many attempts', () => {
    recordEmailAttempt(db, { affiliateId: alice, email: 'alice@example.org', ok: true });
    recordEmailAttempt(db, { affiliateId: alice, email: 'alice@example.org', ok: true });

    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_email_deliveries WHERE affiliate_id = ?')
      .get(alice) as { n: number };
    assert.equal(rows.n, 1);

    const delivery = emailDeliveryFor(db, alice);
    assert.equal(delivery?.attempts, 2);
    assert.equal(delivery?.ok, true);
    assert.equal(delivery?.kind, SET_PASSWORD_EMAIL);
  });

  /**
   * A delivery that happened cannot un-happen. If a later attempt fails — a
   * retry that should never have been made, a mailbox that has since closed —
   * the row must still say this person was emailed, because that flag is what
   * stops a resumed run from mailing them a second time.
   */
  it('never downgrades a success to a failure', () => {
    recordEmailAttempt(db, { affiliateId: alice, email: 'alice@example.org', ok: true });
    recordEmailAttempt(db, {
      affiliateId: alice,
      email: 'alice@example.org',
      ok: false,
      error: 'mailbox full',
    });

    const delivery = emailDeliveryFor(db, alice);
    assert.equal(delivery?.ok, true);
    assert.ok(delivery?.deliveredAt);
    assert.equal(delivery?.error, 'mailbox full');
  });

  it('leaves a failed attempt retryable', () => {
    recordEmailAttempt(db, {
      affiliateId: alice,
      email: 'alice@example.org',
      ok: false,
      error: 'connection refused',
    });
    const delivery = emailDeliveryFor(db, alice);
    assert.equal(delivery?.ok, false);
    assert.equal(delivery?.deliveredAt, null);
    assert.deepEqual(planOnboarding(db).recipients.map((r) => r.affiliateId), [alice]);
  });
});

/* ------------------------------------------------------------- the secret */

describe('the set-password token', () => {
  let server: FakeSmtpServer;
  let port = 0;

  before(async () => {
    server = new FakeSmtpServer({ auth: ['PLAIN'] });
    port = await server.listen();
  });
  after(() => server.close());

  /**
   * The finding this whole workstream was warned about, restated as a test.
   *
   * A set-password link is a 24-hour account takeover for one of our partners.
   * The review found them being written to stdout, where `fly logs` publishes
   * them. Adding a mailer multiplies the number of places a link passes through,
   * so the assertion is deliberately blunt: after a real send, the token appears
   * in the message and nowhere else this process wrote.
   */
  it('reaches the message and neither the log nor the ledger', async () => {
    mailEnv(port);
    const db = getDb();
    const id = upsertAffiliate({ name: 'Grace Hopper', email: 'grace@example.org' }, db);

    const link = issueSetPasswordLink(db, id);
    assert.ok(link);
    // The secret half only — the affiliate id in front of it is not a secret,
    // and searching for the whole URL would pass on a log line that leaked the
    // token alone.
    const secret = link.url.split('/').pop()!.split('.').slice(1).join('.');
    assert.ok(secret.length > 20);

    const logs = await captureLogs(async () => {
      const outcome = await sendSetPasswordEmail(db, link);
      assert.equal(outcome.error, null);
      assert.equal(outcome.ok, true);
    });

    assert.ok(partsOf(server.last.data ?? '').text.includes(link.url));
    assert.equal(logs.includes(secret), false, 'the token was written to the log');

    const row = db
      .prepare('SELECT * FROM affiliate_email_deliveries WHERE affiliate_id = ?')
      .get(id) as Record<string, unknown>;
    assert.equal(JSON.stringify(row).includes(secret), false, 'the token was written to the ledger');
    assert.equal(row.ok, 1);
    assert.equal(row.email, 'grace@example.org');
  });

  it('is not logged by the no-op sender either', async () => {
    env({ PORTAL_BASE_URL: PORTAL });
    const db = getDb();
    const id = upsertAffiliate({ name: 'Grace Hopper', email: 'grace@example.org' }, db);
    const link = issueSetPasswordLink(db, id)!;
    const secret = link.url.split('/').pop()!.split('.').slice(1).join('.');

    const logs = await captureLogs(async () => {
      const outcome = await sendSetPasswordEmail(db, link);
      assert.equal(outcome.attempted, false);
      // Nothing was attempted, so nothing is recorded: a no-op must not leave a
      // ledger row that a later run reads as "already emailed".
      assert.equal(emailDeliveryFor(db, id), null);
      console.warn(`[test] ${outcome.error}`);
    });
    assert.equal(logs.includes(secret), false);
  });
});

/* --------------------------------------------------------- the bulk send */

describe('the bulk onboarding send', () => {
  let server: FakeSmtpServer;
  let port = 0;

  before(async () => {
    server = new FakeSmtpServer({ auth: ['PLAIN'], rejectRecipients: ['bob@example.org'] });
    port = await server.listen();
  });
  after(() => server.close());

  /**
   * Explicit creation dates, because the batch is ordered by them and a tie is
   * broken by a random uuid. Without these the "first" recipient of a capped run
   * is whichever id sorted lowest, which is a different person on every run.
   */
  function seedAffiliates(db: Db): Record<string, string> {
    return {
      alice: upsertAffiliate(
        { name: 'Alice', email: 'alice@example.org', createdAt: '2025-01-01T00:00:00Z' },
        db,
      ),
      bob: upsertAffiliate(
        { name: 'Bob', email: 'bob@example.org', createdAt: '2025-01-02T00:00:00Z' },
        db,
      ),
      carol: upsertAffiliate(
        { name: 'Carol', email: 'carol@example.org', createdAt: '2025-01-03T00:00:00Z' },
        db,
      ),
    };
  }

  /**
   * The whole-population property, at three. One address the relay refuses must
   * cost that one person and nobody else — a run that stops at the first 550 is
   * a run somebody has to restart by hand with a list they do not have.
   */
  it('carries on past a recipient the relay refuses', async () => {
    mailEnv(port);
    const db = getDb();
    const ids = seedAffiliates(db);

    const summary = await runOnboarding(db);

    assert.equal(summary.planned, 3);
    assert.equal(summary.sent, 2);
    assert.equal(summary.failed, 1);
    assert.deepEqual(
      summary.failures.map((failure) => failure.email),
      ['bob@example.org'],
    );
    assert.equal(summary.failures[0]?.permanent, true);

    assert.equal(emailDeliveryFor(db, ids.alice!)?.ok, true);
    assert.equal(emailDeliveryFor(db, ids.bob!)?.ok, false);
    assert.equal(emailDeliveryFor(db, ids.carol!)?.ok, true);
  });

  /** The resume: a second run is the remainder, not the whole batch again. */
  it('is resumable and does not email the same person twice', async () => {
    mailEnv(port);
    const db = getDb();
    seedAffiliates(db);

    await runOnboarding(db, { limit: 1 });
    const second = await runOnboarding(db);

    // Alice went out in the first pass and is not in the second.
    assert.equal(second.skipped.alreadyEmailed, 1);
    assert.equal(second.planned, 2);
    assert.deepEqual(
      planOnboarding(db).recipients.map((r) => r.email),
      // Bob's send was refused, so he is still owed one; Carol succeeded.
      ['bob@example.org'],
    );
  });

  it('reports a dry run without minting a token or opening a socket', async () => {
    mailEnv(port);
    const db = getDb();
    const ids = seedAffiliates(db);
    const before = server.sessions.length;

    const summary = await runOnboarding(db, { dryRun: true });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.planned, 3);
    assert.equal(summary.sent, 0);
    assert.equal(server.sessions.length, before);
    assert.equal(emailDeliveryFor(db, ids.alice!), null);
    // No token was minted either: a dry run that spent everyone's outstanding
    // link would invalidate any invite already in flight.
    const credentials = db
      .prepare('SELECT COUNT(*) AS n FROM affiliate_credentials')
      .get() as { n: number };
    assert.equal(credentials.n, 0);
  });

  it('refuses to run at all when no sender is configured', async () => {
    env({ PORTAL_BASE_URL: PORTAL });
    const db = getDb();
    const ids = seedAffiliates(db);

    await assert.rejects(() => runOnboarding(db), /no mail sender configured/);
    // And nothing was recorded, so a later configured run still owes everyone.
    assert.equal(emailDeliveryFor(db, ids.alice!), null);
  });

  it('skips affiliates who already have a password', async () => {
    mailEnv(port);
    const db = getDb();
    const ids = seedAffiliates(db);
    db.prepare(
      `INSERT INTO affiliate_credentials
         (affiliate_id, password_hash, password_salt, password_set_at, created_at, updated_at)
       VALUES (?, 'hash', 'salt', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(ids.alice);

    const plan = planOnboarding(db);
    assert.deepEqual(plan.alreadyOnboarded.map((c) => c.email), ['alice@example.org']);
    assert.equal(plan.recipients.some((c) => c.affiliateId === ids.alice), false);
  });

  /**
   * The shared inbox. Two real accounts in the import share one address, each
   * with its own handle and its own referrals, and email login resolves the
   * address to the older of them. Mailing both would put two links to two
   * different accounts in one inbox and let a click order decide which balance
   * that person sees. There is no automatic answer, so both are held back and
   * both are named.
   */
  it('holds back an address that two accounts share, and reports both', async () => {
    mailEnv(port);
    const db = getDb();
    const older = upsertAffiliate(
      { name: 'Dana Example', email: 'dana@example.org', createdAt: '2025-03-11T00:00:00Z' },
      db,
    );
    const newer = upsertAffiliate(
      { name: 'Dana Example', email: 'Dana@Example.org', createdAt: '2026-04-13T00:00:00Z' },
      db,
    );
    const solo = upsertAffiliate({ name: 'Alice', email: 'alice@example.org' }, db);

    const summary = await runOnboarding(db);

    assert.equal(summary.skipped.sharedAddresses, 2);
    assert.equal(summary.sharedAddresses.length, 1);
    assert.equal(summary.sharedAddresses[0]?.email, 'dana@example.org');
    assert.deepEqual(
      summary.sharedAddresses[0]?.affiliates.map((a) => a.affiliateId).sort(),
      [older, newer].sort(),
    );
    // The one unshared affiliate still went out: a held-back pair is not a
    // reason to stall the others.
    assert.equal(summary.sent, 1);
    assert.equal(emailDeliveryFor(db, solo)?.ok, true);
    assert.equal(emailDeliveryFor(db, older), null);
    assert.equal(emailDeliveryFor(db, newer), null);
  });

  /** Naming an id is a human making the decision the report asked for. */
  it('sends to a shared address when the account is named explicitly', async () => {
    mailEnv(port);
    const db = getDb();
    const older = upsertAffiliate(
      { name: 'Dana Example', email: 'dana@example.org', createdAt: '2025-03-11T00:00:00Z' },
      db,
    );
    upsertAffiliate(
      { name: 'Dana Example', email: 'dana@example.org', createdAt: '2026-04-13T00:00:00Z' },
      db,
    );

    const summary = await runOnboarding(db, { affiliateIds: [older] });
    assert.equal(summary.sent, 1);
    assert.equal(emailDeliveryFor(db, older)?.ok, true);
  });

  it('holds back an affiliate with no usable address', async () => {
    mailEnv(port);
    const db = getDb();
    upsertAffiliate({ name: 'No Address', email: '' }, db);
    const plan = planOnboarding(db);
    assert.equal(plan.unreachable.length, 1);
    assert.equal(plan.recipients.length, 0);
  });
});

/* ------------------------------------------------------------ the message */

describe('the message', () => {
  before(() => mailEnv(2525));

  const link = {
    affiliateId: 'a1',
    name: 'Dana Example',
    email: 'dana@example.org',
    url: `${PORTAL}/portal#/set-password/a1.secret-token-value`,
    expiresAt: '2026-08-14T09:00:00.000Z',
  };

  it('reads as continuity and says the four things it has to', () => {
    const message = buildSetPasswordEmail(link, 'Acme Partners');

    assert.match(message.subject, /Acme Partners/);
    // Who it is from, in the body as well as the header.
    assert.match(message.text, /Acme Partners/);
    // Why they are getting it, and that it is not a new signup.
    assert.match(message.text, /already one of our affiliates/);
    assert.match(message.text, /not a new signup/);
    // That their links and earnings are untouched.
    assert.match(message.text, /referral links keep working/);
    assert.match(message.text, /earned so far have carried over/);
    // And the 24-hour life of the link.
    assert.match(message.text, /24 hours/);
    assert.ok(message.text.includes(link.url));
  });

  it('has both parts and nothing that tracks anyone', () => {
    const message = buildSetPasswordEmail(link, 'Acme Partners');
    assert.ok(message.text.length > 0);
    assert.match(message.html, /^<div /);
    assert.ok(message.html.includes(`href="${link.url}"`));
    // No remote asset of any kind: an image is a read receipt whatever it is a
    // picture of, and these are transactional messages to people who did not
    // ask to be measured.
    assert.equal(/<img|background:url|<iframe|<script/i.test(message.html), false);
  });

  /**
   * An affiliate's name is imported data we did not write, and it goes straight
   * into a header. A bare CRLF in one would end that header and let the rest be
   * read as headers of its own — which is how a transactional mailer becomes an
   * open relay, one `Bcc:` at a time.
   */
  it('cannot have a header injected through an affiliate name', () => {
    const message = buildSetPasswordEmail(
      { ...link, name: 'Eve\r\nBcc: attacker@example.net' },
      'Acme Partners',
    );
    const mime = buildMime(FROM, 'partners@example.test', message);
    assert.equal(/^Bcc:/m.test(mime), false);
    assert.equal(mime.includes('attacker@example.net\r\n'), false);
  });
});

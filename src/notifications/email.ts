import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

/**
 * A small SMTP client, written out rather than installed.
 *
 * This project has four runtime dependencies and each one is a deliberate,
 * argued-for exception; `nodemailer` and its transitive tree would have been the
 * fifth, for a job this file does in a few hundred lines. That trade is only
 * defensible because of how narrow the job is, and the narrowness is the design:
 *
 *   - **One recipient per message.** No CC, no BCC, no per-domain fan-out, no
 *     connection pooling. The whole system sends short transactional notes to
 *     one partner at a time.
 *   - **One body shape.** `multipart/alternative` with a text and an HTML part,
 *     both base64, both UTF-8. Base64 rather than quoted-printable because it
 *     makes the 998-octet line limit and 8-bit-vs-7-bit unrepresentable rather
 *     than merely handled — no input can produce a line we have to think about.
 *   - **Submission, not delivery.** This speaks to a relay that has agreed to
 *     carry our mail. It does not do MX lookup, DKIM signing, bounce parsing or
 *     retry scheduling; the relay does those, which is what a relay is for.
 *
 * What it does *not* skimp on is the transport security, because that is the
 * part where cutting a corner is a credential on the wire: STARTTLS is taken
 * whenever the server offers it, an implicit-TLS port is supported, and a plain
 * unencrypted session is refused outright unless an operator has explicitly said
 * the hop is trusted (see `allowInsecure`). AUTH never happens on a cleartext
 * channel by accident.
 *
 * Nothing here logs. Not the credentials, not the recipient, and above all not
 * the body — this transport carries account-takeover links, and a debug line
 * with a payload in it would reintroduce exactly the finding that made this
 * whole workstream necessary. Errors carry SMTP reply codes and the server's own
 * text, never anything of ours — and since the availability/secrets review that
 * invariant is enforced rather than asserted, because a relay echoing our
 * command back made "the server's own text" a container for our credential.
 * See `replyDetail`.
 */

/** Long enough for a slow relay's greeting, short enough to fail a run visibly. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Guard against a hostile or broken peer streaming an unbounded reply at us. */
const MAX_REPLY_BYTES = 64 * 1024;

export interface SmtpSettings {
  host: string;
  port: number;
  /** Blank means an unauthenticated relay, which is normal on a local hop. */
  user: string;
  password: string;
  /** The envelope sender, bare — no display name, no angle brackets. */
  fromAddress: string;
  /** The `From:` header as written, which may carry a display name. */
  from: string;
  /** TLS from the first byte (port 465) rather than negotiated with STARTTLS. */
  implicitTls: boolean;
  /**
   * Permit a session that never reaches TLS.
   *
   * Off by default and it should stay off anywhere the relay is not on the same
   * host: without it the password is sent in the clear and so is every link this
   * transport exists to carry. It is here for a localhost relay and for tests.
   */
  allowInsecure: boolean;
}

export interface EmailMessage {
  /** Bare address. Display name rides separately so it can be encoded. */
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  ok: boolean;
  /**
   * True when the same message offered again would fail the same way — a
   * rejected recipient, a refused login, a message the relay will not accept.
   * A bulk run records these and moves on rather than retrying them forever.
   */
  permanent: boolean;
  error: string | null;
}

/* --------------------------------------------------------------- the wire */

interface Reply {
  code: number;
  /** The text of each line, continuations included, in order. */
  lines: string[];
}

class SmtpError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/**
 * A framed SMTP conversation over whatever stream it is handed.
 *
 * The framing is the only subtle part of the protocol at this level: a reply is
 * one or more lines sharing a code, where continuations are `250-TEXT` and the
 * last line is `250 TEXT` — a hyphen versus a space in column four, and nothing
 * else distinguishes "there is more coming" from "your turn". Reading a reply as
 * a single line would work against most servers and then desynchronize the whole
 * session the first time one advertises its capabilities, which every one does.
 */
class SmtpConnection {
  private stream: Duplex;
  private buffer = '';
  private partial: string[] = [];
  private ready: Reply[] = [];
  private waiting: Array<{ resolve: (reply: Reply) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  constructor(stream: Duplex) {
    this.stream = stream;
    this.attach(stream);
  }

  private attach(stream: Duplex): void {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => this.onData(chunk));
    stream.on('error', (cause: Error) => this.fail(cause));
    // A close mid-conversation is an error to whoever is waiting on a reply, and
    // nothing at all to a session that has already sent QUIT.
    stream.on('close', () => this.fail(new Error('The mail server closed the connection.')));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this.fail(new Error('The mail server sent an implausibly long reply.'));
      return;
    }

    let breakAt = this.buffer.indexOf('\n');
    while (breakAt >= 0) {
      const line = this.buffer.slice(0, breakAt).replace(/\r$/, '');
      this.buffer = this.buffer.slice(breakAt + 1);
      this.onLine(line);
      breakAt = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    const code = Number(line.slice(0, 3));
    if (!Number.isInteger(code) || line.length < 3) {
      // Scrubbed for the same reason a reply is: this can fire mid-AUTH, and a
      // malformed line is exactly the shape a server echoing our command back
      // in some encoding of its own would take.
      this.fail(
        new Error(`The mail server sent a line that is not an SMTP reply: ${scrubSecrets(clip(line))}`),
      );
      return;
    }

    this.partial.push(line.slice(4));
    // Column four: '-' continues the reply, anything else (in practice a space,
    // or nothing at all on a bare three-digit line) ends it.
    if (line[3] === '-') return;

    const reply: Reply = { code, lines: this.partial };
    this.partial = [];

    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve(reply);
    else this.ready.push(reply);
  }

  private fail(cause: Error): void {
    if (this.failure) return;
    this.failure = cause;
    for (const waiter of this.waiting.splice(0)) waiter.reject(cause);
  }

  private read(): Promise<Reply> {
    const queued = this.ready.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  /**
   * Send a line and check the answer.
   *
   * `secret` marks the AUTH phase, and it now means two things rather than one.
   * It keeps our own command out of the error text, as it always did — and,
   * since the review, it also drops the *server's* reply text, which is where
   * the credential actually leaked: relays echo the offending command back, so
   * `501 Syntax error in "AUTH PLAIN AGFkbWluAHNlY3JldA=="` wrote our base64
   * password into the delivery ledger and the log. See `replyDetail`.
   *
   * `label` is what the error calls the exchange when the command itself cannot
   * be shown. Without it a secret command reads as "replied 535 to <redacted>",
   * which tells an operator nothing about which step failed.
   */
  async command(line: string, expect: number[], secret = false, label?: string): Promise<Reply> {
    this.stream.write(`${line}\r\n`);
    return this.expect(expect, label ?? (secret ? '<redacted>' : line), secret);
  }

  async expect(codes: number[], what: string, secret = false): Promise<Reply> {
    const reply = await this.read();
    if (codes.includes(reply.code)) return reply;
    throw new SmtpError(
      `The mail server replied ${reply.code} to ${what}${replyDetail(reply, secret)}`,
      // 5xx is a refusal; 4xx is "not now". Anything else here is a protocol
      // surprise, and surprises are worth retrying once rather than retiring.
      reply.code >= 500 && reply.code < 600,
    );
  }

  /** Raw write for the DATA payload, which is not a command and gets no reply. */
  write(payload: string): void {
    this.stream.write(payload);
  }

  /**
   * Swap the plaintext socket for a TLS one, in place.
   *
   * The buffer check before the handshake is not a formality. A server that has
   * already written bytes we have not read is a server whose post-STARTTLS
   * traffic we could confuse with pre-STARTTLS traffic — the shape of the old
   * command-injection flaw in this exchange. Anything buffered here means the
   * session is not what it appears to be, so it ends.
   */
  async startTls(host: string): Promise<void> {
    if (this.buffer.length > 0 || this.ready.length > 0 || this.partial.length > 0) {
      throw new SmtpError('The mail server spoke before the TLS handshake; refusing to continue.', true);
    }

    const plain = this.stream;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');

    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ socket: plain as net.Socket, servername: host }, () =>
        resolve(socket),
      );
      socket.once('error', reject);
    });

    this.stream = secure;
    this.attach(secure);
  }

  end(): void {
    this.stream.removeAllListeners('close');
    this.stream.end();
    this.stream.destroy();
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * What, if anything, of the server's own words is safe to keep.
 *
 * This file's stated invariant is that errors carry "SMTP reply codes and the
 * server's own text, never anything of ours". The review found the hole in it:
 * the redaction above hides *our command* from the message, but then copies
 * `reply.lines` in verbatim — and relays routinely echo the offending command
 * back. `501 Syntax error in "AUTH PLAIN AGFkbWluAHNlY3JldA=="` puts the base64
 * of our SMTP password into `SmtpError.message`, which becomes `SendResult.error`
 * and lands in `affiliate_email_deliveries.error`, in `console.warn`, and on an
 * operator's terminal. The redaction was cosmetic; the credential travelled in
 * the other half of the string.
 *
 * Two rules, in order of how much they matter:
 *
 *   1. **From the AUTH phase, nothing.** No allowlist, no scrub — the reply is
 *      dropped and only the numeric code survives. Everything an AUTH failure
 *      can usefully tell an operator is in that code (535 wrong credentials,
 *      534 mechanism refused, 454 temporary), and there is no scrub anyone can
 *      review with confidence against a server that is free to echo our bytes
 *      in any encoding it likes. This is the one place where "keep the
 *      diagnostics" is not worth the risk.
 *   2. **Everywhere else, scrub what looks like a secret.** Long base64-shaped
 *      runs and anything URL-shaped go, because the lower-confidence twin of
 *      the same finding is a content-filtering relay quoting matched body text
 *      — which for us means a live set-password link — back at us in a 550.
 *
 * The limit of rule 2, stated because it is easy to over-trust: it is a
 * heuristic over attacker-influenced text, not a proof. It cannot catch a
 * secret a relay chooses to re-encode. Rule 1 is the one that carries the
 * weight, and it is the only one that is absolute.
 */
function scrubSecrets(text: string): string {
  return (
    text
      // Anything URL-shaped: this transport carries account-takeover links.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted>')
      // A long unbroken base64/token-shaped run. 24 characters is comfortably
      // above ordinary English words and mail-server jargon, and below the
      // shortest credential or token this system produces.
      .replace(/[A-Za-z0-9+/_=-]{24,}/g, '<redacted>')
  );
}

function replyDetail(reply: Reply, secret: boolean): string {
  if (secret) return '';
  const scrubbed = scrubSecrets(clip(reply.lines.join(' ')));
  return scrubbed ? `: ${scrubbed}` : '';
}

/* ------------------------------------------------------------ the message */

/**
 * Strip anything that could start a new header line.
 *
 * Subject and display name reach here from the database, and an affiliate's name
 * is imported data we did not write. A bare CR or LF in one of them would end
 * the header and let the rest be read as headers of its own — a `Bcc:` in a
 * partner's name is a real, boring way to turn a transactional mailer into an
 * open relay. Folding whitespace to a space keeps the value readable rather than
 * silently truncating it.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047, but only when it is needed — ASCII stays readable on the wire. */
function encodeHeaderWord(value: string): string {
  const safe = headerSafe(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(safe)) return safe;
  return `=?utf-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

/** `Name <addr>`, with the name quoted or encoded as it needs. */
export function formatAddress(address: string, name?: string): string {
  const bare = headerSafe(address);
  if (!name) return bare;
  const encoded = encodeHeaderWord(name);
  // An encoded word is already atom-safe; a plain name may contain a comma or a
  // full stop, which have meaning in an address list unless it is quoted.
  const display = encoded.startsWith('=?') ? encoded : `"${encoded.replace(/["\\]/g, '')}"`;
  return `${display} <${bare}>`;
}

function base64Body(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let at = 0; at < encoded.length; at += 76) lines.push(encoded.slice(at, at + 76));
  return lines.join('\r\n');
}

/**
 * The RFC 5322 message, headers and both parts.
 *
 * `Date` and `Message-ID` are written by us rather than left to the relay
 * because a message without them is a spam signal at every large mailbox
 * provider, and a whole bulk run landing in spam is the same outcome as sending
 * none. The Message-ID's right-hand side is the sender's own domain, which is
 * the only domain we can honestly claim.
 */
export function buildMime(from: string, fromAddress: string, message: EmailMessage): string {
  const boundary = `--=_pdx_${crypto.randomBytes(16).toString('hex')}`;
  const domain = fromAddress.split('@')[1] ?? 'localhost';

  const headers = [
    `From: ${headerSafe(from)}`,
    `To: ${formatAddress(message.to, message.toName)}`,
    `Subject: ${encodeHeaderWord(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    // These are transactional and personal. Saying so is what keeps a partner's
    // provider from filing them with the newsletters, and it is also true.
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const part = (contentType: string, body: string): string =>
    [
      `--${boundary}`,
      `Content-Type: ${contentType}; charset=utf-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(body),
      '',
    ].join('\r\n');

  return [
    headers.join('\r\n'),
    '',
    // Text first: a multipart/alternative is ordered least to most preferred, so
    // this is what a plain-text reader shows and what the HTML part replaces.
    part('text/plain', message.text),
    part('text/html', message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * Dot-stuffing: a line that is exactly "." would otherwise end the DATA phase.
 *
 * Base64 bodies cannot produce one, and neither can our headers — but this
 * transport should not depend on the body encoding for its framing, because that
 * is the kind of coupling that breaks the day someone adds a third part.
 */
function stuff(payload: string): string {
  return payload.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

/* ---------------------------------------------------------------- sending */

function capabilities(reply: Reply): Set<string> {
  // EHLO's first line is the greeting, not a capability. The rest are
  // `KEYWORD [params]`, case-insensitively.
  return new Set(reply.lines.slice(1).map((line) => line.trim().toUpperCase()));
}

function supports(caps: Set<string>, keyword: string): boolean {
  for (const line of caps) {
    if (line === keyword || line.startsWith(`${keyword} `)) return true;
  }
  return false;
}

function authMechanisms(caps: Set<string>): Set<string> {
  for (const line of caps) {
    if (line === 'AUTH' || line.startsWith('AUTH ')) {
      return new Set(line.slice(4).trim().split(/\s+/).filter(Boolean));
    }
  }
  return new Set();
}

async function authenticate(
  connection: SmtpConnection,
  caps: Set<string>,
  settings: SmtpSettings,
): Promise<void> {
  if (!settings.user && !settings.password) return;

  const mechanisms = authMechanisms(caps);
  const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

  // PLAIN first: one round trip instead of three, and identical in strength —
  // both send the password base64-encoded, which is not encryption, which is why
  // neither runs before TLS.
  // Every command in this function is marked secret, including the bare
  // `AUTH LOGIN` that carries nothing of ours. The flag governs whether the
  // *server's* reply text is kept, and a server that is going to echo our
  // credential can do it in reply to any step of the exchange it likes. The
  // labels keep the error diagnostic without keeping the bytes.
  if (mechanisms.has('PLAIN') || mechanisms.size === 0) {
    await connection.command(
      `AUTH PLAIN ${b64(`\0${settings.user}\0${settings.password}`)}`,
      [235],
      true,
      'AUTH PLAIN',
    );
    return;
  }

  if (mechanisms.has('LOGIN')) {
    await connection.command('AUTH LOGIN', [334], true, 'AUTH LOGIN');
    await connection.command(b64(settings.user), [334], true, 'the AUTH LOGIN username');
    await connection.command(b64(settings.password), [235], true, 'the AUTH LOGIN password');
    return;
  }

  throw new SmtpError(
    `The mail server offers no login method this client speaks (it offers: ${
      [...mechanisms].join(', ') || 'none'
    }; this client speaks PLAIN and LOGIN).`,
    true,
  );
}

/**
 * The name this client gives in EHLO.
 *
 * A relay generally ignores it; the ones that do not want something that parses
 * as a domain. The sender's own domain is the honest answer and needs no config.
 */
function greetingName(fromAddress: string): string {
  const domain = fromAddress.split('@')[1];
  return domain && /^[a-z0-9.-]+$/i.test(domain) ? domain : 'localhost';
}

async function connect(settings: SmtpSettings): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = settings.implicitTls
      ? tls.connect({ host: settings.host, port: settings.port, servername: settings.host })
      : net.connect({ host: settings.host, port: settings.port });

    const onReady = (): void => {
      socket.setTimeout(COMMAND_TIMEOUT_MS);
      socket.off('error', reject);
      resolve(socket);
    };

    socket.setTimeout(COMMAND_TIMEOUT_MS, () => socket.destroy(new Error('The mail server timed out.')));
    socket.once('error', reject);
    socket.once(settings.implicitTls ? 'secureConnect' : 'connect', onReady);
  });
}

/**
 * Deliver one message. Never throws; the outcome is the return value.
 *
 * A caller in a bulk-recipient loop must not have to decide which exceptions
 * mean
 * "stop the run" — none of them do, and the way to make that unambiguous is for
 * this to have no exceptional exit at all.
 */
export async function sendMail(
  settings: SmtpSettings,
  message: EmailMessage,
): Promise<SendResult> {
  let connection: SmtpConnection | null = null;
  try {
    connection = new SmtpConnection(await connect(settings));

    await connection.expect([220], 'the connection');

    const name = greetingName(settings.fromAddress);
    let caps = capabilities(await connection.command(`EHLO ${name}`, [250]));

    let encrypted = settings.implicitTls;
    if (!encrypted && supports(caps, 'STARTTLS')) {
      await connection.command('STARTTLS', [220]);
      await connection.startTls(settings.host);
      // Capabilities are re-read deliberately: what a server advertises before
      // TLS is not binding, and AUTH in particular is commonly offered only
      // after the handshake. Trusting the first list would mean either missing
      // the login or trusting an attacker's version of it.
      caps = capabilities(await connection.command(`EHLO ${name}`, [250]));
      encrypted = true;
    }

    if (!encrypted && !settings.allowInsecure) {
      throw new SmtpError(
        `The mail server at ${settings.host}:${settings.port} does not offer STARTTLS, so the ` +
          `password and the set-password links would cross the network in the clear. Use the ` +
          `implicit-TLS port (usually 465), or set SMTP_ALLOW_INSECURE=true if the relay is on ` +
          `this machine.`,
        true,
      );
    }

    await authenticate(connection, caps, settings);

    await connection.command(`MAIL FROM:<${headerSafe(settings.fromAddress)}>`, [250]);
    await connection.command(`RCPT TO:<${headerSafe(message.to)}>`, [250, 251]);
    await connection.command('DATA', [354]);

    connection.write(stuff(buildMime(settings.from, settings.fromAddress, message)));
    connection.write('\r\n.\r\n');
    // The 250 here is the only acknowledgement that matters. Everything before
    // it is the relay agreeing to listen; this is it accepting responsibility.
    await connection.expect([250], 'the message');

    // Best effort, and deliberately not awaited for a reply: the message is
    // accepted, and a relay that hangs up rudely on QUIT has not unaccepted it.
    await connection.command('QUIT', [221]).catch(() => undefined);

    return { ok: true, permanent: false, error: null };
  } catch (cause) {
    if (cause instanceof SmtpError) {
      return { ok: false, permanent: cause.permanent, error: cause.message };
    }
    // DNS, TLS, refused connection, timeout: every one of them can be false five
    // minutes from now, so none of them retires a recipient.
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, permanent: false, error: `Could not reach the mail server: ${detail}` };
  } finally {
    connection?.end();
  }
}

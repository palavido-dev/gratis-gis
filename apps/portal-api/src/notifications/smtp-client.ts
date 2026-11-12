// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal SMTP client (#48). Replaces the nodemailer dependency
 * with a vendored, dependency-free implementation of the subset
 * of RFC 5321 / RFC 5322 we actually need: connect, EHLO,
 * STARTTLS (port 587), AUTH LOGIN, MAIL FROM, RCPT TO, DATA,
 * QUIT. One TCP connection per message (no pooling). Notifications
 * volume on a GratisGIS portal is low enough that the
 * connection-reuse savings nodemailer's pool offered don't move
 * the needle, and removing the dep saves ~450 KB + a couple of
 * transitive subdependency churns.
 *
 * If we ever need higher throughput, the right answer is an HTTP
 * provider plug-in (SendGrid / Postmark / SES API) rather than
 * SMTP pooling. The provider layer is additive and would slot in
 * alongside this client.
 *
 * Not implemented (intentionally):
 *   - PLAIN authentication (LOGIN covers every SMTP server we'd
 *     reasonably target; PLAIN is a one-line addition if needed)
 *   - 8BITMIME negotiation (we always emit UTF-8 with quoted-
 *     printable + Content-Transfer-Encoding: 8bit; modern relays
 *     handle that fine)
 *   - Pipelining (cosmetic; one extra RTT per message)
 *   - DKIM signing (handled upstream by the relay, not the
 *     submission client)
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { hasLineBreak } from './email-address.js';

export interface SmtpClientOptions {
  host: string;
  port: number;
  /** Implicit TLS on connect (port 465 convention). When false,
   *  the client uses plain TCP and upgrades to TLS via STARTTLS
   *  if the server advertises it. */
  secure: boolean;
  user?: string;
  password?: string;
  /** TCP / TLS connection timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /**
   * Send AUTH over a connection that is not encrypted. Off by default:
   * when the server does not offer STARTTLS (or something on the path
   * strips it) the password would cross the network readable. Only
   * for a trusted local relay.
   */
  allowPlaintextAuth?: boolean;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send a single message. Opens a fresh connection, runs the SMTP
 * handshake, sends the message, and closes the socket. Throws on
 * any protocol failure or non-2xx reply at a step that requires
 * 2xx. The caller's try/catch should surface the message to the
 * operator.
 */
export async function sendSmtpMail(
  opts: SmtpClientOptions,
  msg: SmtpMessage,
): Promise<void> {
  // From and To are written into command lines and headers as they
  // are. A CR or LF in either would start a new SMTP command or
  // header, so refuse before a socket is opened.
  if (hasLineBreak(msg.from) || hasLineBreak(msg.to)) {
    throw new Error('Refusing to send: an address contains a line break.');
  }
  const session = await openSession(opts);
  try {
    await runSession(session, opts, msg);
  } finally {
    session.destroy();
  }
}

interface Session {
  socket: Socket | TLSSocket;
  /** Promise-based reader that resolves to the next server reply. */
  readReply(): Promise<{ code: number; lines: string[] }>;
  write(line: string): Promise<void>;
  destroy(): void;
  /** Replace the underlying socket with a TLS-upgraded one. Used
   *  during STARTTLS so subsequent reads/writes go encrypted. */
  upgradeTls(): Promise<void>;
}

async function openSession(opts: SmtpClientOptions): Promise<Session> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Either implicit-TLS (port 465) or plain TCP. STARTTLS upgrade
  // happens later in the handshake when secure=false.
  const socket: Socket | TLSSocket = opts.secure
    ? await connectTls(opts.host, opts.port, timeoutMs)
    : await connectTcp(opts.host, opts.port, timeoutMs);
  return makeSession(socket, opts.host, timeoutMs);
}

function makeSession(
  initialSocket: Socket | TLSSocket,
  host: string,
  timeoutMs: number,
): Session {
  let socket: Socket | TLSSocket = initialSocket;
  // Buffer the raw bytes coming back from the server; the SMTP
  // reply format is line-oriented with continuation lines, so we
  // accumulate until we see a non-continuation line and then
  // hand the complete reply to whoever called readReply().
  let buffer = '';
  let waiters: Array<{
    resolve: (val: { code: number; lines: string[] }) => void;
    reject: (err: Error) => void;
  }> = [];
  let pendingReplies: Array<{ code: number; lines: string[] }> = [];
  let closed = false;
  let lastError: Error | null = null;

  function tryDrain(): void {
    // Try to peel off a complete reply from the buffer. SMTP
    // continuation lines have a hyphen between the code and the
    // text (e.g. `250-SIZE 10240000`); the final line uses a
    // space (`250 OK`). The protocol forbids partial replies so
    // we know once we hit the space-delimited line we're done.
    while (true) {
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) break;
      // Walk forward collecting continuation lines until we see
      // the terminator (space after code) or run out of buffer.
      let cursor = 0;
      const lines: string[] = [];
      let code = 0;
      let terminator = -1;
      while (cursor < buffer.length) {
        const nl = buffer.indexOf('\n', cursor);
        if (nl < 0) break;
        const raw = buffer.slice(cursor, nl).replace(/\r$/, '');
        const match = /^(\d{3})([- ])(.*)$/.exec(raw);
        if (!match) {
          // Malformed line; surface to the caller. The peer's text is
          // left out: the admin test endpoint returns this message,
          // and echoing it turned the test into a banner grabber for
          // any host and port.
          lastError = new Error('Malformed SMTP reply: the server is not an SMTP server');
          flushError(lastError);
          return;
        }
        code = parseInt(match[1]!, 10);
        lines.push(match[3]!);
        if (match[2] === ' ') {
          terminator = nl + 1;
          break;
        }
        cursor = nl + 1;
      }
      if (terminator < 0) break;
      pendingReplies.push({ code, lines });
      buffer = buffer.slice(terminator);
    }
    while (waiters.length > 0 && pendingReplies.length > 0) {
      const w = waiters.shift()!;
      w.resolve(pendingReplies.shift()!);
    }
  }

  function flushError(err: Error): void {
    const list = waiters;
    waiters = [];
    for (const w of list) w.reject(err);
  }

  function attachListeners(s: Socket | TLSSocket): void {
    s.setEncoding('utf8');
    s.setTimeout(timeoutMs);
    s.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString();
      tryDrain();
    });
    s.on('error', (err) => {
      lastError = err;
      flushError(err);
    });
    s.on('close', () => {
      closed = true;
      if (waiters.length > 0) {
        flushError(lastError ?? new Error('SMTP socket closed unexpectedly'));
      }
    });
    s.on('timeout', () => {
      const err = new Error(`SMTP timed out after ${timeoutMs}ms`);
      lastError = err;
      s.destroy(err);
    });
  }
  attachListeners(socket);

  return {
    get socket() {
      return socket;
    },
    readReply(): Promise<{ code: number; lines: string[] }> {
      if (pendingReplies.length > 0) {
        return Promise.resolve(pendingReplies.shift()!);
      }
      if (closed) {
        return Promise.reject(
          lastError ?? new Error('SMTP socket already closed'),
        );
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    write(line: string): Promise<void> {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(lastError ?? new Error('SMTP socket already closed'));
          return;
        }
        socket.write(`${line}\r\n`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    destroy(): void {
      try {
        socket.end();
      } catch {
        /* nothing to do */
      }
    },
    upgradeTls(): Promise<void> {
      return new Promise((resolve, reject) => {
        const tls = tlsConnect(
          { socket: socket as Socket, servername: host },
          () => {
            // Detach listeners from the old socket; the upgraded
            // socket inherits the underlying TCP stream but emits
            // its own data events.
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
            socket.removeAllListeners('timeout');
            socket = tls;
            buffer = '';
            pendingReplies = [];
            attachListeners(tls);
            resolve();
          },
        );
        tls.once('error', (err) => reject(err));
      });
    },
  };
}

async function runSession(
  s: Session,
  opts: SmtpClientOptions,
  msg: SmtpMessage,
): Promise<void> {
  // Greeting (220).
  await expectCode(s, [220]);

  // Initial EHLO. Advertise a non-FQDN identifier; SMTP servers
  // accept anything reasonable here for submission.
  await s.write(`EHLO gratisgis.local`);
  let caps = await expectCode(s, [250]);

  // STARTTLS upgrade when the server advertises it AND we
  // weren't already in implicit-TLS mode. Common on port 587.
  const advertisesStartTls = caps.lines.some(
    (l) => l.toUpperCase() === 'STARTTLS',
  );
  let encrypted = opts.secure;
  if (advertisesStartTls && !opts.secure) {
    encrypted = true;
    await s.write('STARTTLS');
    await expectCode(s, [220]);
    await s.upgradeTls();
    // Re-EHLO post-upgrade -- per RFC 3207, the server may
    // advertise different capabilities once TLS is established
    // (some servers gate AUTH on TLS).
    await s.write(`EHLO gratisgis.local`);
    caps = await expectCode(s, [250]);
  }

  // AUTH LOGIN when credentials were supplied. We don't enforce
  // it -- some local relays accept anonymous submission.
  if (opts.user && !encrypted && !opts.allowPlaintextAuth) {
    throw new Error(
      'The SMTP server did not offer STARTTLS, so the password was not sent. Use port 465 with TLS, or a server that supports STARTTLS.',
    );
  }
  if (opts.user) {
    await s.write('AUTH LOGIN');
    await expectCode(s, [334]);
    await s.write(Buffer.from(opts.user, 'utf8').toString('base64'));
    await expectCode(s, [334]);
    await s.write(
      Buffer.from(opts.password ?? '', 'utf8').toString('base64'),
    );
    await expectCode(s, [235]);
  }

  // Envelope. MAIL FROM uses the bare address (no display name)
  // per RFC 5321 even when the From: header carries a display
  // name. Same for RCPT TO.
  await s.write(`MAIL FROM:<${stripAngle(extractAddress(msg.from))}>`);
  await expectCode(s, [250]);
  await s.write(`RCPT TO:<${stripAngle(extractAddress(msg.to))}>`);
  await expectCode(s, [250, 251]);

  // DATA: send the MIME multipart/alternative body. Termination
  // is the bare-period sentinel; we dot-stuff any line in the
  // body that itself starts with a period (RFC 5321 4.5.2).
  await s.write('DATA');
  await expectCode(s, [354]);
  const body = buildMime(msg);
  await s.write(dotStuff(body));
  await s.write('.');
  await expectCode(s, [250]);

  await s.write('QUIT');
  try {
    await expectCode(s, [221]);
  } catch {
    // Some servers tear down before we get to read 221; treat
    // a missing 221 as a non-fatal warning.
  }
}

async function expectCode(
  s: Session,
  ok: number[],
): Promise<{ code: number; lines: string[] }> {
  const reply = await s.readReply();
  if (!ok.includes(reply.code)) {
    throw new Error(
      `SMTP server returned ${reply.code}: ${reply.lines.join(' / ')}`,
    );
  }
  return reply;
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', (err) => reject(err));
    socket.once('timeout', () =>
      reject(new Error(`SMTP TCP connect timed out after ${timeoutMs}ms`)),
    );
  });
}

function connectTls(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host });
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', (err) => reject(err));
    socket.once('timeout', () =>
      reject(new Error(`SMTP TLS connect timed out after ${timeoutMs}ms`)),
    );
  });
}

/**
 * Build a multipart/alternative MIME message with the plain-text
 * and HTML parts the caller supplied. The boundary is a fresh
 * random string so we don't risk colliding with anything in the
 * body content. Encoded as quoted-printable / 8bit; we don't try
 * to be clever about charset detection -- always UTF-8.
 */
function buildMime(msg: SmtpMessage): string {
  const boundary = `=_gratisgis_${randomBoundary()}`;
  const date = new Date().toUTCString();
  const messageId = `<${randomBoundary()}@gratisgis.local>`;
  const lines: string[] = [];
  lines.push(`From: ${msg.from}`);
  lines.push(`To: ${msg.to}`);
  lines.push(`Subject: ${encodeHeader(msg.subject)}`);
  lines.push(`Date: ${date}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  // SMTP requires CRLF line ends. The templates join lines with a bare
  // LF, which strict relays reject or rewrite.
  lines.push(crlf(msg.text));
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(crlf(msg.html));
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

/**
 * Encode a Subject header value when it contains non-ASCII
 * characters, per RFC 2047. ASCII-only values pass through
 * unchanged so the simple case stays readable in logs.
 */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * RFC 5321 4.5.2 dot-stuffing: any line in the message body that
 * starts with a period must have a leading period prepended so
 * the bare-period terminator isn't ambiguous with content.
 */
function dotStuff(body: string): string {
  return body.replace(/^\./gm, '..');
}

/**
 * Extract the bare email address from a `Name <addr@host>` or
 * plain `addr@host` value for use in MAIL FROM / RCPT TO.
 */
function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function extractAddress(value: string): string {
  // The last <...> group: a quoted display name may itself hold '<'.
  const angled = /<([^<>]+)>\s*$/.exec(value);
  if (angled && angled[1]) return angled[1].trim();
  return value.trim();
}

function stripAngle(value: string): string {
  return value.replace(/^</, '').replace(/>$/, '');
}

function randomBoundary(): string {
  // 12 random hex chars: enough entropy that a collision with
  // arbitrary message bytes is implausible. crypto.randomBytes
  // would be more rigorous but Math.random is fine here -- the
  // boundary doesn't need to be unguessable, just unique within
  // this message.
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

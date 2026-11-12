// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SMTP client against a scripted local server: no AUTH over a
// connection that never became TLS, CRLF line ends in DATA, a quoted
// From display name, and no echo of a non-SMTP peer's banner.

import { createServer, type Server, type Socket } from 'node:net';

import { formatFrom } from './email-transport.js';
import { sendSmtpMail } from './smtp-client.js';

type Script = (line: string, sock: Socket, state: { data: boolean; body: string }) => void;

function smtpServer(script: Script, greeting = '220 test ESMTP\r\n') {
  const received: string[] = [];
  const state = { data: false, body: '' };
  const server: Server = createServer((sock) => {
    sock.write(greeting);
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        received.push(line);
        script(line, sock, state);
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise<{ port: number; received: string[]; state: typeof state; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, received, state, close: () => server.close() });
    });
  });
}

const plainRelay: Script = (line, sock, state) => {
  if (state.data) {
    if (line === '.') {
      state.data = false;
      sock.write('250 queued\r\n');
    } else {
      state.body += line + '\r\n';
    }
    return;
  }
  if (line.startsWith('EHLO')) sock.write('250-test\r\n250 AUTH LOGIN\r\n');
  else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
  else if (line === 'DATA') {
    state.data = true;
    sock.write('354 go\r\n');
  } else if (line === 'QUIT') sock.end('221 bye\r\n');
  else sock.write('250 ok\r\n');
};

const msg = {
  from: formatFrom({ fromAddress: 'gis@example.org', fromDisplayName: 'City of Springfield, GIS' } as never),
  to: 'a@example.org',
  subject: 'Hi',
  text: 'line one\nline two',
  html: '<p>x</p>\n<p>y</p>',
};

describe('SMTP session', () => {
  it('does not send the password when the server offers no STARTTLS', async () => {
    const srv = await smtpServer(plainRelay);
    try {
      await expect(
        sendSmtpMail({ host: '127.0.0.1', port: srv.port, secure: false, user: 'u', password: 'secret' }, msg),
      ).rejects.toThrow(/did not offer STARTTLS/);
      expect(srv.received).not.toContain('AUTH LOGIN');
      expect(srv.received.join('\n')).not.toContain(Buffer.from('secret').toString('base64'));
    } finally {
      srv.close();
    }
  });

  it('sends CRLF line ends and a quoted From display name', async () => {
    const srv = await smtpServer(plainRelay);
    try {
      await sendSmtpMail({ host: '127.0.0.1', port: srv.port, secure: false }, msg);
      expect(srv.received).toContain('line one');
      expect(srv.received).toContain('line two');
      expect(srv.received).toContain('From: "City of Springfield, GIS" <gis@example.org>');
      expect(srv.received).toContain('MAIL FROM:<gis@example.org>');
    } finally {
      srv.close();
    }
  });

  it('does not echo the first line of a service that is not SMTP', async () => {
    const srv = await smtpServer(() => undefined, 'SSH-2.0-OpenSSH_9.6 secret-build\r\n');
    try {
      const err = await sendSmtpMail({ host: '127.0.0.1', port: srv.port, secure: false, timeoutMs: 2000 }, msg).catch(
        (e: unknown) => e as Error,
      );
      expect(String(err)).toMatch(/not an SMTP server/);
      expect(String(err)).not.toMatch(/OpenSSH/);
    } finally {
      srv.close();
    }
  });
});

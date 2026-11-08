// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The real node:http / node:https dial. The redirect-policy tests
 * use a fake transport. These hit a socket.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  _setSafeFetchTransportForTests,
  connectHost,
  pinnedRequest,
  safeFetch,
  UnsafeOutboundUrlError,
} from './net-guards.js';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(async () => ({ address: '203.0.113.10', family: 4 })),
}));

function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

describe('pinned HTTP dial', () => {
  afterEach(() => {
    _setSafeFetchTransportForTests(null);
  });

  it('returns status, headers, and body, and sends the original Host', async () => {
    const seen: string[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(String(req.headers.host));
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(201, { 'x-test': 'yes' });
        res.end(`got:${Buffer.concat(chunks).toString()}`);
      });
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/path?q=1`),
        { method: 'POST', body: 'hello' },
        '127.0.0.1',
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('x-test')).toBe('yes');
      await expect(res.text()).resolves.toBe('got:hello');
      expect(seen).toEqual([`tiles.example:${port}`]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('follows a same-host redirect and refuses a link-local Location', async () => {
    const server = createHttpServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/done' });
        res.end();
        return;
      }
      if (req.url === '/bad') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('done-body');
    });
    const port = await listen(server);
    _setSafeFetchTransportForTests((url, init) =>
      pinnedRequest(url, init, '127.0.0.1'),
    );
    try {
      const ok = await safeFetch(`http://tiles.example:${port}/start`);
      expect(ok.status).toBe(200);
      await expect(ok.text()).resolves.toBe('done-body');
      await expect(
        safeFetch(`http://tiles.example:${port}/bad`),
      ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('aborts a request that never answers', async () => {
    const server = createHttpServer(() => {
      /* hang */
    });
    const port = await listen(server);
    const signal = AbortSignal.timeout(200);
    try {
      await expect(
        pinnedRequest(new URL(`http://tiles.example:${port}/hang`), { signal }, '127.0.0.1'),
      ).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects a body over the size cap', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-length': '40' });
      res.end('x'.repeat(40));
    });
    const port = await listen(server);
    try {
      await expect(
        pinnedRequest(new URL(`http://tiles.example:${port}/big`), undefined, '127.0.0.1', {
          maxBytes: 16,
        }),
      ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('checks the certificate against the original name, not the dial address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gg-pin-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '1', '-nodes', '-subj', '/CN=pinned.example',
      '-addext', 'subjectAltName=DNS:pinned.example',
    ]);
    const pem = readFileSync(cert);
    const server = createHttpsServer({ key: readFileSync(key), cert: pem }, (_req, res) => {
      res.writeHead(200);
      res.end('tls-ok');
    });
    const port = await listen(server);
    try {
      const ok = await pinnedRequest(
        new URL(`https://pinned.example:${port}/`),
        undefined,
        '127.0.0.1',
        { ca: pem },
      );
      expect(ok.status).toBe(200);
      await expect(ok.text()).resolves.toBe('tls-ok');
      await expect(
        pinnedRequest(
          new URL(`https://wrong.example:${port}/`),
          undefined,
          '127.0.0.1',
          { ca: pem },
        ),
      ).rejects.toThrow(/altname|hostname|certificate/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('denied dial addresses', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1',
  ])('refuses %s', (address) => {
    expect(() => connectHost(address)).toThrow(UnsafeOutboundUrlError);
  });

  it('accepts a public address and a public IPv6 address', () => {
    expect(connectHost('203.0.113.10')).toBe('203.0.113.10');
    expect(connectHost('2001:db8::1')).toBe('2001:db8::1');
  });
});

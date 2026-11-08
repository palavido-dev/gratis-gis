// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The real node:http / node:https dial. The redirect-policy tests
 * use a fake transport. These hit a socket.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import {
  _setSafeFetchTransportForTests,
  connectHost,
  pinnedRequest,
  safeFetch,
  UnsafeOutboundUrlError,
  UnsupportedRequestBodyError,
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

  it('stops a chunked body and a decoded gzip bomb at the cap', async () => {
    const server = createHttpServer((_req, res) => {
      if (_req.url === '/chunked') {
        res.writeHead(200);
        res.write('x'.repeat(64));
        res.end();
        return;
      }
      const bomb = gzipSync('A'.repeat(50_000));
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    const port = await listen(server);
    try {
      const chunked = await pinnedRequest(
        new URL(`http://tiles.example:${port}/chunked`),
        undefined,
        '127.0.0.1',
        { maxBytes: 16 },
      );
      await expect(chunked.text()).rejects.toThrow(/larger than 16/);
      const bomb = await pinnedRequest(
        new URL(`http://tiles.example:${port}/bomb`),
        undefined,
        '127.0.0.1',
        { maxBytes: 1024 },
      );
      await expect(bomb.text()).rejects.toThrow(/larger than 1024/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('decodes gzip, deflate, and brotli the way fetch does', async () => {
    const plain = 'decoded-body';
    const server = createHttpServer((_req, res) => {
      const encoding = _req.url?.slice(1) ?? '';
      const body =
        encoding === 'gzip'
          ? gzipSync(plain)
          : encoding === 'deflate'
            ? deflateSync(plain)
            : brotliCompressSync(plain);
      res.writeHead(200, { 'content-encoding': encoding });
      res.end(body);
    });
    const port = await listen(server);
    try {
      for (const encoding of ['gzip', 'deflate', 'br']) {
        const res = await pinnedRequest(
          new URL(`http://tiles.example:${port}/${encoding}`),
          undefined,
          '127.0.0.1',
        );
        expect(res.headers.get('content-encoding')).toBeNull();
        await expect(res.text()).resolves.toBe(plain);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('honors GRATIS_SAFE_FETCH_TIMEOUT_MS', async () => {
    const server = createHttpServer(() => {
      /* hang */
    });
    const port = await listen(server);
    const previous = process.env.GRATIS_SAFE_FETCH_TIMEOUT_MS;
    process.env.GRATIS_SAFE_FETCH_TIMEOUT_MS = '200';
    try {
      await expect(
        pinnedRequest(new URL(`http://tiles.example:${port}/hang`), undefined, '127.0.0.1'),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.GRATIS_SAFE_FETCH_TIMEOUT_MS;
      else process.env.GRATIS_SAFE_FETCH_TIMEOUT_MS = previous;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('destroys the socket when the caller aborts', async () => {
    let closed = false;
    let connected = false;
    const server = createHttpServer(() => {
      /* hang */
    });
    server.on('connection', (socket) => {
      connected = true;
      socket.on('close', () => {
        closed = true;
      });
    });
    const port = await listen(server);
    const controller = new AbortController();
    const pending = pinnedRequest(
      new URL(`http://tiles.example:${port}/hang`),
      { signal: controller.signal },
      '127.0.0.1',
    );
    for (let i = 0; i < 50 && !connected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(connected).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    for (let i = 0; i < 50 && !closed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closed).toBe(true);
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends URLSearchParams and rejects an unsupported body', async () => {
    const seen: string[] = [];
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push(Buffer.concat(chunks).toString());
        res.end('ok');
      });
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/form`),
        { method: 'POST', body: new URLSearchParams({ a: '1' }) },
        '127.0.0.1',
      );
      await expect(res.text()).resolves.toBe('ok');
      expect(seen).toEqual(['a=1']);
      await expect(
        pinnedRequest(
          new URL(`http://tiles.example:${port}/nope`),
          { method: 'POST', body: { nope: true } as never },
          '127.0.0.1',
        ),
      ).rejects.toBeInstanceOf(UnsupportedRequestBodyError);
      expect(seen).toEqual(['a=1']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not send Authorization to a redirected origin', async () => {
    const seen: Array<string | undefined> = [];
    const second = createHttpServer((req, res) => {
      seen.push(req.headers.authorization);
      res.end('landed');
    });
    const portB = await listen(second);
    const first = createHttpServer((_req, res) => {
      res.writeHead(302, { location: `http://other.example:${portB}/landed` });
      res.end();
    });
    const portA = await listen(first);
    _setSafeFetchTransportForTests((url, init) => pinnedRequest(url, init, '127.0.0.1'));
    try {
      const res = await safeFetch(`http://origin.example:${portA}/start`, {
        headers: { authorization: 'Bearer secret' },
      });
      await expect(res.text()).resolves.toBe('landed');
      expect(seen).toEqual([undefined]);
    } finally {
      await new Promise((resolve) => first.close(resolve));
      await new Promise((resolve) => second.close(resolve));
    }
  });

  it('pipes a node stream body', async () => {
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => res.end(Buffer.concat(chunks)));
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/stream`),
        { method: 'POST', body: Readable.from(['abc', 'def']) as never },
        '127.0.0.1',
      );
      await expect(res.text()).resolves.toBe('abcdef');
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

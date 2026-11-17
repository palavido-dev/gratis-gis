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

  it('a signal that fires after the headers also ends the body read', async () => {
    // Callers pass one timeout that must cover the body too, not just
    // the wait for headers: an upstream can answer 200 and then drip.
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"a":');
      /* then stall */
    });
    const port = await listen(server);
    const signal = AbortSignal.timeout(300);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/drip`),
        { signal },
        '127.0.0.1',
      );
      expect(res.status).toBe(200);
      await expect(res.json()).rejects.toThrow();
    } finally {
      server.closeAllConnections();
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

  it('reads the socket only as fast as the consumer pulls', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const total = 64 * 1024 * 1024;
    let written = 0;
    let blocked = false;
    let socketClosed!: Promise<void>;
    const server = createHttpServer((req, res) => {
      socketClosed = new Promise((resolve) => req.socket.once('close', () => resolve()));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const pump = () => {
        while (written < total) {
          written += chunk.length;
          if (!res.write(chunk)) {
            blocked = true;
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/slow`),
        undefined,
        '127.0.0.1',
      );
      const reader = res.body!.getReader();
      let pulled = 0;
      const first = await reader.read();
      pulled += first.value?.byteLength ?? 0;
      // A slow consumer: wait while the server keeps trying to write.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const writtenWhileIdle = written;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(blocked).toBe(true);
      // The server stalled: nothing more went out while we did not pull.
      expect(written).toBe(writtenWhileIdle);
      // Only the kernel socket buffers and one stream chunk sit between
      // the two ends, far less than the body.
      expect(written).toBeLessThan(total / 4);
      for (let i = 0; i < 4; i++) {
        const next = await reader.read();
        pulled += next.value?.byteLength ?? 0;
      }
      expect(pulled).toBeGreaterThan(0);
      await reader.cancel();
      await socketClosed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('errors the reader when a streamed body crosses the cap', async () => {
    let socketClosed!: Promise<void>;
    const server = createHttpServer((req, res) => {
      socketClosed = new Promise((resolve) => req.socket.once('close', () => resolve()));
      res.writeHead(200);
      const chunk = Buffer.alloc(16 * 1024, 0x62);
      let left = 64;
      const pump = () => {
        while (left > 0) {
          left -= 1;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/stream`),
        undefined,
        '127.0.0.1',
        { maxBytes: 100 * 1024 },
      );
      const reader = res.body!.getReader();
      let got = 0;
      const drain = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          got += value.byteLength;
        }
      };
      await expect(drain()).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
      expect(got).toBeLessThanOrEqual(100 * 1024);
      await socketClosed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('closes the socket when the reader cancels', async () => {
    let socketClosed!: Promise<void>;
    const server = createHttpServer((req, res) => {
      socketClosed = new Promise((resolve) => req.socket.once('close', () => resolve()));
      res.writeHead(200);
      // Never ends on its own.
      res.write('first');
    });
    const port = await listen(server);
    try {
      const res = await pinnedRequest(
        new URL(`http://tiles.example:${port}/open`),
        undefined,
        '127.0.0.1',
      );
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!).toString()).toBe('first');
      await reader.cancel();
      await socketClosed;
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('applies a per-call maxBytes passed to safeFetch', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-length': '40' });
      res.end('x'.repeat(40));
    });
    const port = await listen(server);
    _setSafeFetchTransportForTests((url, init, _addresses, options) =>
      pinnedRequest(url, init, '127.0.0.1', options?.maxBytes ? { maxBytes: options.maxBytes } : {}),
    );
    try {
      await expect(
        safeFetch(`http://tiles.example:${port}/big`, undefined, { maxBytes: 16 }),
      ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
      const ok = await safeFetch(`http://tiles.example:${port}/big`, undefined, { maxBytes: 64 });
      await expect(ok.text()).resolves.toBe('x'.repeat(40));
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

describe('safeFetch time limit', () => {
  afterEach(() => {
    _setSafeFetchTransportForTests(null);
  });

  it('adds a time limit when the caller brings no signal', async () => {
    let seen: AbortSignal | null | undefined;
    _setSafeFetchTransportForTests(async (_url, init) => {
      seen = init?.signal;
      return new Response('ok');
    });
    await safeFetch('http://tiles.example/x');
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('stops reading a body that drips past the caller signal', async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('a');
      const t = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(t));
    });
    const port = await listen(server);
    _setSafeFetchTransportForTests((url, init) => pinnedRequest(url, init, '127.0.0.1'));
    try {
      const res = await safeFetch(`http://tiles.example:${port}/drip`, {
        signal: AbortSignal.timeout(300),
      });
      const started = Date.now();
      await expect(res.text()).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * @jest-environment node
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchFailureReason, longRunningFetch } from './long-running-fetch';

/**
 * A real HTTP server, not a mock: #573 was a version mismatch between
 * fetch and its dispatcher that only shows up on a real request.
 */
let server: http.Server;
let base: string;
const seen: Array<{ method: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, body });
      const delay = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('delay') ?? 0);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write('{"n":1}\n');
        setTimeout(() => res.end('{"n":2}\n'), 20);
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe('longRunningFetch', () => {
  it('completes a real request (the 1.3.0 to 1.4.0 dispatcher failed here at once)', async () => {
    const res = await longRunningFetch(`${base}/?delay=50`, { method: 'GET', cache: 'no-store' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"n":1}\n{"n":2}\n');
  });

  it('streams a request body the way the BFF forwards uploads', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"handle":"h"}'));
        c.close();
      },
    });
    const ac = new AbortController();
    const res = await longRunningFetch(`${base}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
      cache: 'no-store',
      signal: ac.signal,
    } as RequestInit);
    expect(res.status).toBe(200);
    await res.text();
    expect(seen.at(-1)).toEqual({ method: 'POST', body: '{"handle":"h"}' });
  });

  it('streams the response body chunk by chunk', async () => {
    const res = await longRunningFetch(`${base}/?delay=0`, { method: 'GET' });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('{"n":1}\n');
    await reader.cancel();
  });

  it('honors an abort from the browser', async () => {
    const ac = new AbortController();
    const p = longRunningFetch(`${base}/?delay=5000`, { method: 'GET', signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow();
  });
});

describe('fetchFailureReason', () => {
  it('includes the cause code and message', () => {
    const cause = Object.assign(new Error('invalid onRequestStart method'), {
      code: 'UND_ERR_INVALID_ARG',
    });
    expect(fetchFailureReason(new TypeError('fetch failed', { cause }))).toBe(
      'fetch failed: UND_ERR_INVALID_ARG invalid onRequestStart method',
    );
  });

  it('falls back to the message, or the value', () => {
    expect(fetchFailureReason(new Error('boom'))).toBe('boom');
    expect(fetchFailureReason('x')).toBe('x');
    expect(fetchFailureReason(new Error('f', { cause: 'refused' }))).toBe('f: refused');
  });

  it('reports a refused connection with its code', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const err = await longRunningFetch(`http://127.0.0.1:${port}/`, { method: 'GET' }).catch(
      (e: unknown) => e,
    );
    expect(fetchFailureReason(err)).toMatch(/^fetch failed: ECONNREFUSED/);
  });
});

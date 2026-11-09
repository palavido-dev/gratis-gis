// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { Response as ExpressResponse } from 'express';

import {
  readUpstreamText,
  streamUpstreamToResponse,
  UpstreamBodyTooLargeError,
} from './proxy-stream.js';

/**
 * Minimal Express-response double: records status, headers, and the
 * bytes written, and lets a test force one backpressure stall by
 * having `write` return false and then emit 'drain'.
 */
function fakeRes() {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const state = {
    statusCode: 200,
    headers,
    chunks,
    ended: false,
    destroyed: false,
    headersSent: false,
    blockOnce: false,
  };
  Object.assign(ee, {
    get statusCode() {
      return state.statusCode;
    },
    get headersSent() {
      return state.headersSent;
    },
    status(code: number) {
      state.statusCode = code;
      return ee;
    },
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    getHeader(key: string) {
      return headers[key.toLowerCase()];
    },
    write(buf: Buffer) {
      state.headersSent = true;
      chunks.push(Buffer.from(buf));
      if (state.blockOnce) {
        state.blockOnce = false;
        setImmediate(() => ee.emit('drain'));
        return false;
      }
      return true;
    },
    end() {
      state.ended = true;
    },
    destroy() {
      state.destroyed = true;
    },
  });
  return { res: ee as unknown as ExpressResponse, state };
}

function upstream(
  body: Uint8Array | string | null,
  headers: Record<string, string> = {},
  status = 200,
): globalThis.Response {
  return new Response(body, { status, headers });
}

describe('streamUpstreamToResponse', () => {
  it('streams the whole body, forwards content-type, and does not forward content-length', async () => {
    const { res, state } = fakeRes();
    await streamUpstreamToResponse(
      upstream('hello world', {
        'content-type': 'application/json',
        'content-length': '11',
      }),
      res,
    );
    expect(state.ended).toBe(true);
    expect(state.destroyed).toBe(false);
    expect(state.headers['content-type']).toBe('application/json');
    // content-length is deliberately dropped (fetch decompresses, so
    // the upstream count would be wrong and truncate the document).
    expect(state.headers['content-length']).toBeUndefined();
    expect(Buffer.concat(state.chunks).toString()).toBe('hello world');
  });

  it('cuts the response and destroys the socket when the body exceeds the byte cap', async () => {
    const { res, state } = fakeRes();
    const big = new Uint8Array(4096).fill(65); // 4 KB of 'A'
    await streamUpstreamToResponse(upstream(big), res, { maxBytes: 1024 });
    expect(state.destroyed).toBe(true);
    expect(state.ended).toBe(false);
    // We stopped early, so far less than the whole body was written.
    expect(Buffer.concat(state.chunks).byteLength).toBeLessThan(4096);
  });

  it('ends cleanly on an empty body', async () => {
    const { res, state } = fakeRes();
    await streamUpstreamToResponse(upstream(null, {}, 204), res);
    expect(state.ended).toBe(true);
    expect(state.destroyed).toBe(false);
    expect(state.chunks).toHaveLength(0);
  });

  it('readUpstreamText returns the body under the cap and throws past it', async () => {
    await expect(readUpstreamText(upstream('{"ok":true}'), 1024)).resolves.toBe(
      '{"ok":true}',
    );
    const big = new Uint8Array(4096).fill(65);
    await expect(readUpstreamText(upstream(big), 1024)).rejects.toBeInstanceOf(
      UpstreamBodyTooLargeError,
    );
  });

  it('waits for drain under backpressure and still delivers the full body', async () => {
    const { res, state } = fakeRes();
    state.blockOnce = true;
    await streamUpstreamToResponse(
      upstream('backpressure test payload'),
      res,
    );
    expect(state.ended).toBe(true);
    expect(Buffer.concat(state.chunks).toString()).toBe(
      'backpressure test payload',
    );
  });
});

describe('proxied response headers', () => {
  async function headersFor(contentType: string | null) {
    const { res, state } = fakeRes();
    const h: Record<string, string> = {};
    if (contentType !== null) h['content-type'] = contentType;
    // Bytes, not a string: a string body makes Response invent
    // text/plain, which would hide the no-type case.
    await streamUpstreamToResponse(upstream(new Uint8Array([120]), h), res);
    return state.headers;
  }

  it('always sends a sandbox CSP and nosniff', async () => {
    const h = await headersFor('image/png');
    expect(h['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['content-type']).toBe('image/png');
    expect(h['content-disposition']).toBeUndefined();
  });

  it.each([
    'text/html; charset=utf-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/xml',
    'text/xml',
    'application/vnd.ogc.se_xml+xml',
    'application/pdf',
    'multipart/x-mixed-replace; boundary=x',
    'text/plain, text/html',
    'application/json, text/html',
    'application/x-unknown-thing',
  ])('forces attachment for %s', async (type) => {
    const h = await headersFor(type);
    expect(h['content-disposition']).toBe('attachment');
    expect(h['content-type']).toBe(type);
  });

  it('forces attachment when the upstream sends no type', async () => {
    const h = await headersFor(null);
    expect(h['content-disposition']).toBe('attachment');
  });

  it('relabels script types so nosniff refuses to run them', async () => {
    const h = await headersFor('application/javascript');
    expect(h['content-type']).toBe('text/plain; charset=utf-8');
    expect(h['content-disposition']).toBe('attachment');
  });

  it('leaves JSON and tiles inline for fetch-based clients', async () => {
    for (const type of [
      'application/json',
      'application/x-protobuf',
      'application/vnd.mapbox-vector-tile',
      'image/jpeg',
      'image/png',
      'text/plain; charset=utf-8',
    ]) {
      const h = await headersFor(type);
      expect(h['content-disposition']).toBeUndefined();
    }
  });
});

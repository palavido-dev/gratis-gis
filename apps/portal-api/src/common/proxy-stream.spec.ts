// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { Response as ExpressResponse } from 'express';

import { streamUpstreamToResponse } from './proxy-stream.js';

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

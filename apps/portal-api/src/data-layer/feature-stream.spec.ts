// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { Response as ExpressResponse } from 'express';

import { streamFeatureCollection } from './feature-stream.js';

function fakeRes() {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const headers: Record<string, string> = {};
  const state = {
    headers,
    body: '',
    ended: false,
    headersSent: false,
    blockOnce: false,
  };
  Object.assign(ee, {
    get headersSent() {
      return state.headersSent;
    },
    setHeader(key: string, value: string) {
      headers[key.toLowerCase()] = value;
    },
    write(chunk: string | Buffer) {
      state.headersSent = true;
      state.body += chunk.toString();
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
  });
  return { res: ee as unknown as ExpressResponse, state };
}

async function* batchesOf(
  batches: unknown[][],
  opts: { throwAtBatch?: number } = {},
): AsyncGenerator<unknown[]> {
  for (let i = 0; i < batches.length; i++) {
    if (opts.throwAtBatch === i) throw new Error('boom');
    yield batches[i]!;
  }
}

describe('streamFeatureCollection', () => {
  it('streams bytes identical to JSON.stringify of the collection', async () => {
    const { res, state } = fakeRes();
    const features = [{ a: 1 }, { type: 'Feature', id: 'x' }, { b: [1, 2] }];
    await streamFeatureCollection(
      res,
      batchesOf([[features[0]], [features[1], features[2]]]),
    );
    expect(state.ended).toBe(true);
    expect(state.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(state.body).toBe(
      JSON.stringify({ type: 'FeatureCollection', features }),
    );
  });

  it('emits an empty collection when there are no batches', async () => {
    const { res, state } = fakeRes();
    await streamFeatureCollection(res, batchesOf([]));
    expect(state.body).toBe('{"type":"FeatureCollection","features":[]}');
    expect(state.ended).toBe(true);
  });

  it('propagates an error from the first batch before any bytes are written', async () => {
    const { res, state } = fakeRes();
    await expect(
      streamFeatureCollection(res, batchesOf([[{ a: 1 }]], { throwAtBatch: 0 })),
    ).rejects.toThrow('boom');
    // Nothing was written, so Nest can still send a clean error status.
    expect(state.headersSent).toBe(false);
    expect(state.body).toBe('');
  });

  it('ends the truncated body on a mid-stream error (no throw once headers are out)', async () => {
    const { res, state } = fakeRes();
    await streamFeatureCollection(
      res,
      batchesOf([[{ a: 1 }], [{ b: 2 }]], { throwAtBatch: 1 }),
    );
    // Headers/opening already sent; body is truncated (no closing ]}).
    expect(state.headersSent).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.body.endsWith(']}')).toBe(false);
    expect(state.body.startsWith('{"type":"FeatureCollection","features":[')).toBe(
      true,
    );
  });

  it('waits for drain under backpressure and still delivers the whole collection', async () => {
    const { res, state } = fakeRes();
    state.blockOnce = true;
    const features = [{ a: 1 }, { b: 2 }];
    await streamFeatureCollection(res, batchesOf([[features[0]], [features[1]]]));
    expect(state.ended).toBe(true);
    expect(state.body).toBe(
      JSON.stringify({ type: 'FeatureCollection', features }),
    );
  });
});

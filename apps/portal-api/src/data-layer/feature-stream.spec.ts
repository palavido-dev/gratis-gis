// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response } from 'express';

import { FeatureQueryBudgetError } from './feature-paging.js';
import { streamFeatureCollection } from './feature-stream.js';

function fakeResponse() {
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    setHeader() {
      return undefined;
    },
    write(chunk: string) {
      this.headersSent = true;
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      this.headersSent = true;
    },
    once() {
      return this;
    },
    off() {
      return this;
    },
  };
  return { res: res as unknown as Response, chunks, state: res };
}

async function* batches(pages: unknown[][]) {
  for (const page of pages) yield page;
}

describe('streamFeatureCollection budget', () => {
  it('throws before writing when the first batch is over the byte cap', async () => {
    const { res, chunks, state } = fakeResponse();
    await expect(
      streamFeatureCollection(res, batches([[{ id: 'x'.repeat(80) }]]), {
        maxBytes: 40,
        maxMs: null,
      }),
    ).rejects.toBeInstanceOf(FeatureQueryBudgetError);
    expect(state.headersSent).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('ends an incomplete body when a later batch crosses the cap', async () => {
    const { res, chunks } = fakeResponse();
    await expect(
      streamFeatureCollection(
        res,
        batches([[{ id: 'a' }], [{ id: 'b'.repeat(80) }]]),
        { maxBytes: 80, maxMs: null },
      ),
    ).rejects.toBeInstanceOf(FeatureQueryBudgetError);
    const body = chunks.join('');
    expect(body.startsWith('{"type":"FeatureCollection","features":[')).toBe(true);
    expect(body.endsWith(']}')).toBe(false);
  });

  it('writes a complete collection inside the budget', async () => {
    const { res, chunks } = fakeResponse();
    await streamFeatureCollection(res, batches([[{ id: 'a' }]]), {
      maxBytes: 10_000,
      maxMs: 5_000,
    });
    expect(JSON.parse(chunks.join(''))).toEqual({
      type: 'FeatureCollection',
      features: [{ id: 'a' }],
    });
  });
});

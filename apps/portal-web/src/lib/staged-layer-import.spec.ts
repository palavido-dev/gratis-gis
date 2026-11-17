// SPDX-License-Identifier: AGPL-3.0-or-later
import { enqueueStagedLayerImports } from './staged-layer-import';

describe('enqueueStagedLayerImports', () => {
  it('posts one replace import per staged layer', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const errors = await enqueueStagedLayerImports(
      'item 1',
      [
        {
          stagingId: 'stg-1',
          layers: [
            { layerId: 'lyr_a', sourceLayerName: 'sectors' },
            { layerId: 'lyr_b', sourceLayerName: 'roads' },
          ],
        },
      ],
      async (url, body) => {
        calls.push({ url, body });
        return new Response('', { status: 202 });
      },
    );
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      {
        url: '/api/portal/items/item%201/layers/lyr_a/import-jobs',
        body: {
          stagingId: 'stg-1',
          sourceLayerName: 'sectors',
          mode: 'replace',
        },
      },
      {
        url: '/api/portal/items/item%201/layers/lyr_b/import-jobs',
        body: {
          stagingId: 'stg-1',
          sourceLayerName: 'roads',
          mode: 'replace',
        },
      },
    ]);
  });

  it('collects a failed layer and continues', async () => {
    const errors = await enqueueStagedLayerImports(
      'item',
      [
        {
          stagingId: 'stg',
          layers: [
            { layerId: 'a', sourceLayerName: 'one' },
            { layerId: 'b', sourceLayerName: 'two' },
          ],
        },
      ],
      async (_url, body) => {
        const name = (body as { sourceLayerName: string }).sourceLayerName;
        if (name === 'one') return new Response('nope', { status: 400 });
        return new Response('', { status: 202 });
      },
    );
    expect(errors).toEqual(['one: 400 nope']);
  });
});

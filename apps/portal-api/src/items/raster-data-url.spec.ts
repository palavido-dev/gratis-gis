// SPDX-License-Identifier: AGPL-3.0-or-later
import { rasterDataUrl, remoteRasterDataUrl } from './items.controller.js';

describe('rasterDataUrl', () => {
  it('keeps a png data url and drops svg and html', () => {
    expect(rasterDataUrl('data:image/png;base64,aaaa')).toBe(
      'data:image/png;base64,aaaa',
    );
    expect(rasterDataUrl('data:image/svg+xml,<svg></svg>')).toBeNull();
    expect(rasterDataUrl('data:text/html,<script>1</script>')).toBeNull();
  });
});

describe('remoteRasterDataUrl', () => {
  it('asks safeFetch to stop reading at 5 MB', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        }),
    );
    await expect(
      remoteRasterDataUrl('https://example.test/a.png', fetcher as never),
    ).resolves.toBe('data:image/png;base64,AQID');
    const calls = fetcher.mock.calls as unknown as Array<
      [string, unknown, { maxBytes?: number }]
    >;
    expect(calls[0]![2]).toEqual({ maxBytes: 5 * 1024 * 1024 });
  });
});

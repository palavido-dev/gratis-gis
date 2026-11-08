// SPDX-License-Identifier: AGPL-3.0-or-later
import { rasterDataUrl } from './items.controller.js';

describe('rasterDataUrl', () => {
  it('keeps a png data url and drops svg and html', () => {
    expect(rasterDataUrl('data:image/png;base64,aaaa')).toBe(
      'data:image/png;base64,aaaa',
    );
    expect(rasterDataUrl('data:image/svg+xml,<svg></svg>')).toBeNull();
    expect(rasterDataUrl('data:text/html,<script>1</script>')).toBeNull();
  });
});

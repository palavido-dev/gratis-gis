// SPDX-License-Identifier: AGPL-3.0-or-later
import { rewriteBareStorageUrls } from './items.service.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const U = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';

describe('rewriteBareStorageUrls (item save)', () => {
  it('rewrites bare bucket URLs of private objects in both key layouts, at any depth', () => {
    const data = {
      storageUrl: `http://minio:9000/gratisgis/item-file/${U}`,
      nested: {
        list: [`https://files.example/b/feature-attachment/o/${A}/${U}`, 'keep me'],
      },
      thumb: `https://files.example/b/item-thumb/o/${A}/${U}`,
    };
    expect(rewriteBareStorageUrls(data)).toEqual({
      storageUrl: `/api/portal/storage/private/item-file/${U}`,
      nested: { list: [`/api/portal/storage/private/feature-attachment/o/${A}/${U}`, 'keep me'] },
      // Public kinds keep their direct URL.
      thumb: `https://files.example/b/item-thumb/o/${A}/${U}`,
    });
  });

  it('returns the same value when nothing changes', () => {
    const data = { a: 1, b: ['x', { c: `https://files.example/b/item-file/${U}?download=1` }] };
    expect(rewriteBareStorageUrls(data)).toBe(data);
  });

  it('does not rewrite a URL whose key the parser refuses', () => {
    const data = { u: `https://files.example/b/item-file/o/${A}/../${U}` };
    expect(rewriteBareStorageUrls(data)).toBe(data);
  });
});

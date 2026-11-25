// SPDX-License-Identifier: AGPL-3.0-or-later
import { rewriteBareStorageUrls } from './items.service.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const U = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';
const BASES = { bases: ['https://files.example/', 'http://minio:9000'], bucket: 'b' };

describe('rewriteBareStorageUrls (item save)', () => {
  it('rewrites bare bucket URLs of private objects in both key layouts, at any depth', () => {
    const data = {
      storageUrl: `http://minio:9000/b/item-file/${U}`,
      nested: {
        list: [`https://files.example/b/feature-attachment/o/${A}/${U}`, 'keep me'],
      },
      relative: `/b/item-tile-layer/${U}`,
      thumb: `https://files.example/b/item-thumb/o/${A}/${U}`,
    };
    expect(rewriteBareStorageUrls(data, BASES)).toEqual({
      storageUrl: `/api/portal/storage/private/item-file/${U}`,
      nested: { list: [`/api/portal/storage/private/feature-attachment/o/${A}/${U}`, 'keep me'] },
      relative: `/api/portal/storage/private/item-tile-layer/${U}`,
      // Public kinds keep their direct URL.
      thumb: `https://files.example/b/item-thumb/o/${A}/${U}`,
    });
  });

  it('returns the same value when nothing changes', () => {
    const data = { a: 1, b: ['x', { c: `https://files.example/b/item-file/${U}?download=1` }] };
    expect(rewriteBareStorageUrls(data, BASES)).toBe(data);
  });

  it('does not rewrite a URL whose key the parser refuses', () => {
    const data = { u: `https://files.example/b/item-file/o/${A}/../${U}` };
    expect(rewriteBareStorageUrls(data, BASES)).toBe(data);
  });

  it('leaves look-alike hosts, other buckets, non-UUID names, data URIs and text as written', () => {
    const values = [
      // Hosts that only look like this install's.
      `https://files.example.attacker.test/b/item-file/${U}`,
      `https://attacker.test/files.example/b/item-file/${U}`,
      `https://files.example@attacker.test/b/item-file/${U}`,
      `https://attacker.test/b/item-file/${U}`,
      `http://files.example/b/item-file/${U}`,
      `//files.example/b/item-file/${U}`,
      // This install's host, other bucket or path.
      `https://files.example/other/item-file/${U}`,
      `https://files.example/item-file/${U}`,
      // Names that are not a UUID.
      `https://files.example/b/item-file/${'a'.repeat(36)}`,
      `https://files.example/b/item-file/deadbeef`,
      `https://files.example/b/item-file/${U.toUpperCase()}`,
      `https://files.example/b/item-file/${U}.png`,
      `https://files.example/b/item-file/${U}/x`,
      // Data URIs and markdown that mention a bucket URL.
      `data:text/plain,https://files.example/b/item-file/${U}`,
      `data:image/png;base64,aGVsbG8=`,
      `See [the file](https://files.example/b/item-file/${U}) for details.`,
      `![map](/b/item-file/${U})`,
      ` https://files.example/b/item-file/${U}`,
      `https://files.example/b/item-file/${U} `,
    ];
    for (const v of values) {
      const data = { v };
      expect({ v, got: rewriteBareStorageUrls(data, BASES) }).toEqual({ v, got: data });
    }
  });
});

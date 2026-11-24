// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isPrivateStorageProxyPath, parseObjectKey } from './storage-key';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const U = '7f1c2d3e-aaaa-4bbb-8ccc-0123456789ab';

describe('parseObjectKey (web mirror)', () => {
  it('agrees with the API parser on every shared case', () => {
    const doc = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'portal-api', 'src', 'storage', 'object-key-cases.json'),
        'utf8',
      ),
    ) as { cases: Array<{ key: string; parsed: [string, string | null, string] | null }> };
    expect(doc.cases.length).toBeGreaterThan(20);
    for (const c of doc.cases) {
      const want = c.parsed ? { kind: c.parsed[0], orgId: c.parsed[1], rest: c.parsed[2] } : null;
      expect({ key: c.key, got: parseObjectKey(c.key) }).toEqual({ key: c.key, got: want });
    }
  });
});

describe('isPrivateStorageProxyPath', () => {
  it('lets both key layouts through for proxied kinds', () => {
    expect(isPrivateStorageProxyPath(`storage/private/item-file/${U}`)).toBe(true);
    expect(isPrivateStorageProxyPath(`storage/private/feature-attachment/o/${A}/${U}`)).toBe(true);
    expect(isPrivateStorageProxyPath(`storage/private/item-point-cloud/o/${A}/${U}.copc.laz`)).toBe(true);
  });

  it('refuses other kinds, nesting, traversal and encoded separators', () => {
    for (const p of [
      `storage/private/item-thumb/${U}`,
      `storage/private/feedback-screenshot/o/${A}/${U}`,
      `storage/private/item-file/o/${A}/x/${U}`,
      `storage/private/item-file/o/${A}/..`,
      `storage/private/item-file/..`,
      `storage/private/item-file/o/${A}%2F${U}`,
      `storage/private/item-file/o/${A.toUpperCase()}/${U}`,
      `storage/private/item-file/o/${A}`,
      `storage/private/item-file/${'a'.repeat(201)}`,
      `storage/public/item-file/${U}`,
    ]) {
      expect({ p, ok: isPrivateStorageProxyPath(p) }).toEqual({ p, ok: false });
    }
  });
});

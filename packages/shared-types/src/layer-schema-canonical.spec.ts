// SPDX-License-Identifier: AGPL-3.0-or-later
import { canonicalLayerSchema } from './layer-schema-canonical.js';

/**
 * The text is a contract with every hash already stored on a device:
 * the web runtime's cached layers and queued edits, and the native
 * client's. These pin the exact bytes.
 */
describe('canonicalLayerSchema', () => {
  it('sorts by name, fixes key order, coerces nullable, nulls a missing domain', () => {
    const text = canonicalLayerSchema([
      { name: 'zeta', type: 'string', nullable: true, domain: undefined },
      { name: 'alpha', type: 'integer' },
      {
        name: 'kind',
        type: 'string',
        nullable: false,
        domain: { type: 'coded-value', values: [{ code: 'a', label: 'A' }] },
      },
    ]);
    expect(text).toBe(
      '[{"name":"alpha","type":"integer","nullable":false,"domain":null},' +
        '{"name":"kind","type":"string","nullable":false,"domain":{"type":"coded-value","values":[{"code":"a","label":"A"}]}},' +
        '{"name":"zeta","type":"string","nullable":true,"domain":null}]',
    );
  });

  it('ignores fields the hash never covered', () => {
    const a = canonicalLayerSchema([{ name: 'x', type: 'string' }]);
    const b = canonicalLayerSchema([
      { name: 'x', type: 'string', label: 'X', searchable: true } as never,
    ]);
    expect(a).toBe(b);
  });

  it('is empty-list stable', () => {
    expect(canonicalLayerSchema([])).toBe('[]');
  });
});

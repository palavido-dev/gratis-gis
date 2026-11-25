// SPDX-License-Identifier: AGPL-3.0-or-later
import { esriSchema, esriValue, fieldDoc, fromGlobalId, toGlobalId } from './esri-fields.js';

describe('esriSchema', () => {
  it('adds ObjectID and GlobalID ahead of the layer fields', () => {
    const s = esriSchema([
      { name: 'name', type: 'string', label: 'Name', nullable: false, storage: { maxLength: 80 } },
      { name: 'count', type: 'number', label: '', storage: { numberKind: 'integer' } },
    ]);
    expect(s.fields.map((f) => f.name)).toEqual(['OBJECTID', 'GlobalID', 'name', 'count']);
    expect(s.displayField).toBe('name');
    expect(fieldDoc(s.fields[2]!)).toMatchObject({ type: 'esriFieldTypeString', length: 80, nullable: false, alias: 'Name' });
    expect(fieldDoc(s.fields[3]!)).toMatchObject({ type: 'esriFieldTypeInteger', alias: 'count' });
  });

  it('keeps clear of a layer field already called OBJECTID', () => {
    const s = esriSchema([{ name: 'objectid', type: 'number' }]);
    expect(s.oidField).toBe('OBJECTID_1');
    expect(s.byLower.get('objectid')?.kind).toBe('double');
  });

  it('maps coded values, ranges and booleans to Esri domains', () => {
    const s = esriSchema([
      { name: 'kind', type: 'string', domain: { type: 'coded-value', values: [{ code: 'a', label: 'Alpha' }] } },
      { name: 'depth', type: 'number', domain: { type: 'range', min: 0, max: 9 } },
      { name: 'wet', type: 'boolean' },
    ]);
    expect(s.byLower.get('kind')!.domain).toMatchObject({ type: 'codedValue', codedValues: [{ name: 'Alpha', code: 'a' }] });
    expect(s.byLower.get('depth')!.domain).toMatchObject({ type: 'range', range: [0, 9] });
    expect(fieldDoc(s.byLower.get('wet')!)).toMatchObject({ type: 'esriFieldTypeSmallInteger' });
  });
});

describe('esriValue', () => {
  it('converts stored values to Esri attribute values', () => {
    expect(esriValue('double', '2.5')).toBe(2.5);
    expect(esriValue('integer', 'x')).toBeNull();
    expect(esriValue('boolean', true)).toBe(1);
    expect(esriValue('date', '2026-01-02T00:00:00Z')).toBe(Date.UTC(2026, 0, 2));
    expect(esriValue('multi', ['a', 'b'])).toBe('a, b');
    expect(esriValue('string', 7)).toBe('7');
    expect(esriValue('string', undefined)).toBeNull();
  });

  it('writes GlobalIDs the Esri way and reads them back', () => {
    const id = '0193f2a4-0000-7000-8000-000000000001';
    expect(toGlobalId(id)).toBe('{0193F2A4-0000-7000-8000-000000000001}');
    expect(fromGlobalId(toGlobalId(id))).toBe(id);
    expect(fromGlobalId('nope')).toBeNull();
  });
});

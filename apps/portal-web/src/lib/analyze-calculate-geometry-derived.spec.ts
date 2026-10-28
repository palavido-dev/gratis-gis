// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildCalculateGeometryDerivedLayerCreatePayload,
  buildCalculateGeometryDerivedLayerData,
  defaultCalculateGeometryDerivedLayerTitle,
  validateCalculateGeometryFieldName,
  validateCalculateGeometryParams,
} from './analyze-calculate-geometry-derived';

describe('analyze-calculate-geometry-derived', () => {
  it('builds a single-step calculate-geometry recipe', () => {
    const data = buildCalculateGeometryDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      measurement: 'area',
      unit: 'acres',
      fieldName: 'acres',
    });
    expect(data.source).toEqual({
      kind: 'data_layer',
      itemId: 'src',
      layerKey: 'l1',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'calculate-geometry',
        params: {
          measurement: 'area',
          unit: 'acres',
          fieldName: 'acres',
        },
      },
    ]);
  });

  it('validates field names and units', () => {
    expect(validateCalculateGeometryFieldName('')).toMatch(/Enter/);
    expect(validateCalculateGeometryFieldName('global_id')).toMatch(
      /reserved/,
    );
    expect(validateCalculateGeometryFieldName('1bad')).toMatch(/letter/);
    expect(validateCalculateGeometryFieldName('acres')).toBeNull();
    expect(
      validateCalculateGeometryParams('area', 'meters', 'acres'),
    ).toMatch(/area unit/);
    expect(
      validateCalculateGeometryParams('length', 'acres', 'len'),
    ).toMatch(/length unit/);
    expect(
      validateCalculateGeometryParams('perimeter', 'meters', 'perimeter_m'),
    ).toBeNull();
  });

  it('defaults title and create payload', () => {
    expect(
      defaultCalculateGeometryDerivedLayerTitle('Parcels', 'area', 'acres'),
    ).toBe('Parcels · area (ac)');
    const payload = buildCalculateGeometryDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      measurement: 'area',
      unit: 'acres',
      fieldName: 'acres',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · area (ac)');
    expect(payload.access).toBe('private');
    expect(payload.data.pipeline[0]?.tool).toBe('calculate-geometry');
    expect(payload.description).toMatch(/geography/);
    expect(payload.description).toMatch(/Not Calculate field/);
  });
});

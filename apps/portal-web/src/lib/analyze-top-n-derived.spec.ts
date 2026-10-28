// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  buildTopNDerivedLayerCreatePayload,
  buildTopNDerivedLayerData,
  defaultTopNDerivedLayerTitle,
  numericFieldsForTopN,
  validateTopNParams,
} from './analyze-top-n-derived';

const fields: FeatureField[] = [
  { name: 'acres', label: 'Acres', type: 'number', nullable: true },
  { name: 'name', label: 'Name', type: 'string', nullable: true },
];

describe('analyze-top-n-derived', () => {
  it('filters numeric fields and builds a top-n recipe', () => {
    expect(numericFieldsForTopN(fields).map((f) => f.name)).toEqual([
      'acres',
    ]);
    const data = buildTopNDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      field: 'acres',
      n: 10,
      direction: 'desc',
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'top-n',
        params: { field: 'acres', n: 10, direction: 'desc' },
      },
    ]);
  });

  it('validates field / n', () => {
    expect(validateTopNParams('', 10, 'desc', fields)).toMatch(/Pick a numeric/);
    expect(validateTopNParams('name', 10, 'desc', fields)).toMatch(/not a numeric/);
    expect(validateTopNParams('acres', 0, 'desc', fields)).toMatch(/positive/);
    expect(validateTopNParams('acres', 10, 'asc', fields)).toBeNull();
  });

  it('defaults title and create payload', () => {
    expect(
      defaultTopNDerivedLayerTitle('Parcels', 'acres', 10, 'desc'),
    ).toBe('Parcels · top 10 acres desc');
    const payload = buildTopNDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      field: 'acres',
      n: 5,
      direction: 'asc',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · top 5 acres asc');
    expect(payload.description).toMatch(/NULLs/);
  });
});

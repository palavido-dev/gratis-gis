// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  buildGroupByDerivedLayerCreatePayload,
  buildGroupByDerivedLayerData,
  defaultGroupByDerivedLayerTitle,
  defaultGroupByOutputName,
  validateGroupByParams,
} from './analyze-group-by-derived';

const fields: FeatureField[] = [
  { name: 'zoning', label: 'Zoning', type: 'string', nullable: true },
  { name: 'acres', label: 'Acres', type: 'number', nullable: true },
  { name: 'name', label: 'Name', type: 'string', nullable: true },
];

describe('analyze-group-by-derived', () => {
  it('builds count-by-key and whole-layer recipes', () => {
    expect(
      buildGroupByDerivedLayerData({
        sourceItemId: 'src',
        layerKey: 'l1',
        groupKey: 'zoning',
        op: 'count',
        aggField: '',
        outputName: 'count',
      }).pipeline,
    ).toEqual([
      {
        tool: 'aggregate',
        params: {
          groupBy: ['zoning'],
          aggs: [{ field: '', op: 'count', outputName: 'count' }],
        },
      },
    ]);
    expect(
      buildGroupByDerivedLayerData({
        sourceItemId: 'src',
        groupKey: '',
        op: 'avg',
        aggField: 'acres',
        outputName: 'avg_acres',
      }).pipeline[0],
    ).toEqual({
      tool: 'aggregate',
      params: {
        groupBy: [],
        aggs: [{ field: 'acres', op: 'avg', outputName: 'avg_acres' }],
      },
    });
  });

  it('validates key / op / numeric field / output name', () => {
    expect(
      validateGroupByParams('missing', 'count', '', 'count', fields),
    ).toMatch(/not a field/);
    expect(
      validateGroupByParams('zoning', 'sum', '', 'sum_acres', fields),
    ).toMatch(/numeric field/);
    expect(
      validateGroupByParams('zoning', 'sum', 'name', 'sum_acres', fields),
    ).toMatch(/not a numeric/);
    expect(
      validateGroupByParams('zoning', 'count', '', 'zoning', fields),
    ).toMatch(/collide/);
    expect(
      validateGroupByParams('zoning', 'count', '', 'count', fields),
    ).toBeNull();
    expect(
      validateGroupByParams('', 'avg', 'acres', 'avg_acres', fields),
    ).toBeNull();
  });

  it('defaults title / output name / create payload', () => {
    expect(defaultGroupByOutputName('count', '')).toBe('count');
    expect(defaultGroupByOutputName('sum', 'acres')).toBe('sum_acres');
    expect(
      defaultGroupByDerivedLayerTitle('Parcels', 'zoning', 'count', ''),
    ).toBe('Parcels · group by zoning count');
    const payload = buildGroupByDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Parcels',
      sourceItemId: 'src',
      groupKey: 'zoning',
      op: 'count',
      aggField: '',
      outputName: 'count',
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Parcels · group by zoning count');
    expect(payload.description).toMatch(/ST_Union/);
    expect(payload.description).toMatch(/NULL/);
  });
});

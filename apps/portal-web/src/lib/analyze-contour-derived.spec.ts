// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';
import {
  buildContourDerivedLayerCreatePayload,
  buildContourDerivedLayerData,
  defaultContourDerivedLayerTitle,
  numericFieldsForContour,
  validateContourParams,
} from './analyze-contour-derived';

const fields: FeatureField[] = [
  { name: 'elev_m', label: 'Elevation (m)', type: 'number', nullable: true },
  { name: 'name', label: 'Name', type: 'string', nullable: true },
];

describe('analyze-contour-derived', () => {
  it('filters numeric fields and builds an auto contour recipe', () => {
    expect(numericFieldsForContour(fields).map((f) => f.name)).toEqual([
      'elev_m',
    ]);
    const data = buildContourDerivedLayerData({
      sourceItemId: 'src',
      layerKey: 'l1',
      field: 'elev_m',
      interval: 10,
      minLevel: 0,
      maxLevel: 100,
    });
    expect(data.pipeline).toEqual([
      {
        tool: 'contour',
        params: {
          field: 'elev_m',
          mode: 'auto',
          interval: 10,
          minLevel: 0,
          maxLevel: 100,
        },
      },
    ]);
  });

  it('validates field / interval / min-max', () => {
    expect(validateContourParams('', 10, fields)).toMatch(/Pick a numeric/);
    expect(validateContourParams('name', 10, fields)).toMatch(/not a numeric/);
    expect(validateContourParams('elev_m', 0, fields)).toMatch(/positive/);
    expect(validateContourParams('elev_m', 10, fields, 20, 10)).toMatch(
      /strictly less/,
    );
    expect(validateContourParams('elev_m', 10, fields)).toBeNull();
    expect(validateContourParams('elev_m', 5, fields, 0, 50)).toBeNull();
  });

  it('defaults title and create payload', () => {
    expect(defaultContourDerivedLayerTitle('Samples', 'elev_m', 10)).toBe(
      'Samples · contour elev_m @ 10',
    );
    const payload = buildContourDerivedLayerCreatePayload({
      title: '',
      sourceLabel: 'Samples',
      sourceItemId: 'src',
      field: 'elev_m',
      interval: 10,
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.title).toBe('Samples · contour elev_m @ 10');
    expect(payload.description).toMatch(/iso-lines/);
    expect(payload.description).toMatch(/not iso-polygons/);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DataResolver } from '@gratis-gis/shared-types';

import { filterGenerator } from './filter.js';
import { calculateFieldGenerator } from './calculate-field.js';

const HYDRANTS = '0b6a1f6e-1d2c-4f0a-9b0e-3a1d2c4f0a9b';

const resolver: DataResolver = {
  related: () => ({ error: 'This layer has no related tables' }),
  layer: (name) =>
    name === 'Hydrants'
      ? {
          key: `${HYDRANTS}/h`,
          label: 'Hydrants',
          fields: [{ name: 'hid', type: 'string' }],
          hasGeometry: true,
          itemId: HYDRANTS,
          layerId: 'h',
        }
      : { error: `No layer called ${name} is shared with you` },
};

const schema = [{ name: 'acres', label: 'acres', type: 'number' as const, nullable: true }];

describe('expression steps that read other layers', () => {
  it('records the resolved source on save and reports it as a dependency', () => {
    const params = filterGenerator.validate(
      { expression: "count(within_distance(layer('Hydrants'), 100, 'feet')) > 0" },
      { sourceSchema: schema, expressionData: resolver },
    );
    expect(params.dataRefs).toEqual([{ kind: 'layer', name: 'Hydrants', itemId: HYDRANTS, layerId: 'h' }]);
    expect(filterGenerator.extractDependencies(params).itemIds).toEqual([HYDRANTS]);
  });

  it('keeps stored sources when re-validated on read, without a resolver', () => {
    const saved = calculateFieldGenerator.validate(
      { outputName: 'near', outputType: 'string', expression: "nearest(layer('Hydrants')).hid" },
      { sourceSchema: schema, expressionData: resolver },
    );
    const again = calculateFieldGenerator.validate(saved);
    expect(again.dataRefs).toEqual(saved.dataRefs);
  });

  it('refuses an unknown layer with the resolver sentence', () => {
    expect(() =>
      filterGenerator.validate(
        { expression: "count(layer('Nope')) > 0" },
        { sourceSchema: schema, expressionData: resolver },
      ),
    ).toThrow(/No layer called Nope/);
  });

  it('refuses data access where nothing can resolve it', () => {
    expect(() =>
      filterGenerator.validate({ expression: "count(layer('Hydrants')) > 0" }, { sourceSchema: schema }),
    ).toThrow(/not available here/);
  });

  it('drops tampered stored refs', () => {
    const p = filterGenerator.validate({
      expression: "count(layer('Hydrants')) > 0",
      dataRefs: [{ kind: 'layer', name: 'Hydrants', itemId: "x'; drop table", layerId: 'h' }],
    });
    expect(p.dataRefs).toBeUndefined();
  });
});

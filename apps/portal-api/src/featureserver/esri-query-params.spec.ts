// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { esriSchema } from './esri-fields.js';
import { MAX_RECORD_COUNT, parseEsriQuery, parseSr } from './esri-query-params.js';

const schema = esriSchema([
  { name: 'status', type: 'string' },
  { name: 'area', type: 'number' },
]);

describe('parseEsriQuery', () => {
  it('defaults to the ObjectID only, with geometry, first page', () => {
    const q = parseEsriQuery({}, schema, false);
    expect(q.outFields).toEqual([]);
    expect(q.returnGeometry).toBe(true);
    expect(q.offset).toBe(0);
    expect(q.count).toBe(MAX_RECORD_COUNT);
    expect(q.outSr).toBe(4326);
  });

  it('reads the parameters Pro sends', () => {
    const q = parseEsriQuery(
      {
        f: 'json',
        where: "status = 'a'",
        outFields: '*',
        returnGeometry: 'false',
        outSR: '102100',
        resultOffset: '2000',
        resultRecordCount: '99999',
        orderByFields: 'area DESC',
        geometry: '{"xmin":0,"ymin":0,"xmax":1,"ymax":1}',
        inSR: '{"wkid":4326}',
        spatialRel: 'esriSpatialRelIntersects',
      },
      schema,
      false,
    );
    expect(q.outFields.map((f) => f.name)).toEqual(['GlobalID', 'status', 'area']);
    expect(q.returnGeometry).toBe(false);
    expect(q.outSr).toBe(3857);
    expect(q.offset).toBe(2000);
    expect(q.count).toBe(MAX_RECORD_COUNT);
    expect(q.orderBy[0]).toMatchObject({ desc: true });
    expect(q.geometry).not.toBeNull();
  });

  it('reads parameter names in any case', () => {
    expect(parseEsriQuery({ RETURNCOUNTONLY: 'true' }, schema, false).countOnly).toBe(true);
  });

  it('reads objectIds and statistics', () => {
    const q = parseEsriQuery(
      {
        objectIds: '1, 2,3',
        outStatistics: '[{"statisticType":"sum","onStatisticField":"area","outStatisticFieldName":"total"}]',
        groupByFieldsForStatistics: 'status',
      },
      schema,
      false,
    );
    expect(q.objectIds).toEqual([1, 2, 3]);
    expect(q.statistics![0]).toMatchObject({ type: 'sum', outName: 'total' });
    expect(q.groupBy.map((f) => f.name)).toEqual(['status']);
  });

  it.each([
    [{ f: 'pbf' }],
    [{ distance: '10' }],
    [{ objectIds: '1,x' }],
    [{ outFields: 'nope' }],
    [{ returnGeometry: 'maybe' }],
    [{ spatialRel: 'esriSpatialRelRelation' }],
    [{ outStatistics: '[{"statisticType":"sum","onStatisticField":"status"}]' }],
    [{ outStatistics: '[{"statisticType":"sum","onStatisticField":"area","outStatisticFieldName":"a b"}]' }],
    [{ returnDistinctValues: 'true' }],
  ])('refuses %j', (params) => {
    expect(() => parseEsriQuery(params, schema, false)).toThrow(BadRequestException);
  });

  it('ignores geometry on a table', () => {
    const q = parseEsriQuery({ geometry: '0,0,1,1', returnGeometry: 'true' }, schema, true);
    expect(q.geometry).toBeNull();
    expect(q.returnGeometry).toBe(false);
  });
});

describe('parseSr', () => {
  it('maps the Web Mercator wkids to 3857', () => {
    expect(parseSr('102100', 4326)).toBe(3857);
    expect(parseSr('{"wkid":102100,"latestWkid":3857}', 4326)).toBe(3857);
    expect(parseSr('2229', 4326)).toBe(2229);
    expect(parseSr(undefined, 4326)).toBe(4326);
    expect(() => parseSr('abc', 4326)).toThrow(BadRequestException);
  });
});

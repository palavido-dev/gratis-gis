// SPDX-License-Identifier: AGPL-3.0-or-later
import { gdalTypeToSimple, normalizeGdalProps, normalizeGdalValue } from './gdal-values.js';
import { IngestService } from './ingest.service.js';

describe('normalizeGdalValue', () => {
  it('turns a GDAL Date object into YYYY-MM-DD', () => {
    expect(normalizeGdalValue({ year: 2021, month: 3, day: 4 })).toBe('2021-03-04');
  });

  it('turns a UTC DateTime into an ISO string with Z', () => {
    expect(
      normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 10, minute: 20, second: 30, timezone: 100 }),
    ).toBe('2021-03-04T10:20:30Z');
  });

  it('writes the offset GDAL encodes in 15 minute steps', () => {
    expect(
      normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 10, minute: 20, second: 30, timezone: 88 }),
    ).toBe('2021-03-04T10:20:30-03:00');
    expect(
      normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 10, minute: 0, second: 0, timezone: 122 }),
    ).toBe('2021-03-04T10:00:00+05:30');
  });

  it('leaves unknown and local time without a suffix', () => {
    expect(normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 1, minute: 2, second: 3 })).toBe(
      '2021-03-04T01:02:03',
    );
    expect(
      normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 1, minute: 2, second: 3, timezone: 1 }),
    ).toBe('2021-03-04T01:02:03');
  });

  it('keeps fractional seconds', () => {
    expect(
      normalizeGdalValue({ year: 2021, month: 3, day: 4, hour: 1, minute: 2, second: 3.25, timezone: 100 }),
    ).toBe('2021-03-04T01:02:03.250Z');
  });

  it('never writes a four digit fraction for .9995 seconds and up', () => {
    expect(
      normalizeGdalValue({ year: 2020, month: 1, day: 1, hour: 10, minute: 0, second: 0.9996, timezone: 100 }),
    ).toBe('2020-01-01T10:00:00.999Z');
  });

  it('writes a list field as JSON text', () => {
    expect(normalizeGdalValue(['a', 'b'])).toBe('["a","b"]');
    expect(normalizeGdalValue([1, 2])).toBe('[1,2]');
    expect(gdalTypeToSimple('integer[]')).toBe('string');
    expect(gdalTypeToSimple('real[]')).toBe('string');
    expect(gdalTypeToSimple('integer64[]')).toBe('string');
    expect(gdalTypeToSimple('IntegerList')).toBe('string');
  });

  it('turns a Time object into HH:MM:SS', () => {
    expect(normalizeGdalValue({ hour: 7, minute: 5, second: 9 })).toBe('07:05:09');
  });

  it('treats a zeroed shapefile date as no value', () => {
    expect(normalizeGdalValue({ year: 0, month: 0, day: 0 })).toBeNull();
  });

  it('passes every other value through untouched', () => {
    const obj = { a: 1 };
    expect(normalizeGdalValue(obj)).toBe(obj);
    expect(normalizeGdalValue('Açaí')).toBe('Açaí');
    expect(normalizeGdalValue(null)).toBeNull();
    expect(normalizeGdalValue(3)).toBe(3);
    const d = new Date(0);
    expect(normalizeGdalValue(d)).toBe(d);
  });
});

describe('normalizeGdalProps', () => {
  it('returns the same object when nothing changes', () => {
    const raw = { a: 1, b: 'x' };
    expect(normalizeGdalProps(raw)).toBe(raw);
  });

  it('copies before rewriting a date', () => {
    const raw = { d: { year: 2020, month: 1, day: 2 }, n: 1 };
    expect(normalizeGdalProps(raw)).toEqual({ d: '2020-01-02', n: 1 });
    expect(raw.d).toEqual({ year: 2020, month: 1, day: 2 });
  });
});

describe('gdalTypeToSimple', () => {
  it('maps date and dateTime to date and a bare time to text', () => {
    expect(gdalTypeToSimple('date')).toBe('date');
    expect(gdalTypeToSimple('dateTime')).toBe('date');
    expect(gdalTypeToSimple('time')).toBe('string');
    expect(gdalTypeToSimple('integer64')).toBe('number');
    expect(gdalTypeToSimple('string')).toBe('string');
  });
});

/**
 * End to end through GDAL: a GeoJSON with date columns, accented text
 * and a first feature with no geometry. Before the fix the dates came
 * out as objects (every row failed validation) and the layer was
 * classified as a table because only the first row was inspected.
 */
describe('IngestService with GDAL date fields', () => {
  const collection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { Inauguracao: null, Nome: 'Sem forma', Hora: null },
        geometry: null,
      },
      {
        type: 'Feature',
        properties: { Inauguracao: '2021-03-04', Nome: 'Praça São João', Hora: '10:20:30' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      },
      {
        type: 'Feature',
        properties: { Inauguracao: '2022-12-31', Nome: 'Açaí', Hora: '23:59:59' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] },
      },
    ],
  };
  const buffer = Buffer.from(JSON.stringify(collection), 'utf8');

  it('classifies the layer by the first row that has a geometry', async () => {
    const ingest = new IngestService();
    const tmp = await ingest.materializeBufferToTemp(buffer, 'setores.geojson');
    const probe = await ingest.probeFileFromPath(tmp.filePath).finally(() => tmp.cleanup());
    const layer = probe.layers[0]!;
    expect(layer.geometryType).toBe('polygon');
    const types = Object.fromEntries(layer.fields.map((f) => [f.name, f.type]));
    expect(types.Inauguracao).toBe('date');
    expect(types.Hora).toBe('string');
  });

  it('emits date values as strings the validator accepts', async () => {
    const out = await new IngestService().fileToGeoJson(buffer, 'setores.geojson');
    const props = (out.geojson.features as Array<{ properties: Record<string, unknown> }>).map(
      (f) => f.properties,
    );
    expect(props).toEqual([
      { Inauguracao: '2021-03-04', Nome: 'Praça São João', Hora: '10:20:30' },
      { Inauguracao: '2022-12-31', Nome: 'Açaí', Hora: '23:59:59' },
    ]);
  });
});

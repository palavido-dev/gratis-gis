// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APPEND_BATCH_SIZE,
  appendInBatches,
  buildV3LayerData,
  capFeatureCollection,
  chunk,
  inferFields,
  inferGeometryType,
  isUuid,
  toAppendFeatures,
} from './geojson-layer.js';

describe('inferGeometryType', () => {
  it('returns point for Point features', () => {
    assert.equal(
      inferGeometryType([
        { geometry: { type: 'Point', coordinates: [0, 0] } },
      ]),
      'point',
    );
  });

  it('returns null when every feature lacks geometry', () => {
    assert.equal(inferGeometryType([{ properties: { a: 1 } }]), null);
  });

  it('refuses mixed real geometry types', () => {
    assert.throws(
      () =>
        inferGeometryType([
          { geometry: { type: 'Point', coordinates: [0, 0] } },
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        ]),
      /mixed geometry/,
    );
  });
});

describe('inferFields', () => {
  it('promotes mixed property types to string', () => {
    const fields = inferFields([
      { properties: { n: 1, flag: true, name: 'a' } },
      { properties: { n: 'two', flag: false, name: 'b' } },
    ]);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.type]));
    assert.equal(byName.n, 'string');
    assert.equal(byName.flag, 'boolean');
    assert.equal(byName.name, 'string');
  });
});

describe('toAppendFeatures', () => {
  it('maps UUID Feature.id to globalId and drops type', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const out = toAppendFeatures([
      {
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { a: 1 },
      },
    ]);
    assert.deepEqual(out, [
      {
        globalId: id,
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { a: 1 },
      },
    ]);
  });

  it('ignores non-UUID Feature.id', () => {
    const out = toAppendFeatures([
      { id: 'osm/123', geometry: null, properties: {} },
    ]);
    assert.equal(out[0]!.globalId, undefined);
  });
});

describe('chunk / buildV3LayerData', () => {
  it('chunks at the portal append cap', () => {
    const items = Array.from({ length: APPEND_BATCH_SIZE + 3 }, (_, i) => i);
    const batches = chunk(items, APPEND_BATCH_SIZE);
    assert.equal(batches.length, 2);
    assert.equal(batches[0]!.length, APPEND_BATCH_SIZE);
    assert.equal(batches[1]!.length, 3);
  });

  it('builds a single-sublayer v3 payload', () => {
    const data = buildV3LayerData({
      layerId: 'default',
      label: 'Sites',
      geometryType: 'point',
      fields: [{ name: 'name', label: 'Name', type: 'string', nullable: true }],
    });
    assert.equal(data.version, 3);
    assert.equal(data.layers[0]!.id, 'default');
    assert.equal(data.layers[0]!.geometryType, 'point');
  });
});

describe('isUuid', () => {
  it('accepts v4-shaped ids', () => {
    assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
    assert.equal(isUuid('not-a-uuid'), false);
  });
});

describe('appendInBatches', () => {
  const batches = [[{}], [{}], [{}]] as Parameters<typeof appendInBatches>[0];

  it('sums counts across batches', async () => {
    const out = await appendInBatches(batches, async () => ({ inserted: 1, deduplicated: 0 }));
    assert.deepEqual(out, { inserted: 3, deduplicated: 0, batchesDone: 3, batches: 3 });
  });

  it('stops at a failed batch and reports progress instead of throwing', async () => {
    let n = 0;
    const out = await appendInBatches(batches, async () => {
      n += 1;
      if (n === 2) throw new Error('GratisGIS 500: boom');
      return { inserted: 1 };
    });
    assert.equal(out.failedBatch, 2);
    assert.equal(out.batchesDone, 1);
    assert.equal(out.inserted, 1);
    assert.match(out.error!, /boom/);
    assert.equal(n, 2);
  });

  it('does not count a batch as inserted when the body has no count', async () => {
    const out = await appendInBatches(batches, async () => null);
    assert.equal(out.inserted, 0);
    assert.equal(out.batchesDone, 3);
  });
});

describe('capFeatureCollection', () => {
  const fc = { type: 'FeatureCollection', features: [1, 2, 3, 4, 5] };

  it('trims to the limit and says so', () => {
    assert.deepEqual(capFeatureCollection(fc, 2), {
      type: 'FeatureCollection',
      features: [1, 2],
      truncated: true,
      returned: 2,
      receivedFromPortal: 5,
    });
  });

  it('leaves a collection within the limit untouched', () => {
    assert.equal(capFeatureCollection(fc, 5), fc);
    assert.equal(capFeatureCollection(null, 5), null);
  });
});

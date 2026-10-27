// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  APPEND_BATCH_SIZE,
  buildV3LayerData,
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

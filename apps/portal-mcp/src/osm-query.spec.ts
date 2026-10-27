// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OSM_QUERY_DEFAULT_FEATURES,
  OSM_QUERY_MAX_BBOX_AREA_DEG2,
  buildOsmQueryPath,
  clientRejectOsmQuery,
} from './osm-query.js';

describe('clientRejectOsmQuery', () => {
  it('accepts a small preset query', () => {
    assert.equal(
      clientRejectOsmQuery({
        bbox: [-81.7, 38.3, -81.5, 38.4],
        presetIds: ['amenity_fuel'],
      }),
      null,
    );
  });

  it('refuses an oversized bbox', () => {
    const msg = clientRejectOsmQuery({
      bbox: [-82, 37, -80, 39],
      presetIds: ['amenity_fuel'],
    });
    assert.ok(msg);
    assert.match(msg!, new RegExp(String(OSM_QUERY_MAX_BBOX_AREA_DEG2)));
  });

  it('refuses presets mode without presetIds', () => {
    const msg = clientRejectOsmQuery({
      bbox: [0, 0, 0.1, 0.1],
      mode: 'presets',
    });
    assert.match(msg ?? '', /presetIds/);
  });

  it('refuses relational mode without conditions', () => {
    const msg = clientRejectOsmQuery({
      bbox: [0, 0, 0.1, 0.1],
      mode: 'relational',
      anchorPresetId: 'education_school',
    });
    assert.match(msg ?? '', /conditions/);
  });
});

describe('buildOsmQueryPath', () => {
  it('encodes bbox, presets, and default limit', () => {
    const path = buildOsmQueryPath({
      bbox: [-81.7, 38.3, -81.5, 38.4],
      presetIds: ['amenity_fuel', 'leisure_park'],
    });
    assert.ok(path.startsWith('/api/osm/query?'));
    const qs = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    assert.equal(qs.get('bbox'), '-81.7,38.3,-81.5,38.4');
    assert.equal(qs.get('presetIds'), 'amenity_fuel,leisure_park');
    assert.equal(qs.get('mode'), 'presets');
    assert.equal(qs.get('limit'), String(OSM_QUERY_DEFAULT_FEATURES));
  });

  it('encodes relational conditions as JSON', () => {
    const path = buildOsmQueryPath({
      bbox: [0, 0, 0.1, 0.1],
      mode: 'relational',
      anchorPresetId: 'education_school',
      conditions: [{ presetId: 'leisure_park', distanceMeters: 400 }],
      limit: 50,
    });
    const qs = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    assert.equal(qs.get('mode'), 'relational');
    assert.equal(qs.get('anchorPresetId'), 'education_school');
    assert.equal(qs.get('limit'), '50');
    assert.equal(
      qs.get('conditions'),
      JSON.stringify([{ presetId: 'leisure_park', distanceMeters: 400 }]),
    );
  });
});

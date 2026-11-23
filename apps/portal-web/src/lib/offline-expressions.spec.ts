// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MapLayer } from '@gratis-gis/shared-types';
import { applyOfflineExpressionFields, type OfflineSource } from './offline-expressions';

const ITEM = '11111111-1111-4111-8111-111111111111';

const nests: OfflineSource = {
  itemId: ITEM,
  layerKey: 'nests',
  label: 'Nests',
  fields: [{ name: 'code', label: 'code', type: 'string', nullable: true }],
  hasGeometry: true,
  features: [
    { type: 'Feature', id: 'n1', properties: { code: 'A' }, geometry: { type: 'Point', coordinates: [0, 0] } },
    { type: 'Feature', id: 'n2', properties: { code: 'B' }, geometry: { type: 'Point', coordinates: [1, 1] } },
  ],
};
const inspections: OfflineSource = {
  itemId: ITEM,
  layerKey: 'insp',
  label: 'Inspections',
  fields: [
    { name: 'nest_id', label: 'nest', type: 'string', nullable: true },
    { name: 'inspected_on', label: 'on', type: 'date', nullable: true },
  ],
  hasGeometry: false,
  parentFk: 'nest_id',
  features: [
    { type: 'Feature', id: 'i1', properties: { nest_id: 'n1', inspected_on: '2026-03-01' }, geometry: null as unknown as GeoJSON.Geometry },
    // Captured offline, not yet synced: counts straight away.
    { type: 'Feature', id: 'i2', properties: { nest_id: 'n1', inspected_on: '2026-11-20' }, geometry: null as unknown as GeoJSON.Geometry },
    { type: 'Feature', id: 'i3', properties: { nest_id: 'n2', inspected_on: '2026-01-05' }, geometry: null as unknown as GeoJSON.Geometry },
  ],
};

const layer = {
  expressions: [
    {
      name: 'visits',
      expression: "count(related('Inspections'))",
      dataRefs: [{ kind: 'related', name: 'Inspections', itemId: ITEM, layerId: 'insp' }],
    },
    {
      name: 'last',
      expression: "max(related('Inspections'), {{inspected_on}})",
      dataRefs: [{ kind: 'related', name: 'Inspections', itemId: ITEM, layerId: 'insp' }],
    },
    { name: 'shout', expression: "upper({{code}}) + '!'" },
    { name: 'broken', expression: "count(layer('Not cached'))" },
  ],
} as unknown as MapLayer;

describe('expression fields offline', () => {
  it('counts related records and finds the latest date from the cache', () => {
    const sources = new Map([
      [`${ITEM}:nests`, nests],
      [`${ITEM}:insp`, inspections],
    ]);
    const fc = applyOfflineExpressionFields(
      layer,
      { type: 'FeatureCollection', features: nests.features },
      nests,
      sources,
      'UTC',
    );
    const props = fc.features.map((f) => f.properties);
    expect(props[0]).toMatchObject({ 'expr.visits': 2, 'expr.last': '2026-11-20', 'expr.shout': 'A!' });
    expect(props[1]).toMatchObject({ 'expr.visits': 1, 'expr.last': '2026-01-05', 'expr.shout': 'B!' });
    // A source that is not on the device leaves its field out.
    expect(props[0]).not.toHaveProperty('expr.broken');
  });
});

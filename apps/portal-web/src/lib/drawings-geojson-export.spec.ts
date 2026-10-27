// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DrawingFeature, DrawingSet } from '@gratis-gis/shared-types';
import {
  drawingSetToFeatureCollection,
  sanitizeDrawingExportFilename,
} from './drawings-geojson-export';

const ts = '2026-10-27T00:00:00.000Z';

function feature(
  partial: Pick<DrawingFeature, 'id' | 'kind' | 'geometry'> &
    Partial<DrawingFeature>,
): DrawingFeature {
  return {
    createdAt: ts,
    updatedAt: ts,
    ...partial,
  };
}

function set(
  partial: Partial<DrawingSet> & Pick<DrawingSet, 'id' | 'features'>,
): Pick<
  DrawingSet,
  'id' | 'title' | 'color' | 'authorDisplay' | 'features'
> {
  return {
    id: partial.id,
    title: partial.title ?? "Alex's markup 2026-10-27",
    color: partial.color ?? '#ef4444',
    authorDisplay: partial.authorDisplay ?? 'Alex',
    features: partial.features,
  };
}

describe('drawingSetToFeatureCollection', () => {
  it('returns an empty FeatureCollection for no features', () => {
    const out = drawingSetToFeatureCollection(set({ id: 's1', features: [] }));
    expect(out).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('skips null geometry and stamps set provenance', () => {
    const out = drawingSetToFeatureCollection(
      set({
        id: 's1',
        title: 'Redline',
        color: '#22c55e',
        authorDisplay: 'Alex',
        features: [
          feature({
            id: 'f1',
            kind: 'pin',
            geometry: { type: 'Point', coordinates: [-80, 39] },
            label: 'Depot',
            note: 'Move east',
          }),
          feature({
            id: 'f2',
            kind: 'pin',
            geometry: null,
          }),
          feature({
            id: 'f3',
            kind: 'line',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-80, 39],
                [-80.1, 39.1],
              ],
            },
            style: { color: '#3b82f6' },
          }),
        ],
      }),
    );
    expect(out.features).toHaveLength(2);
    expect(out.features[0]).toEqual({
      type: 'Feature',
      id: 'f1',
      geometry: { type: 'Point', coordinates: [-80, 39] },
      properties: {
        kind: 'pin',
        label: 'Depot',
        note: 'Move east',
        color: '#22c55e',
        markup_set_id: 's1',
        markup_set_title: 'Redline',
        markup_author: 'Alex',
      },
    });
    expect(out.features[1]?.properties.color).toBe('#3b82f6');
    expect(out.features[1]?.properties.kind).toBe('line');
  });

  it('does not invent arrow-tip helper points', () => {
    const out = drawingSetToFeatureCollection(
      set({
        id: 's1',
        features: [
          feature({
            id: 'arrow1',
            kind: 'arrow',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-80, 39],
                [-79.9, 39.1],
              ],
            },
          }),
        ],
      }),
    );
    expect(out.features).toHaveLength(1);
    expect(out.features[0]?.id).toBe('arrow1');
    expect(out.features[0]?.properties.kind).toBe('arrow');
  });
});

describe('sanitizeDrawingExportFilename', () => {
  it('strips filesystem-unsafe characters', () => {
    expect(sanitizeDrawingExportFilename('Matt\'s markup 2026-10-27')).toBe(
      "Matt's markup 2026-10-27",
    );
    expect(sanitizeDrawingExportFilename('a/b:c*d?.geo')).toBe('abcd.geo');
    expect(sanitizeDrawingExportFilename('   ')).toBe('markup');
  });
});

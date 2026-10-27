// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DrawingFeature } from '@gratis-gis/shared-types';
import {
  arrowTip,
  flattenDrawingSets,
  type DrawingSetForRender,
} from './drawings-overlay';

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
  partial: Partial<DrawingSetForRender> & Pick<DrawingSetForRender, 'id'>,
): DrawingSetForRender {
  return {
    id: partial.id,
    color: partial.color ?? '#ef4444',
    visible: partial.visible ?? true,
    features: partial.features ?? [],
  };
}

describe('flattenDrawingSets', () => {
  it('returns an empty collection for no sets', () => {
    const out = flattenDrawingSets([]);
    expect(out.featureCollection.features).toEqual([]);
    expect(out.hiddenSetIds).toEqual([]);
  });

  it('stamps set color onto features and skips null geometry', () => {
    const out = flattenDrawingSets([
      set({
        id: 'a',
        color: '#00ff00',
        features: [
          feature({
            id: 'f1',
            kind: 'pin',
            geometry: { type: 'Point', coordinates: [-80, 39] },
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
            style: { color: '#0000ff', strokeWidth: 5 },
          }),
        ],
      }),
    ]);
    expect(out.featureCollection.features).toHaveLength(2);
    const [pin, line] = out.featureCollection.features;
    expect(pin?.properties).toMatchObject({
      setId: 'a',
      color: '#00ff00',
      kind: 'pin',
    });
    expect(line?.properties).toMatchObject({
      setId: 'a',
      color: '#0000ff',
      strokeWidth: 5,
      kind: 'line',
    });
    expect(out.hiddenSetIds).toEqual([]);
  });

  it('lists hidden set ids without dropping their features from the FC', () => {
    const out = flattenDrawingSets([
      set({
        id: 'vis',
        visible: true,
        features: [
          feature({
            id: 'p1',
            kind: 'pin',
            geometry: { type: 'Point', coordinates: [0, 0] },
          }),
        ],
      }),
      set({
        id: 'hid',
        visible: false,
        features: [
          feature({
            id: 'p2',
            kind: 'pin',
            geometry: { type: 'Point', coordinates: [1, 1] },
          }),
        ],
      }),
    ]);
    expect(out.hiddenSetIds).toEqual(['hid']);
    expect(out.featureCollection.features.map((f) => f.id)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('emits an arrow-head tip point for arrow features', () => {
    const out = flattenDrawingSets([
      set({
        id: 'a',
        features: [
          feature({
            id: 'arr1',
            kind: 'arrow',
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [0, 1],
              ],
            },
            label: 'go',
          }),
          feature({
            id: 'txt1',
            kind: 'text',
            geometry: { type: 'Point', coordinates: [2, 2] },
            label: 'Depot',
          }),
        ],
      }),
    ]);
    expect(out.featureCollection.features.map((f) => f.id)).toEqual([
      'arr1',
      'arr1:tip',
      'txt1',
    ]);
    const tip = out.featureCollection.features[1];
    expect(tip?.properties).toMatchObject({
      kind: 'arrow-head',
      bearing: 0,
    });
    expect(tip?.geometry).toEqual({ type: 'Point', coordinates: [0, 1] });
    expect(out.featureCollection.features[2]?.properties).toMatchObject({
      kind: 'text',
      label: 'Depot',
    });
  });
});

describe('arrowTip', () => {
  it('returns null for non-lines', () => {
    expect(arrowTip({ type: 'Point', coordinates: [0, 0] })).toBeNull();
  });

  it('computes bearing east as ~90', () => {
    const tip = arrowTip({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 0],
      ],
    });
    expect(tip?.coordinates).toEqual([1, 0]);
    expect(tip?.bearing).toBeCloseTo(90, 5);
  });
});

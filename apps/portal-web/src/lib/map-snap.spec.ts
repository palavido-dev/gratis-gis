// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MapFeatureSnapper,
  isSnappableStyleLayer,
  nearestSnap,
  coordKey,
  placedSnapVertices,
  roundCoord,
  type LngLat,
  type SnapMap,
} from './map-snap';

// A flat "projection": one degree is ten pixels, y grows downward.
const project = (c: LngLat) => ({ x: c[0] * 10, y: -c[1] * 10 });
const unproject = (p: { x: number; y: number }): LngLat => [p.x / 10, -p.y / 10];
const opts = { project, unproject, radiusPx: 5 };

describe('nearestSnap', () => {
  it('snaps to a vertex of another feature within the radius', () => {
    const hit = nearestSnap({ x: 12, y: -12 }, [{ type: 'Point', coordinates: [1, 1] }], opts);
    expect(hit).toEqual({ coordinate: [1, 1], index: 0, kind: 'vertex' });
  });

  it('returns nothing when every feature is beyond the radius', () => {
    expect(nearestSnap({ x: 40, y: -40 }, [{ type: 'Point', coordinates: [1, 1] }], opts)).toBe(
      undefined,
    );
  });

  it('prefers a vertex over a closer edge', () => {
    const line: GeoJSON.LineString = {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [2, 0],
      ],
    };
    const pt: GeoJSON.Point = { type: 'Point', coordinates: [1.3, 0.3] };
    // The edge is 1 px away, the point 3.6 px; the vertex still wins.
    const hit = nearestSnap({ x: 11, y: -1 }, [line, pt], opts);
    expect(hit?.kind).toBe('vertex');
    expect(hit?.index).toBe(1);
  });

  it('falls back to the nearest point on an edge', () => {
    const square: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    };
    const hit = nearestSnap({ x: 20, y: -2 }, [square], opts);
    expect(hit?.kind).toBe('edge');
    expect(hit?.coordinate[0]).toBeCloseTo(2);
    expect(hit?.coordinate[1]).toBeCloseTo(0);
  });

  it('picks the nearest of several features on different layers', () => {
    const hit = nearestSnap(
      { x: 10, y: -10 },
      [
        { type: 'Point', coordinates: [1.4, 1] },
        { type: 'Point', coordinates: [1.1, 1] },
      ],
      opts,
    );
    expect(hit?.index).toBe(1);
  });
});

describe('isSnappableStyleLayer', () => {
  it('keeps geometry layers of operational map layers only', () => {
    expect(isSnappableStyleLayer('gg:abc-fill')).toBe(true);
    expect(isSnappableStyleLayer('gg:abc-circle')).toBe(true);
    expect(isSnappableStyleLayer('gg:abc-label')).toBe(false);
    expect(isSnappableStyleLayer('gg:abc-label-pt')).toBe(false);
    expect(isSnappableStyleLayer('td-polygon')).toBe(false);
    expect(isSnappableStyleLayer('gg-snap-live')).toBe(false);
    expect(isSnappableStyleLayer('water')).toBe(false);
  });
});

describe('placedSnapVertices', () => {
  it('marks only the vertices that landed on a snap', () => {
    const snapped = new Set([coordKey([1, 1]), coordKey([9, 9])]);
    const out = placedSnapVertices(
      [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
              [2, 2],
            ],
          },
        },
        { geometry: { type: 'Point', coordinates: [1, 1] } },
      ],
      snapped,
    );
    expect(out).toEqual([[1, 1]]);
  });
});

describe('coordKey', () => {
  it('treats the same point rounded two ways as one', () => {
    // A few ulps apart, as two rounding paths leave the same point.
    expect(coordKey([107.172300071 - 1e-12, -6.2864000259])).toBe(
      coordKey([107.172300071, -6.286400026]),
    );
  });
});

describe('roundCoord', () => {
  it('rounds both axes to the given precision', () => {
    expect(roundCoord([1.23456789, -2.98765432], 4)).toEqual([1.2346, -2.9877]);
  });
});

describe('MapFeatureSnapper', () => {
  function fakeMap(
    rendered: Array<{ geometry: GeoJSON.Geometry; properties?: Record<string, unknown> }>,
  ) {
    const sources = new Map<
      string,
      { data: GeoJSON.FeatureCollection; setData(d: GeoJSON.FeatureCollection): void }
    >();
    const layers: string[] = [];
    const map: SnapMap = {
      getStyle: () => ({ layers: [{ id: 'gg:trees-circle' }, { id: 'gg:trees-label' }] }),
      queryRenderedFeatures: (_box, o) => {
        expect(o.layers).toEqual(['gg:trees-circle']);
        return rendered;
      },
      project,
      unproject: ([x, y]) => {
        const [lng, lat] = unproject({ x, y });
        return { lng, lat };
      },
      getSource: (id) => sources.get(id),
      addSource: (id, s) => {
        const src = {
          data: (s as { data: GeoJSON.FeatureCollection }).data,
          setData(d: GeoJSON.FeatureCollection) {
            this.data = d;
          },
        };
        sources.set(id, src);
      },
      removeSource: (id) => sources.delete(id),
      getLayer: (id) => (layers.includes(id) ? {} : undefined),
      addLayer: (l) => layers.push((l as { id: string }).id),
      removeLayer: (id) => layers.splice(layers.indexOf(id), 1),
    };
    const roles = () =>
      (sources.get('gg-snap-indicator')?.data.features ?? []).map((f) => f.properties?.role);
    return { map, roles, layers };
  }

  it('snaps to a rendered feature and marks the target and the snap point', () => {
    const { map, roles } = fakeMap([{ geometry: { type: 'Point', coordinates: [1, 1] } }]);
    const s = new MapFeatureSnapper(map, 6, 5);
    expect(s.snap({ containerX: 11, containerY: -11 })).toEqual([1, 1]);
    expect(roles()).toEqual(['target', 'live']);
  });

  it('keeps a placed snapped vertex marked until the session resets', () => {
    const { map, roles } = fakeMap([{ geometry: { type: 'Point', coordinates: [1, 1] } }]);
    const s = new MapFeatureSnapper(map, 6, 5);
    s.snap({ containerX: 11, containerY: -11 });
    s.clearLive();
    s.refreshPlaced([{ geometry: { type: 'Point', coordinates: [1, 1] } }]);
    expect(roles()).toEqual(['placed']);
    s.reset();
    expect(roles()).toEqual([]);
  });

  it('does not snap the reshaped feature onto its own old copy', () => {
    const { map } = fakeMap([
      { geometry: { type: 'Point', coordinates: [1, 1] }, properties: { _global_id: 'f1' } },
    ]);
    const s = new MapFeatureSnapper(map, 6, 5);
    expect(s.snap({ containerX: 11, containerY: -11 }, { currentId: 'f1' })).toBeUndefined();
  });
});

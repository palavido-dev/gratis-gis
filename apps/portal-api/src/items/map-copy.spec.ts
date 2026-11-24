// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapDataForCopy, mapDataWithoutReferences } from './map-copy.js';

const customAccess = {
  policy: 'custom',
  entries: [
    { principalType: 'group', principalId: 'g1', view: true, query: true, edit: false },
  ],
};

function source() {
  return {
    version: 1,
    basemap: 'b1',
    center: [0, 0],
    zoom: 3,
    layers: [
      {
        id: 'l1',
        title: 'Parcels',
        access: customAccess,
        effective: { view: true, query: true, edit: false },
      },
      { id: 'l2', title: 'Roads', access: { policy: 'inherit', entries: [] } },
    ],
    drawings: [
      { id: 'd1', authorId: null, anonymousAuthorToken: 'secret', features: [] },
      { id: 'd2', authorId: 'u1', features: [] },
    ],
    allowAnonymousDrawings: true,
  };
}

describe('mapDataForCopy', () => {
  it('keeps layer access for a caller who can edit the source', () => {
    const out = mapDataForCopy(source(), { includeMarkup: false, sourceEditable: true });
    const layers = out.layers as Array<Record<string, unknown>>;
    expect(layers[0]!.access).toEqual(customAccess);
    expect(layers[0]).not.toHaveProperty('effective');
  });

  it('resets custom access to inherit for a view-only caller', () => {
    const viewerCopy = source();
    viewerCopy.layers[0]!.access = { policy: 'custom', entries: [] };
    const out = mapDataForCopy(viewerCopy, { includeMarkup: false, sourceEditable: false });
    const layers = out.layers as Array<Record<string, unknown>>;
    expect(layers[0]!.access).toEqual({ policy: 'inherit', entries: [] });
    expect(layers[0]).not.toHaveProperty('effective');
    expect(layers[1]!.access).toEqual({ policy: 'inherit', entries: [] });
  });

  it('drops markup unless asked, and never copies the anonymous token', () => {
    expect(
      mapDataForCopy(source(), { includeMarkup: false, sourceEditable: true }),
    ).not.toHaveProperty('drawings');
    const out = mapDataForCopy(source(), { includeMarkup: true, sourceEditable: true });
    const drawings = out.drawings as Array<Record<string, unknown>>;
    expect(drawings.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(drawings[0]).not.toHaveProperty('anonymousAuthorToken');
  });

  it('turns off anonymous markup on the copy', () => {
    const out = mapDataForCopy(source(), { includeMarkup: true, sourceEditable: true });
    expect(out).not.toHaveProperty('allowAnonymousDrawings');
  });

  it('keeps the rest of the map as it is', () => {
    const out = mapDataForCopy(source(), { includeMarkup: false, sourceEditable: true });
    expect(out).toMatchObject({ version: 1, basemap: 'b1', center: [0, 0], zoom: 3 });
  });

  it('drops layer entries that are not objects', () => {
    const bad = { ...source(), layers: [null, 'x', { id: 'ok' }] } as unknown as Record<
      string,
      unknown
    >;
    const out = mapDataForCopy(bad, { includeMarkup: false, sourceEditable: true });
    expect(out.layers).toEqual([{ id: 'ok' }]);
  });
});

describe('mapDataWithoutReferences', () => {
  const HIDDEN = '00000000-0000-4000-8000-0000000000a1';
  const SEEN = '00000000-0000-4000-8000-0000000000b1';
  const OTHER = '00000000-0000-4000-8000-0000000000c1';

  it('leaves out what names a dropped id and keeps the rest', () => {
    const out = mapDataWithoutReferences(
      {
        basemap: HIDDEN,
        clipBoundaryId: HIDDEN,
        defaultExtentBoundaryId: SEEN,
        geocoderId: HIDDEN,
        terrain: {
          itemId: HIDDEN,
          tileUrl: 'hidden',
          stack: [
            { itemId: HIDDEN, tileUrl: 'hidden' },
            { itemId: OTHER, tileUrl: 'other' },
          ],
        },
        layers: [
          { id: 'gone', source: { kind: 'data-layer', itemId: HIDDEN, layerKey: 'k' } },
          { id: 'clipped', source: { kind: 'data-layer', itemId: SEEN }, boundaryFilterItemId: HIDDEN },
          {
            id: 'arcgis',
            source: { kind: 'arcgis-rest', url: 'https://example.test/FeatureServer/0', sourceItemId: HIDDEN },
          },
          { id: 'kept', source: { kind: 'data-layer', itemId: SEEN, layerKey: 'k' } },
        ],
      },
      new Set([HIDDEN]),
    );
    expect(out.basemap).toBe('');
    expect(out).not.toHaveProperty('clipBoundaryId');
    expect(out).not.toHaveProperty('geocoderId');
    expect(out.defaultExtentBoundaryId).toBe(SEEN);
    expect(out.terrain).toEqual({
      itemId: OTHER,
      tileUrl: 'other',
      stack: [{ itemId: OTHER, tileUrl: 'other' }],
    });
    const layers = out.layers as Array<{ id: string; source: Record<string, unknown> }>;
    expect(layers.map((l) => l.id)).toEqual(['arcgis', 'kept']);
    expect(layers[0]!.source).not.toHaveProperty('sourceItemId');
    expect(JSON.stringify(out)).not.toContain(HIDDEN);
  });

  it('removes terrain when nothing in it remains', () => {
    const out = mapDataWithoutReferences(
      { terrain: { itemId: HIDDEN, tileUrl: 'x', stack: [{ itemId: HIDDEN, tileUrl: 'x' }] } },
      new Set([HIDDEN]),
    );
    expect(out).not.toHaveProperty('terrain');
  });
});

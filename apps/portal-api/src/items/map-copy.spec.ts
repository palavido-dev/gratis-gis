// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapDataForCopy } from './map-copy.js';

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

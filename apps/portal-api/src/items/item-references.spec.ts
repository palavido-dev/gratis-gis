// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  addedReferenceIds,
  assertAddedReferencesReadable,
  mapLayerElevationHintIds,
  referencedItemIds,
  withoutMapLayerElevationHints,
  withoutReferences,
} from './item-references.js';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const D = '00000000-0000-4000-8000-0000000000d1';

describe('referencedItemIds', () => {
  it('finds map references beyond layers', () => {
    const ids = referencedItemIds({
      type: 'map',
      data: {
        basemap: A,
        defaultExtentBoundaryId: B,
        clipBoundaryId: C,
        geocoderId: D,
        terrain: { itemId: A, stack: [{ itemId: B, tileUrl: 'x' }] },
        layers: [
          {
            id: 'l1',
            source: { kind: 'data-layer', itemId: C, layerKey: 'k' },
            boundaryFilterItemId: D,
            via: { parentItemId: A, parentLayerId: 'p', myField: 'a', parentField: 'b' },
          },
        ],
      },
    });
    expect(new Set(ids)).toEqual(new Set([A, B, C, D]));
  });

  it('leaves out built-in names and server-owned expression refs', () => {
    const ids = referencedItemIds({
      type: 'map',
      data: {
        basemap: 'positron',
        layers: [
          {
            id: 'l1',
            source: { kind: 'geojson-url', url: 'https://example.test/a.geojson' },
            expressions: [{ expression: 'x', dataRefs: [{ itemId: A }] }],
          },
        ],
      },
    });
    expect(ids).toEqual([]);
  });

  it('keeps a malformed map layer item id so it cannot slip past the check', () => {
    const ids = referencedItemIds({
      type: 'map',
      data: { layers: [{ id: 'l1', source: { kind: 'data-layer', itemId: 'nope' } }] },
    });
    expect(ids).toEqual(['nope']);
  });

  it('covers app, widget, tool and template references', () => {
    const app = referencedItemIds({
      type: 'web_app',
      data: {
        template: 'custom',
        config: {
          custom: {
            mapId: A,
            pages: [
              {
                widgets: [
                  { config: { kind: 'button', linkKind: 'tool', toolId: B } },
                  { config: { kind: 'print', templateIds: [C] } },
                ],
              },
            ],
          },
        },
      },
    });
    expect(new Set(app)).toEqual(new Set([A, B, C]));
    expect(
      referencedItemIds({ type: 'tool', data: { action: { kind: 'open-item', targetItemId: D } } }),
    ).toEqual([D]);
    expect(referencedItemIds({ type: 'print_template', data: { defaultMapId: A } })).toEqual([A]);
  });

  it('covers folders, collections, reports, elevation and geocoder sources', () => {
    expect(referencedItemIds({ type: 'folder', data: { childItemIds: [A, 'x'] } })).toEqual([A]);
    expect(
      new Set(
        referencedItemIds({
          type: 'data_collection',
          data: { mapId: A, formBindings: { k: { formItemId: B } } },
        }),
      ),
    ).toEqual(new Set([A, B]));
    expect(
      referencedItemIds({ type: 'report_template', data: { sources: [{ itemId: C }] } }),
    ).toEqual([C]);
    expect(
      referencedItemIds({ type: 'tile_layer', data: { preferredElevationItemId: D } }),
    ).toEqual([D]);
    expect(referencedItemIds({ type: 'geocoding_service', data: { sourceLayerId: A } })).toEqual([
      A,
    ]);
  });

  it('includes the tier geo boundary columns', () => {
    expect(
      new Set(
        referencedItemIds({
          type: 'data_layer',
          data: {},
          publicGeoBoundaryId: A,
          orgGeoBoundaryId: B,
        }),
      ),
    ).toEqual(new Set([A, B]));
  });
});

describe('addedReferenceIds', () => {
  it('returns only ids that are not stored, once each', () => {
    expect(addedReferenceIds([A], [A, B, B, C])).toEqual([B, C]);
    expect(addedReferenceIds([A.toUpperCase()], [A])).toEqual([]);
  });
});

describe('assertAddedReferencesReadable', () => {
  const lookup = jest.fn(
    async (_user: string, ids: string[]) => new Set(ids.filter((id) => id === C)),
  );

  beforeEach(() => lookup.mockClear());

  it('makes no lookup when nothing was added', async () => {
    await assertAddedReferencesReadable(lookup, 'u', [A, C], [A, C]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('keeps a stored reference the author can no longer read', async () => {
    await expect(assertAddedReferencesReadable(lookup, 'u', [C], [C, A])).resolves.toEqual(
      new Set(),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('u', [A]);
  });

  it('refuses a new reference the author cannot read, in one lookup', async () => {
    await expect(assertAddedReferencesReadable(lookup, 'u', [], [A, B, C])).rejects.toThrow(
      new BadRequestException(`Referenced item ${C} was not found.`),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('withoutReferences', () => {
  it('removes keyed references and list entries naming a dropped id', () => {
    const out = withoutReferences(
      { mapId: A, childItemIds: [A, B], nested: { toolId: A, keep: A } },
      new Set([A]),
    );
    expect(out).toEqual({ childItemIds: [B], nested: { keep: A } });
  });
});

describe('map layer elevation hints', () => {
  const map = {
    layers: [
      { id: 't1', source: { kind: 'tile', itemId: A, preferredElevationItemId: B } },
      { id: 't2', source: { kind: 'tile', itemId: C, preferredElevationItemId: D } },
    ],
  };

  it('are not references a save refuses', () => {
    expect(new Set(referencedItemIds({ type: 'map', data: map }))).toEqual(new Set([A, C]));
    expect(new Set(mapLayerElevationHintIds(map))).toEqual(new Set([B, D]));
  });

  it('still count on a tile layer or point cloud item itself', () => {
    expect(
      referencedItemIds({ type: 'tile_layer', data: { preferredElevationItemId: B } }),
    ).toEqual([B]);
  });

  it('are removed for the ids given, and only those', () => {
    const out = withoutMapLayerElevationHints(map, new Set([B])) as typeof map;
    expect(out.layers[0]!.source).toEqual({ kind: 'tile', itemId: A });
    expect(out.layers[1]!.source.preferredElevationItemId).toBe(D);
  });

  it('share the one lookup and are dropped, not refused', async () => {
    const lookup = jest.fn(
      async (_u: string, ids: string[]) => new Set(ids.filter((id) => id === B)),
    );
    const drop = await assertAddedReferencesReadable(lookup, 'u', [], [A], [B, D]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('u', [A, B, D]);
    expect([...drop]).toEqual([B]);
  });

  it('are not looked up again when already stored', async () => {
    const lookup = jest.fn(async () => new Set<string>([B]));
    const drop = await assertAddedReferencesReadable(lookup, 'u', [B], [], [B]);
    expect(lookup).not.toHaveBeenCalled();
    expect(drop.size).toBe(0);
  });
});

describe('withoutReferences on an app', () => {
  it('drops targets and sources of a dropped layer whole', () => {
    const out = withoutReferences(
      {
        config: {
          custom: {
            mapId: A,
            targets: [
              { dataLayerId: A, layerKey: 'k' },
              { dataLayerId: B, layerKey: 'k' },
            ],
            sources: [{ id: 's1', layer: { dataLayerId: A, layerKey: 'k' } }],
          },
        },
      },
      new Set([A]),
    );
    expect(out).toEqual({
      config: { custom: { targets: [{ dataLayerId: B, layerKey: 'k' }], sources: [] } },
    });
  });
});

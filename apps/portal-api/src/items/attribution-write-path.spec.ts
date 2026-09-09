// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * The write half of the attribution XSS fix.
 *
 * `data_json.attribution` is rendered as HTML by MapLibre's
 * AttributionControl, whose internal sanitizer carries a bypass in every
 * maplibre-gl at or below 6.4.0 (GHSA-jrc7-96c5-q579). We are pinned to
 * 5.24.0 because maplibre 6 removed `Map.transform` and @deck.gl/mapbox
 * still reads it, so the exposure is closed at the source instead: the
 * value is sanitized on the way into the database.
 *
 * `ItemsService.create` and `.update` are the authoritative point
 * because they are the only two ways an item's data_json changes.
 * Everything else routes through one of them, including
 * `TileLayerService.finalizeUpload`, which lifts an attribution out of
 * an uploaded PMTiles header and PATCHes it through `update`.
 *
 * These follow `create-authz.spec.ts` and stand up a bare service with
 * hand-assigned collaborators rather than Nest and Prisma. The assertion
 * is about what reaches `prisma.item.create` / `.update`, so capturing
 * that one call is the sharpest way to state it.
 */

const PAYLOAD = '<img src=x onerror=alert(document.domain)>';

function contributor(): AuthUser {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    orgRole: 'contributor',
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES.contributor),
  } as unknown as AuthUser;
}

/** Captures whatever the service hands Prisma. */
interface Captured {
  data?: unknown;
}

function serviceForCreate(captured: Captured): ItemsService {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  Object.assign(svc, {
    prisma: {
      item: {
        create: async (args: {
          data: { data?: unknown; type?: unknown; title?: unknown };
        }) => {
          captured.data = args.data.data;
          return {
            id: 'item-1',
            type: args.data.type,
            title: args.data.title,
            data: args.data.data,
            updatedAt: new Date(),
            thumbnailUrl: null,
            thumbnailDesign: null,
          };
        },
      },
    },
  });
  return svc;
}

function serviceForUpdate(
  captured: Captured,
  existing: { type: string; data: unknown },
): ItemsService {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const row = {
    id: 'item-1',
    orgId: '00000000-0000-0000-0000-0000000000bb',
    type: existing.type,
    title: 'Basemap',
    tags: [],
    data: existing.data,
    updatedAt: new Date(),
  };
  Object.assign(svc, {
    get: async () => row,
    sharing: { canEdit: () => true },
    prisma: {
      itemShare: { findMany: async () => [] },
      item: {
        update: async (args: { data: { data?: unknown } }) => {
          captured.data = args.data.data;
          return { ...row, ...args.data };
        },
      },
    },
  });
  return svc;
}

describe('ItemsService.create sanitizes attribution', () => {
  it('escapes a script-bearing attribution on a basemap item', async () => {
    const captured: Captured = {};
    await serviceForCreate(captured).create(contributor(), {
      type: 'basemap',
      title: 'Hostile',
      data: {
        version: 1,
        kind: 'tile-url',
        tileUrl: 'https://tile.example.org/{z}/{x}/{y}.png',
        attribution: PAYLOAD,
      },
    } as never);
    const stored = captured.data as { attribution: string };
    expect(stored.attribution).not.toContain('<img');
    expect(stored.attribution).toContain('&lt;img');
  });

  it('refuses a javascript: attribution link but keeps it visible', async () => {
    const captured: Captured = {};
    await serviceForCreate(captured).create(contributor(), {
      type: 'basemap',
      title: 'Hostile',
      data: {
        version: 1,
        kind: 'tile-url',
        tileUrl: 'https://tile.example.org/{z}/{x}/{y}.png',
        attribution: '<a href="javascript:alert(1)">County GIS</a>',
      },
    } as never);
    const stored = captured.data as { attribution: string };
    expect(stored.attribution).not.toMatch(/<a\s/);
    // Escaped rather than dropped, so the author can see what happened.
    expect(stored.attribution).toContain('County GIS');
  });

  it('keeps a legitimate attribution link and forces rel/target', async () => {
    const captured: Captured = {};
    await serviceForCreate(captured).create(contributor(), {
      type: 'basemap',
      title: 'OSM',
      data: {
        version: 1,
        kind: 'tile-url',
        tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    } as never);
    const stored = captured.data as { attribution: string };
    expect(stored.attribution).toBe(
      '© <a href="https://www.openstreetmap.org/copyright" ' +
        'target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    );
  });

  it('cleans an attribution nested in a map layer source', async () => {
    // A map stamps the tile_layer item's attribution onto its own saved
    // layer at add time, so the field is not always at the top level. A
    // per-type list of paths would have missed this one.
    const captured: Captured = {};
    await serviceForCreate(captured).create(contributor(), {
      type: 'map',
      title: 'Map',
      data: {
        basemap: 'some-uuid',
        layers: [
          {
            id: 'l1',
            source: { kind: 'tile', itemId: 'x', attribution: PAYLOAD },
          },
        ],
      },
    } as never);
    const stored = captured.data as {
      layers: Array<{ source: { attribution: string } }>;
    };
    expect(stored.layers[0]?.source.attribution).not.toContain('<img');
    expect(stored.layers[0]?.source.attribution).toContain('&lt;img');
  });

  it('leaves a data blob with no attribution untouched', async () => {
    const captured: Captured = {};
    const data = { version: 3, storageType: 'postgis', layers: [] };
    await serviceForCreate(captured).create(contributor(), {
      type: 'data_layer',
      title: 'Layer',
      data,
    } as never);
    // Same reference, not a deep copy: a save that changes no
    // attribution should not pay to rebuild the blob.
    expect(captured.data).toBe(data);
  });
});

describe('ItemsService.update sanitizes attribution', () => {
  it('escapes a script-bearing attribution on a basemap patch', async () => {
    const captured: Captured = {};
    const svc = serviceForUpdate(captured, {
      type: 'basemap',
      data: { version: 1, kind: 'tile-url', attribution: 'clean' },
    });
    await svc.update(contributor(), 'item-1', {
      data: {
        version: 1,
        kind: 'tile-url',
        tileUrl: 'https://tile.example.org/{z}/{x}/{y}.png',
        attribution: PAYLOAD,
      },
    } as never);
    const stored = captured.data as { attribution: string };
    expect(stored.attribution).not.toContain('<img');
    expect(stored.attribution).toContain('&lt;img');
  });

  it('cleans the attribution a tile_layer finalize lifts from a PMTiles header', async () => {
    // TileLayerService.finalizeUpload PATCHes through this method, so
    // an archive whose metadata carries markup is covered here and
    // nowhere else.
    const captured: Captured = {};
    const svc = serviceForUpdate(captured, { type: 'tile_layer', data: {} });
    await svc.update(contributor(), 'item-1', {
      data: {
        kind: 'raster',
        tileUrl: 'pmtiles:///api/portal/tile-layer/item-1/file',
        attribution: '<svg/onload=alert(1)>Imagery',
      },
    } as never);
    const stored = captured.data as { attribution: string };
    expect(stored.attribution).not.toContain('<svg');
    expect(stored.attribution).toContain('Imagery');
  });

  it('is a no-op on a metadata-only patch', async () => {
    const captured: Captured = {};
    const svc = serviceForUpdate(captured, {
      type: 'basemap',
      data: { version: 1, kind: 'tile-url', attribution: 'clean' },
    });
    await svc.update(contributor(), 'item-1', { title: 'Renamed' } as never);
    expect(captured.data).toBeUndefined();
  });
});

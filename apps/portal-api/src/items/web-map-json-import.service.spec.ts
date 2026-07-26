// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '@prisma/client';
import type { EsriWebMap } from '@gratis-gis/engine';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { WebMapJsonImportService } from './web-map-json-import.service.js';

/**
 * The import service does three things at the boundary:
 *   1. Calls webMapJsonToLenses on the engine package (covered by
 *      its own spec)
 *   2. Resolves URLs back to portal MapLayer sources
 *   3. Calls ItemsService.create with the resulting MapData
 *
 * These tests pin (2) and (3): the URL classification rules + the
 * shape of the MapData payload that lands in the new map item.
 * ItemsService is stubbed (`create` returns a fixed id); the
 * Prisma client is stubbed for the org-arcgis-item lookup and the
 * basemap match.
 */

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

function makePrismaMock(opts: {
  arcgisItems?: Array<{ id: string; data: { url?: string } }>;
  basemapItems?: Array<{ id: string; data: { tileUrl?: string } }>;
} = {}) {
  return {
    item: {
      findMany: async (args: { where: { type: string } }) => {
        if (args.where.type === 'arcgis_service') {
          return opts.arcgisItems ?? [];
        }
        if (args.where.type === 'basemap') {
          return opts.basemapItems ?? [];
        }
        return [];
      },
    },
  } as unknown as ConstructorParameters<typeof WebMapJsonImportService>[0];
}

function makeItemsMock(): {
  service: ConstructorParameters<typeof WebMapJsonImportService>[1];
  lastCreate: { args: unknown };
} {
  const lastCreate: { args: unknown } = { args: undefined };
  const service = {
    create: async (_user: AuthUser, args: unknown) => {
      lastCreate.args = args;
      return { id: 'item-new', orgId: 'org-1' } as unknown as Item;
    },
  } as unknown as ConstructorParameters<typeof WebMapJsonImportService>[1];
  return { service, lastCreate };
}

const baseWebMap: EsriWebMap = {
  version: '2.32',
  authoringApp: 'Esri ArcGIS Online',
  authoringAppVersion: '2025.1',
  baseMap: {
    title: 'Streets',
    baseMapLayers: [
      {
        id: 'bm-1',
        title: 'Streets',
        url: 'https://basemaps.example.org/streets/{z}/{x}/{y}.png',
      },
    ],
  },
  initialState: {
    viewpoint: {
      targetGeometry: {
        xmin: -122.5,
        ymin: 37.7,
        xmax: -122.3,
        ymax: 37.9,
        spatialReference: { wkid: 4326 },
      },
      scale: 100000,
    },
  },
  operationalLayers: [
    {
      id: 'roads',
      title: 'Roads',
      url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer/0',
      layerType: 'ArcGISFeatureLayer',
    },
    {
      id: 'parcels-mapserver',
      title: 'Parcels',
      url: 'https://services.example.com/arcgis/rest/services/Parcels/MapServer/3',
      layerType: 'ArcGISFeatureLayer',
    },
    {
      id: 'public-points',
      title: 'Public POIs',
      url: 'https://example.com/data/poi.geojson',
      layerType: 'ArcGISFeatureLayer',
    },
  ],
};

describe('WebMapJsonImportService', () => {
  it('creates a map item with one MapLayer per recognised operational layer, stack order flipped', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const result = await svc.import({
      user: makeUser(),
      webMap: baseWebMap,
    });
    expect(result.itemId).toBe('item-new');
    expect(result.layerCount).toBe(3);
    expect(result.skippedLayerCount).toBe(0);
    const args = items.lastCreate.args as {
      type: string;
      data: { layers: Array<{ title: string; source: { kind: string } }> };
    };
    expect(args.type).toBe('map');
    expect(args.data.layers).toHaveLength(3);
    // Esri draws operationalLayers[0] first (bottom of the stack);
    // MapData.layers[0] is the portal render stack's TOP. The
    // importer flips the document order so the imported map stacks
    // like the source: the WebMap's LAST layer lands at index 0.
    const kinds = args.data.layers.map((l) => l.source.kind);
    expect(kinds).toEqual(['geojson-url', 'arcgis-rest', 'arcgis-rest']);
    expect(args.data.layers.map((l) => l.title)).toEqual([
      'Public POIs',
      'Parcels',
      'Roads',
    ]);
  });

  it('parses out FeatureServer / MapServer layer ids', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: {
        layers: Array<{
          source: {
            kind: string;
            url?: string;
            layerId?: number;
            serviceType?: string;
          };
        }>;
      };
    };
    // Indexes are the reverse of the WebMap document order.
    expect(args.data.layers[2]?.source).toEqual({
      kind: 'arcgis-rest',
      url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer',
      layerId: 0,
      serviceType: 'FeatureServer',
    });
    expect(args.data.layers[1]?.source).toEqual({
      kind: 'arcgis-rest',
      url: 'https://services.example.com/arcgis/rest/services/Parcels/MapServer',
      layerId: 3,
      serviceType: 'MapServer',
    });
    expect(args.data.layers[0]?.source).toEqual({
      kind: 'geojson-url',
      url: 'https://example.com/data/poi.geojson',
    });
  });

  it('resolves portal per-sublayer URLs back into data-layer sources', async () => {
    // The exact URL shapes our own exporter emits. Re-importing an
    // exported portal map must land portal-rooted layers, not
    // opaque URL layers (the old /api/lenses emission made the
    // importer reject its own export outright).
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'portal-geojson',
          title: 'Parcels',
          url: 'https://portal.example.org/api/items/dl-1/layers/lyr_a/geojson',
          layerType: 'ArcGISFeatureLayer',
        },
        {
          id: 'portal-tiles',
          title: 'Big parcels',
          url: 'https://portal.example.org/api/items/dl-2/layers/lyr_b/tile/{z}/{x}/{y}.mvt',
          layerType: 'VectorTileLayer',
        },
      ],
    };
    const result = await svc.import({ user: makeUser(), webMap: wm });
    expect(result.layerCount).toBe(2);
    expect(result.skippedLayerCount).toBe(0);
    const args = items.lastCreate.args as {
      data: { layers: Array<{ source: unknown }> };
    };
    // Reversed: the tile layer was the document's last entry, so it
    // imports at index 0 (top of the portal stack).
    expect(args.data.layers[0]?.source).toEqual({
      kind: 'data-layer',
      itemId: 'dl-2',
      layerKey: 'lyr_b',
    });
    expect(args.data.layers[1]?.source).toEqual({
      kind: 'data-layer',
      itemId: 'dl-1',
      layerKey: 'lyr_a',
    });
  });

  it('back-references the org\'s arcgis_service item when URL matches', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(
      makePrismaMock({
        arcgisItems: [
          {
            id: 'arcgis-portal-1',
            data: {
              url: 'https://services.example.com/arcgis/rest/services/Transport/FeatureServer/0',
            },
          },
        ],
      }),
      items.service,
    );
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: { layers: Array<{ source: { sourceItemId?: string } }> };
    };
    // Roads (the matching layer) sits at index 2 after the stack
    // flip.
    expect(args.data.layers[2]?.source.sourceItemId).toBe('arcgis-portal-1');
    // Layers without a matching portal item omit sourceItemId.
    expect(args.data.layers[1]?.source.sourceItemId).toBeUndefined();
  });

  it('builds imported layers from the shared MapLayer defaults', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: {
        layers: Array<Record<string, unknown>>;
      };
    };
    const layer = args.data.layers[0]!;
    // The declared MapLayer contract, not the drifted hand-rolled
    // shape (which wrote interactions.hoverEffect / clickToZoom and
    // labels.expression, none of which exist, and omitted declared
    // popup / labels / search fields).
    expect(layer.popup).toEqual({
      enabled: true,
      mode: 'all',
      fields: [],
      titleTemplate: '',
      bodyTemplate: '',
    });
    expect(layer.interactions).toEqual({
      hoverHighlight: true,
      editingEnabled: false,
      selectable: true,
    });
    expect(layer.labels).toMatchObject({ enabled: false, template: '' });
    expect(layer.labels).not.toHaveProperty('expression');
    expect(layer.search).toEqual({
      enabled: false,
      fields: [],
      labelTemplate: '',
    });
    expect(layer.scale).toEqual({
      minZoom: null,
      maxZoom: null,
      scaleWithZoom: true,
      labelsMinZoom: null,
      labelsMaxZoom: null,
    });
    expect(layer.access).toEqual({ policy: 'inherit', entries: [] });
    // Style defaults come from the shared DEFAULT_LAYER_STYLE.
    const style = layer.style as {
      point: { color: string; symbol: string };
    };
    expect(style.point.color).toBe('#6366f1');
  });

  it('carries a parsed definitionExpression onto the MapLayer filter', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'filtered',
          title: 'Open things',
          url: 'https://services.example.com/arcgis/rest/services/X/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: { definitionExpression: "STATUS = 'Open'" },
        },
      ],
    };
    await svc.import({ user: makeUser(), webMap: wm });
    const args = items.lastCreate.args as {
      data: { layers: Array<{ filter: unknown }> };
    };
    expect(args.data.layers[0]?.filter).toEqual({
      combinator: 'all',
      clauses: [{ field: 'STATUS', op: '==', value: 'Open' }],
    });
  });

  it('warns and imports unfiltered when the filter operator has no portal equivalent', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'in-filtered',
          title: 'Zoned',
          url: 'https://services.example.com/arcgis/rest/services/X/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: {
            definitionExpression: "ZONE IN ('R1', 'R2')",
          },
        },
      ],
    };
    const result = await svc.import({ user: makeUser(), webMap: wm });
    const args = items.lastCreate.args as {
      data: { layers: Array<{ filter: unknown }> };
    };
    expect(args.data.layers[0]?.filter).toBeNull();
    expect(
      result.warnings.some((w) => /no portal equivalent/.test(w)),
    ).toBe(true);
  });

  it('resolves the basemap by tileUrl match', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(
      makePrismaMock({
        basemapItems: [
          {
            id: 'basemap-streets',
            data: {
              tileUrl: 'https://basemaps.example.org/streets/{z}/{x}/{y}.png',
            },
          },
        ],
      }),
      items.service,
    );
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { data: { basemap: string } };
    expect(args.data.basemap).toBe('basemap-streets');
  });

  it('falls back to the empty-string basemap sentinel when no item matches', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { data: { basemap: string } };
    expect(args.data.basemap).toBe('');
  });

  it('emits center+zoom from initialState.viewpoint', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as {
      data: { center: [number, number]; zoom: number };
    };
    expect(args.data.center[0]).toBeCloseTo(-122.4);
    expect(args.data.center[1]).toBeCloseTo(37.8);
    expect(args.data.zoom).toBeGreaterThan(10);
    expect(args.data.zoom).toBeLessThan(14);
  });

  it('lifts an AGO simple-fill renderer onto the polygon style', async () => {
    // Real AGO WebMaps carry the operational layer's symbology
    // under layerDefinition.drawingInfo.renderer. For the 100-mile
    // border zone the renderer is a simple-fill with a purple
    // transparent fill (RGBA [165, 75, 200, 100] in Esri's 0-255
    // range). The portal map's polygon style should pick that up
    // instead of falling back to the default blue (#70 + #71).
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'border-zone',
          title: '100 Mile Border Zone',
          url: 'https://services.example.com/arcgis/rest/services/Border/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: 'simple',
                symbol: {
                  type: 'esriSFS',
                  style: 'esriSFSSolid',
                  color: [165, 75, 200, 100],
                  outline: {
                    type: 'esriSLS',
                    style: 'esriSLSSolid',
                    color: [120, 50, 150, 255],
                    width: 1.5,
                  },
                },
              },
            },
          },
        },
      ],
    } as EsriWebMap;
    await svc.import({ user: makeUser(), webMap: wm });
    const args = items.lastCreate.args as {
      data: { layers: Array<{ style: { polygon: any } }> };
    };
    const poly = args.data.layers[0]!.style.polygon;
    expect(poly.fillColor).toBe('#a54bc8');
    expect(poly.fillOpacity).toBeCloseTo(100 / 255, 2);
    expect(poly.strokeColor).toBe('#783296');
    expect(poly.strokeWidth).toBe(1.5);
  });

  it('projects web-mercator viewpoint envelopes back to lng/lat', async () => {
    // Real AGO WebMaps store the viewpoint envelope in the map's
    // spatialReference, which is almost always web mercator
    // (wkid 102100 = 3857). Storing those meter values verbatim
    // as the portal map's center blew up MapLibre with "Invalid
    // LngLat latitude value: must be between -90 and 90" the
    // moment the viewer tried to fit the camera.
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      initialState: {
        viewpoint: {
          // Bbox around West Virginia (the test case Matt's prod
          // import hit), expressed in web mercator metres.
          targetGeometry: {
            xmin: -9_300_000,
            ymin: 4_500_000,
            xmax: -8_700_000,
            ymax: 4_900_000,
            spatialReference: { wkid: 102100 },
          },
          scale: 500_000,
        },
      },
    };
    await svc.import({ user: makeUser(), webMap: wm });
    const args = items.lastCreate.args as {
      data: { center: [number, number]; zoom: number };
    };
    // Web mercator (-9_000_000, 4_700_000) is roughly
    // (-80.85, 38.82) -- West Virginia. The exact values come
    // out of the standard EPSG:3857 inverse formula.
    expect(args.data.center[0]).toBeGreaterThan(-82);
    expect(args.data.center[0]).toBeLessThan(-79);
    expect(args.data.center[1]).toBeGreaterThan(37);
    expect(args.data.center[1]).toBeLessThan(40);
  });

  it('uses default center+zoom when initialState is missing', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const noView = { ...baseWebMap } as EsriWebMap;
    delete (noView as { initialState?: unknown }).initialState;
    await svc.import({ user: makeUser(), webMap: noView });
    const args = items.lastCreate.args as {
      data: { center: [number, number]; zoom: number };
    };
    expect(args.data.center).toEqual([0, 0]);
    expect(args.data.zoom).toBe(2);
  });

  it('skips unsupported layer types and surfaces a warning', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'tiled',
          title: 'Tiled',
          url: 'https://example.com/tiles',
          layerType: 'WebTiledLayer',
        },
        {
          id: 'good',
          title: 'Good FS',
          url: 'https://services.example.com/arcgis/rest/services/X/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    };
    const result = await svc.import({ user: makeUser(), webMap: wm });
    expect(result.layerCount).toBe(1);
    expect(
      result.warnings.some((w) => /unsupported layerType/.test(w)),
    ).toBe(true);
  });

  it('honours title + description overrides', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({
      user: makeUser(),
      webMap: baseWebMap,
      title: 'Quarterly review map',
      description: 'Imported from AGO Q3 2025 review.',
    });
    const args = items.lastCreate.args as {
      title: string;
      description?: string;
    };
    expect(args.title).toBe('Quarterly review map');
    expect(args.description).toBe('Imported from AGO Q3 2025 review.');
  });

  it('falls back to authoringApp + "import" when no title is given', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    await svc.import({ user: makeUser(), webMap: baseWebMap });
    const args = items.lastCreate.args as { title: string };
    expect(args.title).toMatch(/Esri ArcGIS Online import/);
  });

  it('rejects a WebMap with no usable operational layers', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm: EsriWebMap = {
      ...baseWebMap,
      operationalLayers: [
        {
          id: 'tiled',
          title: 'Only tiled',
          url: 'https://example.com/t',
          layerType: 'WebTiledLayer',
        },
      ],
    };
    await expect(svc.import({ user: makeUser(), webMap: wm })).rejects.toThrow(
      /zero usable layers/,
    );
  });

  it('rejects a WebMap missing the version field', async () => {
    const items = makeItemsMock();
    const svc = new WebMapJsonImportService(makePrismaMock(), items.service);
    const wm = { ...baseWebMap } as EsriWebMap;
    delete (wm as { version?: string }).version;
    await expect(svc.import({ user: makeUser(), webMap: wm })).rejects.toThrow(
      /missing or empty .version/,
    );
  });
});

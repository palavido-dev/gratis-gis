// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import {
  RASTER_COLLECTION_ID,
  STAC_CONFORMANCE,
  bboxIntersectsGeometry,
  buildRasterCollection,
  buildStacItem,
  filterAndPage,
  itemDatetime,
  parseDatetime,
  parseSearchParams,
  rejectUnknownMembers,
  type StacItemRow,
} from './stac-core.js';

const BASE = 'https://demo.example';
const ROOT = `${BASE}/api/public/stac`;

function row(overrides: Partial<StacItemRow> = {}): StacItemRow {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Elkins imagery',
    description: 'County orthophotos',
    tags: ['imagery', 'randolph'],
    license: 'CC-BY-4.0',
    bbox: [-80.1, 38.8, -79.7, 39.1],
    createdAt: new Date('2026-07-01T12:00:00Z'),
    updatedAt: new Date('2026-08-01T12:00:00Z'),
    data: {
      version: 1,
      format: 'pmtiles',
      kind: 'raster',
      storageKey: 'item-tile-layer/x/pyramid.pmtiles',
      storageUrl: 'ignored',
      fileName: 'imagery.tif',
      sizeBytes: 123,
      uploadedAt: '2026-07-02T00:00:00Z',
      cogStorageKey: 'item-tile-layer/x/source.cog.tif',
      pmtilesStorageKey: 'item-tile-layer/x/pyramid.pmtiles',
      minZoom: 5,
      maxZoom: 17,
      tileType: 'png',
    },
    ...overrides,
  };
}

interface ProjectedItem {
  type: string;
  collection: string;
  bbox?: number[];
  geometry: { type: string } | null;
  assets: Record<string, { href: string; type: string }>;
  links: Array<{ rel: string; href: string; type?: string }>;
  properties: Record<string, unknown>;
}

function project(r: StacItemRow): ProjectedItem {
  return buildStacItem(r, BASE, ROOT) as unknown as ProjectedItem;
}

describe('STAC item projection', () => {
  it('projects a hybrid raster with both assets and the web-map links', () => {
    const item = project(row());
    expect(item.type).toBe('Feature');
    expect(item.collection).toBe(RASTER_COLLECTION_ID);
    expect(item.bbox).toEqual([-80.1, 38.8, -79.7, 39.1]);
    expect(item.geometry!.type).toBe('Polygon');

    const assets = item.assets;
    expect(assets.cog!.href).toBe(
      `${BASE}/api/tile-layer/${row().id}/file.cog`,
    );
    expect(assets.cog!.type).toContain('profile=cloud-optimized');
    expect(assets.pmtiles!.href).toBe(
      `${BASE}/api/tile-layer/${row().id}/file.pmtiles`,
    );

    const links = item.links;
    const xyz = links.find((l) => l.rel === 'xyz');
    expect(xyz!.href).toBe(
      `${BASE}/api/tile-layer/${row().id}/tiles/{z}/{x}/{y}.png`,
    );
    expect(links.some((l) => l.rel === 'pmtiles')).toBe(true);
    // The self link stays on the surface the caller arrived through.
    expect(links.find((l) => l.rel === 'self')!.href).toContain(
      '/api/public/stac/',
    );
  });

  it('datetime is the upload time, falling back to createdAt', () => {
    expect(itemDatetime(row()).toISOString()).toBe(
      '2026-07-02T00:00:00.000Z',
    );
    const noUpload = row({ data: null });
    expect(itemDatetime(noUpload).toISOString()).toBe(
      '2026-07-01T12:00:00.000Z',
    );
  });

  it('a COG-bridge item (pyramid not built yet) has no pmtiles offer', () => {
    const cogOnly = row({
      data: {
        version: 1,
        format: 'cog',
        kind: 'raster',
        storageKey: 'item-tile-layer/x/source.cog.tif',
        storageUrl: 'ignored',
        fileName: 'imagery.tif',
        sizeBytes: 123,
        uploadedAt: '2026-07-02T00:00:00Z',
      },
    });
    const item = project(cogOnly);
    expect(item.assets.cog).toBeDefined();
    expect(item.assets.pmtiles).toBeUndefined();
    expect(item.links.some((l) => l.rel === 'pmtiles')).toBe(false);
  });

  it('an item with no extent has null geometry and NO bbox member', () => {
    // STAC forbids bbox alongside a null geometry; emitting one would
    // fail validation for every pre-#16 item that never got an extent.
    const bare = project(row({ bbox: null, data: null }));
    expect(bare.geometry).toBeNull();
    expect('bbox' in bare).toBe(false);
  });

  it('vector tile layers advertise MVT tiles, not PNG', () => {
    const vector = row({
      data: {
        version: 1,
        format: 'pmtiles',
        kind: 'vector',
        storageKey: 'k',
        storageUrl: 'ignored',
        fileName: 'parcels.pmtiles',
        sizeBytes: 1,
        uploadedAt: '2026-07-02T00:00:00Z',
        tileType: 'mvt',
      },
    });
    const item = project(vector);
    const xyz = item.links.find((l) => l.rel === 'xyz')!;
    expect(xyz.type).toBe('application/vnd.mapbox-vector-tile');
    expect(xyz.href.endsWith('{z}/{x}/{y}')).toBe(true);
  });
});

describe('rasters collection document', () => {
  it('unions the item extents', () => {
    const doc = buildRasterCollection(
      [
        row(),
        row({ id: '99999999-2222-4333-8444-555555555555', bbox: [-81, 38, -80.5, 38.5] }),
      ],
      ROOT,
    ) as { extent: { spatial: { bbox: number[][] } } };
    expect(doc.extent.spatial.bbox[0]).toEqual([-81, 38, -79.7, 39.1]);
  });

  it('an empty portal still emits a valid extent', () => {
    const doc = buildRasterCollection([], ROOT) as {
      extent: {
        spatial: { bbox: number[][] };
        temporal: { interval: Array<Array<string | null>> };
      };
    };
    expect(doc.extent.spatial.bbox[0]).toHaveLength(4);
    expect(doc.extent.temporal.interval[0]).toEqual([null, null]);
  });
});

describe('search parameter parsing', () => {
  it('parses GET-shaped strings', () => {
    const p = parseSearchParams({
      limit: '5',
      bbox: '-81,38,-79,40',
      datetime: '2026-07-01T00:00:00Z/..',
      ids: 'a,b',
      collections: 'rasters',
    });
    expect(p.limit).toBe(5);
    expect(p.bbox).toEqual([-81, 38, -79, 40]);
    expect(p.datetime!.start).toBeInstanceOf(Date);
    expect(p.datetime!.end).toBeNull();
    expect(p.ids).toEqual(['a', 'b']);
  });

  it('parses POST-shaped natives, including a 3D bbox', () => {
    const p = parseSearchParams({ bbox: [-81, 38, 0, -79, 40, 100] });
    expect(p.bbox).toEqual([-81, 38, -79, 40]);
    const q = parseSearchParams({
      intersects: { type: 'Point', coordinates: [-80, 39] },
    });
    expect(q.intersects!.type).toBe('Point');
  });

  it('refuses bbox combined with intersects', () => {
    // Honoring one of the two silently is the wrong-answer shape the
    // OGC surface just had surgically removed (#28).
    expect(() =>
      parseSearchParams({
        bbox: '-81,38,-79,40',
        intersects: '{"type":"Point","coordinates":[0,0]}',
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects malformed datetime, empty intervals, and bad bboxes', () => {
    expect(() => parseDatetime('not-a-date')).toThrow(BadRequestException);
    expect(() => parseDatetime('../..')).toThrow(BadRequestException);
    expect(() =>
      parseDatetime('2026-08-01T00:00:00Z/2026-07-01T00:00:00Z'),
    ).toThrow(BadRequestException);
    expect(() => parseSearchParams({ bbox: '1,2,3' })).toThrow(
      BadRequestException,
    );
    expect(() => parseSearchParams({ bbox: '0,50,10,40' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects unknown POST members by name', () => {
    // `query`, `filter`, `sortby`, `fields` are real STAC extensions
    // we do not implement; ignoring them would return unfiltered
    // results for a filtered request.
    expect(() =>
      rejectUnknownMembers({ filter: {} }, ['limit', 'bbox']),
    ).toThrow(/filter/);
  });
});

describe('bbox-vs-geometry intersection', () => {
  const box: [number, number, number, number] = [0, 0, 10, 10];

  it('point in and out', () => {
    expect(
      bboxIntersectsGeometry(box, { type: 'Point', coordinates: [5, 5] }),
    ).toBe(true);
    expect(
      bboxIntersectsGeometry(box, { type: 'Point', coordinates: [15, 5] }),
    ).toBe(false);
  });

  it('a line crossing the box with no vertex inside still matches', () => {
    expect(
      bboxIntersectsGeometry(box, {
        type: 'LineString',
        coordinates: [
          [-5, 5],
          [15, 5],
        ],
      }),
    ).toBe(true);
  });

  it('box wholly inside a polygon matches; polygon wholly inside the box matches', () => {
    const bigRing = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
      [-100, -100],
    ];
    expect(
      bboxIntersectsGeometry(box, {
        type: 'Polygon',
        coordinates: [bigRing],
      }),
    ).toBe(true);
    const tinyRing = [
      [1, 1],
      [2, 1],
      [2, 2],
      [1, 2],
      [1, 1],
    ];
    expect(
      bboxIntersectsGeometry(box, {
        type: 'Polygon',
        coordinates: [tinyRing],
      }),
    ).toBe(true);
  });

  it('box sitting wholly inside a hole does NOT match', () => {
    // The even-odd case that separates a real intersection test from
    // an envelope check: the polygon is a donut and the box is in the
    // donut hole.
    const outer = [
      [-100, -100],
      [100, -100],
      [100, 100],
      [-100, 100],
      [-100, -100],
    ];
    const hole = [
      [-50, -50],
      [50, -50],
      [50, 50],
      [-50, 50],
      [-50, -50],
    ];
    expect(
      bboxIntersectsGeometry(box, {
        type: 'Polygon',
        coordinates: [outer, hole],
      }),
    ).toBe(false);
  });

  it('geometry collections recurse', () => {
    expect(
      bboxIntersectsGeometry(box, {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [50, 50] },
          { type: 'Point', coordinates: [5, 5] },
        ],
      }),
    ).toBe(true);
  });
});

describe('filterAndPage', () => {
  const rows = [
    row(),
    row({
      id: '22222222-2222-4333-8444-555555555555',
      bbox: [10, 10, 20, 20],
      data: {
        version: 1,
        format: 'pmtiles',
        kind: 'raster',
        storageKey: 'k',
        storageUrl: 'ignored',
        fileName: 'other.pmtiles',
        sizeBytes: 1,
        uploadedAt: '2026-01-15T00:00:00Z',
      },
    }),
  ];

  it('filters by bbox against the cached extent', () => {
    const r = filterAndPage(rows, {
      limit: 100,
      offset: 0,
      bbox: [-81, 38, -79, 40],
    });
    expect(r.matched).toBe(1);
    expect(r.page[0]!.id).toBe(rows[0]!.id);
  });

  it('filters datetime against the same value the projection reports', () => {
    const r = filterAndPage(rows, {
      limit: 100,
      offset: 0,
      datetime: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') },
    });
    expect(r.matched).toBe(1);
    expect(r.page[0]!.id).toBe('22222222-2222-4333-8444-555555555555');
  });

  it('an antimeridian-crossing query bbox is honored, not emptied', () => {
    const fiji = row({
      id: '33333333-2222-4333-8444-555555555555',
      bbox: [178, -19, 179, -18],
    });
    const r = filterAndPage([fiji], {
      limit: 100,
      offset: 0,
      bbox: [170, -30, -170, 0],
    });
    expect(r.matched).toBe(1);
  });

  it('unknown collections yield an empty result rather than everything', () => {
    const r = filterAndPage(rows, {
      limit: 100,
      offset: 0,
      collections: ['sentinel-2'],
    });
    expect(r.matched).toBe(0);
  });

  it('pages with a stable total', () => {
    const r = filterAndPage(rows, { limit: 1, offset: 1 });
    expect(r.matched).toBe(2);
    expect(r.page).toHaveLength(1);
  });
});

describe('conformance honesty', () => {
  it('declares item-search and features classes it actually implements', () => {
    // Pin the list so a future edit that drops an endpoint has to
    // confront the declaration in the same diff.
    expect(STAC_CONFORMANCE).toEqual(
      expect.arrayContaining([
        'https://api.stacspec.org/v1.0.0/core',
        'https://api.stacspec.org/v1.0.0/collections',
        'https://api.stacspec.org/v1.0.0/ogcapi-features',
        'https://api.stacspec.org/v1.0.0/item-search',
      ]),
    );
  });
});

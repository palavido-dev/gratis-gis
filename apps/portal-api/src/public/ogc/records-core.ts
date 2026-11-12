// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';
import { ItemType, Prisma } from '@prisma/client';
import {
  keywordsFromTags,
  themesFromTags,
} from '@gratis-gis/shared-types';

/**
 * Shared OGC API Records builders used by both the legacy
 * `/api/public/ogc/records` alias and the searchable-catalog path at
 * `/api/public/ogc/collections/catalog/items`.
 *
 * QGIS MetaSearch (bundled by default) discovers catalogues by
 * fetching `/collections` and keeping entries where
 * `itemType === 'record'`, then reading items under
 * `/collections/{catalogId}/items`. Keeping the payload identical
 * across both mounts means one query path serves both clients.
 *
 * See docs/research/ecosystem-alignment-2026-08-17.md and
 * landing.controller.ts conformance notes for searchable-catalog.
 */

/** Stable collection id for the instance catalogue. Not a UUID, so
 *  it never collides with a Features collection id. */
export const CATALOG_COLLECTION_ID = 'catalog';

/** Largest `offset` the records list takes. */
export const MAX_RECORDS_OFFSET = 100_000;

/** Query parameters the records list understands. */
export const RECORDS_QUERY_PARAMS = [
  'limit',
  'offset',
  'q',
  'type',
  'sortby',
  'bbox',
  'f',
] as const;

/** Every item type the database knows, from the Prisma enum. */
const ITEM_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(ItemType));

/**
 * Refuse a filter the list cannot apply, instead of answering with
 * the unfiltered catalogue under an authoritative numberMatched. Same
 * rule the Features and STAC twins follow.
 */
export function assertRecordsQuery(
  queryKeys: Iterable<string>,
  q: { bbox?: string | undefined; type?: string | undefined; offset: number },
): void {
  const allowed = new Set<string>(RECORDS_QUERY_PARAMS);
  const unknown = [...queryKeys].filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Unknown query parameter(s): ${unknown.join(', ')}.`,
    );
  }
  if (q.bbox !== undefined && q.bbox.trim().length > 0 && parseBboxQuery(q.bbox) === null) {
    throw new BadRequestException('bbox must be four comma-separated numbers.');
  }
  if (q.type !== undefined && q.type.length > 0 && !ITEM_TYPE_VALUES.has(q.type)) {
    throw new BadRequestException(`Unknown type: ${q.type}.`);
  }
  if (q.offset > MAX_RECORDS_OFFSET) {
    throw new BadRequestException(
      `offset beyond ${MAX_RECORDS_OFFSET} is not supported.`,
    );
  }
}

/**
 * One page of public records and the total that matches. A bbox is
 * tested in SQL against the indexed bbox_geom column (generated from
 * item.bbox), so the count covers the whole catalogue, not a capped
 * scan held in memory.
 */
export async function queryPublicRecords(
  prisma: {
    $queryRaw: <T>(query: Prisma.Sql) => Promise<T>;
    item: {
      count: (args: { where: Prisma.ItemWhereInput }) => Promise<number>;
      findMany: (args: Prisma.ItemFindManyArgs) => Promise<unknown[]>;
    };
  },
  args: {
    where: Prisma.ItemWhereInput;
    orderBy: Prisma.ItemFindManyArgs['orderBy'];
    offset: number;
    limit: number;
    bbox: string | undefined;
  },
): Promise<{ rows: ItemRow[]; total: number }> {
  let where = args.where;
  const box = parseBboxQuery(args.bbox);
  if (box) {
    const [w, s, e, n] = box;
    const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "item"
      WHERE access = 'public'
        AND deleted_at IS NULL
        AND bbox_geom && ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)
    `);
    where = { AND: [where, { id: { in: ids.map((r) => r.id) } }] };
  }
  const [total, rows] = await Promise.all([
    prisma.item.count({ where }),
    prisma.item.findMany({
      where,
      select: ITEM_SELECT,
      ...(args.orderBy !== undefined ? { orderBy: args.orderBy } : {}),
      skip: args.offset,
      take: args.limit,
    }),
  ]);
  return { rows: rows as ItemRow[], total };
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ITEM_SELECT = {
  id: true,
  title: true,
  description: true,
  type: true,
  tags: true,
  license: true,
  bbox: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { fullName: true, username: true } },
} as const;

export type ItemRow = {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  tags: string[];
  license: string | null;
  bbox: unknown;
  createdAt: Date;
  updatedAt: Date;
  owner: { fullName: string; username: string } | null;
};

export function catalogCollectionDoc(
  ogcRoot: string,
): Record<string, unknown> {
  const self = `${ogcRoot}/collections/${CATALOG_COLLECTION_ID}`;
  return {
    id: CATALOG_COLLECTION_ID,
    title: 'GratisGIS catalog',
    description:
      'Public items hosted by this GratisGIS instance, as OGC API ' +
      'Records. Discoverable by QGIS MetaSearch and other Records ' +
      'clients that look for itemType=record under /collections.',
    itemType: 'record',
    links: [
      { href: self, rel: 'self', type: 'application/json' },
      {
        href: `${self}/items`,
        rel: 'items',
        type: 'application/geo+json',
      },
      {
        href: `${ogcRoot}/records`,
        rel: 'alternate',
        type: 'application/json',
        title: 'Records alias',
      },
    ],
  };
}

export function buildRecord(
  row: ItemRow,
  base: string,
  opts: { selfPath?: string } = {},
): Record<string, unknown> {
  // Prefer the searchable-catalog self URL when mounted there so
  // MetaSearch "open record" stays on /collections/.../items/{id}.
  const self =
    opts.selfPath ?? `${base}/api/public/ogc/records/${row.id}`;
  const links: Array<Record<string, string>> = [
    { href: self, rel: 'self', type: 'application/json' },
    {
      // Records are a public surface; the anonymous mirror of the
      // item document is the one a caller here can open.
      href: `${base}/api/public/items/${row.id}`,
      rel: 'alternate',
      type: 'application/json',
      title: 'Portal item document',
    },
  ];

  switch (row.type) {
    case 'data_layer': {
      const itemsUrl = `${base}/api/public/ogc/collections/${row.id}/items`;
      links.push(
        {
          href: `${base}/api/public/ogc/collections/${row.id}`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/data',
          type: 'application/json',
          title: 'Feature collection',
        },
        {
          href: itemsUrl,
          rel: 'items',
          type: 'application/geo+json',
          title: 'Features (GeoJSON)',
        },
        // MetaSearch "Add Data" keys off a legacy service-type list
        // with no OAPIF entry; FILE:GEO is the GeoJSON path that
        // unlocks one-click add from the catalogue result.
        {
          href: itemsUrl,
          rel: 'enclosure',
          type: 'FILE:GEO',
          title: 'GeoJSON',
        },
        {
          href: `${base}/api/public/ogc/collections/${row.id}/tiles/WebMercatorQuad`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector',
          type: 'application/json',
          title: 'Vector tileset',
        },
        {
          href: `${base}/api/public/ogc/styles/${row.id}`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/styles',
          type: 'application/vnd.mapbox.style+json',
          title: 'Default MapLibre style',
        },
      );
      break;
    }
    case 'map':
    case 'web_app':
      break;
    default:
      break;
  }

  const bboxArr = parseBbox(row.bbox);
  const geometry = bboxArr ? bboxToGeometry(bboxArr) : null;
  const ownerName = row.owner?.fullName?.trim() || row.owner?.username;
  // Free-form tags stay keywords; curated Aardvark themes
  // (stored as tags that match ITEM_THEMES) emit separately so
  // MetaSearch / GeoBlacklight facets stay clean.
  const themes = themesFromTags(row.tags);
  const keywords = keywordsFromTags(row.tags);

  return {
    id: row.id,
    type: 'Record',
    conformsTo: [
      'http://www.opengis.net/spec/ogcapi-records-1/1.0/req/record-core',
    ],
    time: {
      interval: [row.createdAt.toISOString(), '..'],
      resolution: 'P1S',
    },
    properties: {
      title: row.title,
      description: row.description || row.title,
      created: row.createdAt.toISOString(),
      updated: row.updatedAt.toISOString(),
      type: row.type,
      keywords,
      ...(themes.length > 0 ? { themes } : {}),
      ...(row.license ? { license: row.license } : {}),
      ...(ownerName
        ? {
            providers: [
              { name: ownerName, roles: ['producer'] },
            ],
          }
        : {}),
      ...(row.type === 'data_layer'
        ? {
            formats: [
              { name: 'GeoJSON' },
              { name: 'MapboxVectorTile' },
            ],
          }
        : {}),
    },
    ...(geometry ? { geometry } : { geometry: null }),
    links,
  };
}

export function parseBbox(
  b: unknown,
): [number, number, number, number] | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const arr = b as unknown[];
  if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return null;
  }
  return arr as [number, number, number, number];
}

/** Parse `?bbox=minLon,minLat,maxLon,maxLat` (CRS84). */
export function parseBboxQuery(
  value: string | undefined,
): [number, number, number, number] | null {
  if (!value || value.trim().length === 0) return null;
  const parts = value.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const [w, s, e, n] = parts as [number, number, number, number];
  return [w, s, e, n];
}

export function bboxesIntersect(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const [aw, as, ae, an] = a;
  const [bw, bs, be, bn] = b;
  return aw <= be && ae >= bw && as <= bn && an >= bs;
}

export function bboxToGeometry(
  b: [number, number, number, number],
): Record<string, unknown> {
  const [w, s, e, n] = b;
  const epsilon = 1e-9;
  if (Math.abs(e - w) < epsilon && Math.abs(n - s) < epsilon) {
    return { type: 'Point', coordinates: [w, s] };
  }
  return {
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

export function parseSortby(
  value: string | undefined,
): Array<Record<string, 'asc' | 'desc'>> {
  if (!value) return [{ updatedAt: 'desc' }];
  const allowed = new Set([
    'createdAt',
    'updatedAt',
    'title',
    'type',
  ]);
  const out: Array<Record<string, 'asc' | 'desc'>> = [];
  for (const raw of value.split(',')) {
    const s = raw.trim();
    if (s.length === 0) continue;
    let dir: 'asc' | 'desc' = 'asc';
    let key = s;
    if (s.startsWith('-')) {
      dir = 'desc';
      key = s.slice(1);
    } else if (s.startsWith('+')) {
      key = s.slice(1);
    }
    if (allowed.has(key)) out.push({ [key]: dir });
  }
  return out.length > 0 ? out : [{ updatedAt: 'desc' }];
}

export function pagedUrl(
  selfBase: string,
  limit: number,
  offset: number,
  q: string | undefined,
  type: string | undefined,
  sortby: string | undefined,
  bbox: string | undefined,
): string {
  const url = new URL(selfBase);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (q) url.searchParams.set('q', q);
  if (type) url.searchParams.set('type', type);
  if (sortby) url.searchParams.set('sortby', sortby);
  if (bbox) url.searchParams.set('bbox', bbox);
  return url.toString();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export type RecordsListParams = {
  limit: number;
  offset: number;
  q?: string | undefined;
  type?: string | undefined;
  sortby?: string | undefined;
  bbox?: string | undefined;
};

/** Drop undefined optional query fields for exactOptionalPropertyTypes. */
export function recordsListParams(input: {
  limit: number;
  offset: number;
  q?: string | undefined;
  type?: string | undefined;
  sortby?: string | undefined;
  bbox?: string | undefined;
}): RecordsListParams {
  const out: RecordsListParams = {
    limit: input.limit,
    offset: input.offset,
  };
  if (input.q !== undefined) out.q = input.q;
  if (input.type !== undefined) out.type = input.type;
  if (input.sortby !== undefined) out.sortby = input.sortby;
  if (input.bbox !== undefined) out.bbox = input.bbox;
  return out;
}

export type RecordsPage = {
  type: 'FeatureCollection';
  timeStamp: string;
  numberMatched: number;
  numberReturned: number;
  features: Array<Record<string, unknown>>;
  links: Array<Record<string, string>>;
};

/**
 * Shape a FeatureCollection-style records page from a DB-paged slice
 * (caller already applied skip/take and supplies `total`).
 */
export function buildRecordsPage(
  pageRows: ItemRow[],
  total: number,
  base: string,
  selfBase: string,
  params: RecordsListParams,
  rootHref: string,
): RecordsPage {
  const onCatalogPath = selfBase.includes('/collections/');
  const features = pageRows.map((r) =>
    onCatalogPath
      ? buildRecord(r, base, { selfPath: `${selfBase}/${r.id}` })
      : buildRecord(r, base),
  );

  const links: Array<Record<string, string>> = [
    { href: selfBase, rel: 'self', type: 'application/json' },
    { href: rootHref, rel: 'root', type: 'application/json' },
  ];
  if (params.offset + params.limit < total) {
    links.push({
      href: pagedUrl(
        selfBase,
        params.limit,
        params.offset + params.limit,
        params.q,
        params.type,
        params.sortby,
        params.bbox,
      ),
      rel: 'next',
      type: 'application/json',
    });
  }
  if (params.offset > 0) {
    links.push({
      href: pagedUrl(
        selfBase,
        params.limit,
        Math.max(0, params.offset - params.limit),
        params.q,
        params.type,
        params.sortby,
        params.bbox,
      ),
      rel: 'prev',
      type: 'application/json',
    });
  }

  return {
    type: 'FeatureCollection',
    timeStamp: new Date().toISOString(),
    numberMatched: total,
    numberReturned: features.length,
    features,
    links,
  };
}

/** Prisma `where` fragment shared by both Records mounts. */
export function recordsWhere(opts: {
  q?: string | undefined;
  type?: string | undefined;
}): {
  access: 'public';
  deletedAt: null;
  type?: ItemType;
  OR?: Array<Record<string, unknown>>;
} {
  const where: {
    access: 'public';
    deletedAt: null;
    type?: ItemType;
    OR?: Array<Record<string, unknown>>;
  } = { access: 'public', deletedAt: null };
  if (opts.type && ITEM_TYPE_VALUES.has(opts.type)) {
    where.type = opts.type as ItemType;
  }
  if (opts.q && opts.q.trim().length > 0) {
    const needle = opts.q.trim();
    where.OR = [
      { title: { contains: needle, mode: 'insensitive' } },
      { description: { contains: needle, mode: 'insensitive' } },
      { tags: { has: needle } },
    ];
  }
  return where;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller, Get, Header, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator.js';
import { absoluteBase } from './url.js';

/**
 * Landing + conformance + OpenAPI endpoints for the OGC API surface.
 *
 * Lives separately from the per-class controllers because the OGC
 * spec wants ONE landing document that links to every class shipped
 * (Features, Tiles, Styles, Records), and ONE conformance list that
 * declares every class's URIs. Adding a class means appending a link
 * here, not rewriting the whole document. See
 * `docs/ogc-api-strategy.md` for the cross-cutting contract.
 */
@ApiTags('public', 'ogc')
@Controller('public/ogc')
export class OgcLandingController {
  /**
   * Landing page. OGC API Common Part 1 §6 mandates a root JSON
   * document with `title`, `description`, and a `links` array
   * pointing at the conformance + OpenAPI documents plus every
   * implemented class's entry endpoint.
   */
  @Public()
  @Get('/')
  landing(@Req() req: Request) {
    const base = absoluteBase(req);
    const root = `${base}/api/public/ogc`;
    return {
      title: 'GratisGIS OGC API',
      description:
        'OGC API endpoints exposing the publicly-shared data ' +
        'layers, styles, tilesets, and catalog records hosted by ' +
        'this GratisGIS instance. All endpoints are anonymous-' +
        'reachable and limited to items with access=public.',
      links: [
        {
          href: `${root}/`,
          rel: 'self',
          type: 'application/json',
          title: 'This document',
        },
        {
          href: `${root}/conformance`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/conformance',
          type: 'application/json',
          title: 'Conformance classes',
        },
        {
          href: `${root}/api`,
          rel: 'service-desc',
          type: 'application/vnd.oai.openapi+json;version=3.0',
          title: 'OpenAPI 3.0 description',
        },
        {
          href: `${root}/collections`,
          rel: 'data',
          type: 'application/json',
          title: 'Feature collections',
        },
        {
          href: `${root}/styles`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/styles',
          type: 'application/json',
          title: 'Styles',
        },
        {
          href: `${root}/tileMatrixSets`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/tiling-schemes',
          type: 'application/json',
          title: 'TileMatrixSets',
        },
        {
          href: `${root}/records`,
          rel: 'http://www.opengis.net/def/rel/ogc/1.0/records',
          type: 'application/json',
          title: 'Catalog records',
        },
      ],
    };
  }

  /**
   * Conformance declaration. Each class shipped APPENDS its URIs
   * here rather than rewriting; this keeps the conformance list
   * authoritative as new classes land. See ROADMAP §8.5.
   */
  @Public()
  @Get('conformance')
  conformance() {
    return {
      conformsTo: [
        // OGC API - Common Part 1
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page',
        'http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json',
        // OGC API - Features Part 1
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
        'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
        // OGC API - Features Part 2 (CRS by reference, axis-order
        // swap between CRS84 and EPSG:4326). See ogc-api-strategy
        // for the bounded interpretation: we don't reproject beyond
        // axis-order swap in v1.
        'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs',
        // NOTE deliberately absent: a Features sorting class. The
        // list previously declared
        // `ogcapi-features-3/1.0/conf/sorting`, which is not a real
        // conformance class (Part 3 is Filtering, OGC 19-079r2, and
        // defines no sorting; feature sorting exists only as the
        // draft Part 8). The implementation also only sorted the
        // fetched page, not the collection. Until the engine read
        // grows an ORDER BY hook, /collections/:id/items rejects
        // `sortby` with 400 per Part 1 /req/core/query-param-unknown
        // (the parameter is no longer in the API definition below).
        // The Records class below keeps its sorting URI: /records
        // really does sort the full set in the database.
        // OGC API - Styles Part 1
        'http://www.opengis.net/spec/ogcapi-styles-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-styles-1/1.0/conf/mapbox-styles',
        // OGC API - Tiles Part 1. `dataset-tilesets` is deliberately
        // absent: that class requires a DATASET-level /tiles resource
        // at the API root, which we do not serve (tiles exist per
        // collection only). It was declared for months alongside
        // `tilesets-list` while even the per-collection tilesets list
        // endpoint did not exist; the list below now matches the
        // routes exactly. If a root /tiles ever lands, restore the
        // URI in the same commit.
        'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core',
        'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tileset',
        'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tilesets-list',
        'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/geodata-tilesets',
        'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt',
        // OGC API - Records Part 1. `conf/core` is NOT a class this
        // standard defines (checked against OGC 20-004r1's own
        // conformance tables; the record model's class is
        // `conf/record-core`). We declared the invented URI for
        // months, which no client could have matched. Note
        // `conf/searchable-catalog` stays absent on purpose: it
        // requires records at /collections/{catalogId}/items, and
        // ours are still at /records. Declare it when the catalogue
        // moves to the standard path, not before.
        'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/record-core',
        'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/json',
        'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/sorting',
      ],
    };
  }

  /**
   * OpenAPI 3.0 document. Hand-rolled instead of generated via
   * @nestjs/swagger because the OGC API document has specific
   * shape requirements (parameter naming conventions, security
   * scheme exclusions, conformance-class cross-references) that
   * Nest's generator wouldn't produce verbatim. Keep this in sync
   * with the controller surface as endpoints are added.
   */
  @Public()
  @Get('api')
  // The landing page has always advertised this media type on its
  // service-desc link; serving plain application/json made the
  // document disagree with its own advertisement.
  @Header('Content-Type', 'application/vnd.oai.openapi+json;version=3.0')
  openApi(@Req() req: Request) {
    const base = absoluteBase(req);
    const root = `${base}/api/public/ogc`;
    return {
      openapi: '3.0.3',
      info: {
        title: 'GratisGIS OGC API',
        description:
          'Public OGC API surface for this GratisGIS instance. ' +
          'Exposes data_layer items shared at access=public as ' +
          'OGC API Features collections; future classes (Tiles, ' +
          'Styles, Records) layer on top.',
        version: '1.0.0',
        license: {
          name: 'AGPL-3.0-or-later',
          url: 'https://www.gnu.org/licenses/agpl-3.0.html',
        },
      },
      servers: [{ url: root }],
      paths: {
        '/': {
          get: {
            summary: 'Landing page',
            tags: ['Capabilities'],
            responses: { '200': { description: 'Landing document' } },
          },
        },
        '/conformance': {
          get: {
            summary: 'Conformance declaration',
            tags: ['Capabilities'],
            responses: { '200': { description: 'Conformance list' } },
          },
        },
        '/api': {
          get: {
            summary: 'OpenAPI 3.0 document',
            tags: ['Capabilities'],
            responses: { '200': { description: 'This document' } },
          },
        },
        '/collections': {
          get: {
            summary: 'List of feature collections',
            tags: ['Features'],
            responses: { '200': { description: 'Collections list' } },
          },
        },
        '/collections/{collectionId}': {
          get: {
            summary: 'Collection metadata',
            tags: ['Features'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description:
                  'Either an item UUID (single-layer items) or ' +
                  '`<itemId>__<layerKey>` (multi-layer items).',
              },
            ],
            responses: {
              '200': { description: 'Collection document' },
              '404': { description: 'Collection not found' },
            },
          },
        },
        '/collections/{collectionId}/items': {
          get: {
            summary: 'Feature collection (GeoJSON)',
            tags: ['Features'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
              },
              {
                name: 'offset',
                in: 'query',
                schema: { type: 'integer', minimum: 0, default: 0 },
              },
              {
                name: 'bbox',
                in: 'query',
                schema: { type: 'string' },
                description:
                  'Comma-separated `minLon,minLat,maxLon,maxLat` ' +
                  'when bbox-crs is CRS84 (default).',
              },
              {
                name: 'bbox-crs',
                in: 'query',
                schema: {
                  type: 'string',
                  enum: [
                    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                    'http://www.opengis.net/def/crs/EPSG/0/4326',
                  ],
                  default: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                },
              },
              {
                name: 'crs',
                in: 'query',
                schema: {
                  type: 'string',
                  enum: [
                    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                    'http://www.opengis.net/def/crs/EPSG/0/4326',
                  ],
                  default: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                },
                description:
                  'Output CRS. EPSG:4326 swaps coordinate axes ' +
                  'to lat/lon order; CRS84 keeps lon/lat.',
              },
              // `sortby` is intentionally NOT declared here: the
              // endpoint rejects it with 400 (see the conformance
              // note above and features.controller.ts). Keeping it
              // out of the API definition is what makes the 400 the
              // spec-mandated response (Part 1
              // /req/core/query-param-unknown).
            ],
            responses: {
              '200': { description: 'GeoJSON FeatureCollection' },
              '400': {
                description:
                  'Invalid parameter value, or a parameter not in ' +
                  'this API definition (e.g. sortby)',
              },
              '404': { description: 'Collection not found' },
            },
          },
        },
        '/collections/{collectionId}/items/{featureId}': {
          get: {
            summary: 'Single feature by id',
            tags: ['Features'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
              {
                name: 'featureId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
              {
                name: 'crs',
                in: 'query',
                schema: {
                  type: 'string',
                  enum: [
                    'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                    'http://www.opengis.net/def/crs/EPSG/0/4326',
                  ],
                  default: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84',
                },
              },
            ],
            responses: {
              '200': { description: 'GeoJSON Feature' },
              '404': { description: 'Feature or collection not found' },
            },
          },
        },
        '/styles': {
          get: {
            summary: 'List of styles',
            tags: ['Styles'],
            responses: { '200': { description: 'Styles list' } },
          },
        },
        '/styles/{styleId}': {
          get: {
            summary: 'MapLibre style document',
            tags: ['Styles'],
            parameters: [
              {
                name: 'styleId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description:
                  'Same id space as collections: bare UUID for ' +
                  'single-layer items, `<itemId>__<layerKey>` for ' +
                  'multi-layer items.',
              },
            ],
            responses: {
              '200': {
                description: 'MapLibre / Mapbox GL style JSON',
                content: {
                  'application/vnd.mapbox.style+json': {},
                },
              },
              '404': { description: 'Style not found' },
            },
          },
        },
        '/styles/{styleId}/metadata': {
          get: {
            summary: 'Style metadata',
            tags: ['Styles'],
            parameters: [
              {
                name: 'styleId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: {
              '200': { description: 'Style metadata document' },
              '404': { description: 'Style not found' },
            },
          },
        },
        '/tileMatrixSets': {
          get: {
            summary: 'List of supported TileMatrixSets',
            tags: ['Tiles'],
            responses: { '200': { description: 'TileMatrixSets list' } },
          },
        },
        '/tileMatrixSets/{tmsId}': {
          get: {
            summary: 'TileMatrixSet definition',
            tags: ['Tiles'],
            parameters: [
              {
                name: 'tmsId',
                in: 'path',
                required: true,
                schema: { type: 'string', enum: ['WebMercatorQuad'] },
              },
            ],
            responses: {
              '200': { description: 'TileMatrixSet document' },
              '404': { description: 'TileMatrixSet not found' },
            },
          },
        },
        '/collections/{collectionId}/tiles': {
          get: {
            summary: 'Tilesets list for a collection',
            tags: ['Tiles'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: {
              '200': { description: 'Tilesets list document' },
              '404': { description: 'Collection not found' },
            },
          },
        },
        '/collections/{collectionId}/tiles/{tmsId}': {
          get: {
            summary: 'Tileset metadata for a collection',
            tags: ['Tiles'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
              {
                name: 'tmsId',
                in: 'path',
                required: true,
                schema: { type: 'string', enum: ['WebMercatorQuad'] },
              },
            ],
            responses: {
              '200': { description: 'Tileset metadata document' },
              '404': { description: 'Tileset not found' },
            },
          },
        },
        '/collections/{collectionId}/tiles/{tmsId}/{tileMatrix}/{tileRow}/{tileCol}': {
          get: {
            summary: 'Vector tile (MVT)',
            tags: ['Tiles'],
            parameters: [
              {
                name: 'collectionId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
              {
                name: 'tmsId',
                in: 'path',
                required: true,
                schema: { type: 'string', enum: ['WebMercatorQuad'] },
              },
              {
                name: 'tileMatrix',
                in: 'path',
                required: true,
                schema: { type: 'integer', minimum: 0, maximum: 24 },
                description: 'Zoom level.',
              },
              {
                name: 'tileRow',
                in: 'path',
                required: true,
                schema: { type: 'integer', minimum: 0 },
                description: 'Y (row) coordinate.',
              },
              {
                name: 'tileCol',
                in: 'path',
                required: true,
                schema: { type: 'integer', minimum: 0 },
                description: 'X (column) coordinate.',
              },
            ],
            responses: {
              '200': {
                description: 'Mapbox Vector Tile bytes',
                content: {
                  'application/vnd.mapbox-vector-tile': {},
                },
              },
              '404': { description: 'Tileset not found' },
              '400': { description: 'Invalid tile coordinates' },
            },
          },
        },
        '/records': {
          get: {
            summary: 'Catalog records (paged)',
            tags: ['Records'],
            parameters: [
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
              },
              {
                name: 'offset',
                in: 'query',
                schema: { type: 'integer', minimum: 0, default: 0 },
              },
              {
                name: 'q',
                in: 'query',
                schema: { type: 'string' },
                description: 'Free-text search over title / description / tags.',
              },
              {
                name: 'type',
                in: 'query',
                schema: { type: 'string' },
                description: 'Filter by item type (data_layer, map, ...).',
              },
              {
                name: 'sortby',
                in: 'query',
                schema: { type: 'string' },
                description:
                  'Whitelisted keys: createdAt, updatedAt, title, type. ' +
                  'Optional `-` prefix for descending.',
              },
            ],
            responses: { '200': { description: 'Records collection' } },
          },
        },
        '/records/{recordId}': {
          get: {
            summary: 'One catalog record',
            tags: ['Records'],
            parameters: [
              {
                name: 'recordId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: {
              '200': { description: 'Catalog record' },
              '404': { description: 'Record not found' },
            },
          },
        },
      },
    };
  }
}

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GratisGIS MCP server (#161 Phase 1 + Phase 2 write tools).
 *
 * Exposes a GratisGIS portal to Model Context Protocol clients
 * (Claude Desktop, Cursor, etc.) over the standard stdio transport.
 *
 * Phase 1 (read):
 *   - list_items, get_item, read_layer_features
 *   - query_osm: GET /api/osm/query (capped Overpass facade)
 * Phase 2 (write; needs a non-read-only API key):
 *   - run_tool: POST /api/tools/:id/run
 *   - create_data_layer_from_geojson: POST /api/items then
 *     POST /api/items/:id/layers/:layerKey/features
 *
 * Auth: GRATIS_GIS_TOKEN should be a portal API key (`ggk_...`)
 * minted at Profile / API keys (#219). Session JWTs still work
 * on the API but expire quickly; we soft-detect them and point
 * operators at API keys instead. Read-only keys work for Phase 1
 * and are refused by portal-api on Phase 2 POSTs.
 *
 * Connectivity: GRATIS_GIS_BASE_URL points at the portal-api
 * deployment (default http://localhost:4000). Thin facade over
 * existing HTTP surfaces; no Nest business logic lives here.
 *
 * Felt and CARTO both gate their MCP integrations to Enterprise
 * tiers; shipping ours in the open is the positioning win.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  TOKEN_SETUP_HINT,
  looksLikeJwt,
  looksLikePortalApiKey,
} from './auth-token.js';
import {
  APPEND_BATCH_SIZE,
  buildV3LayerData,
  chunk,
  inferFields,
  inferGeometryType,
  toAppendFeatures,
  type GeoJsonFeatureInput,
} from './geojson-layer.js';
import {
  OSM_QUERY_DEFAULT_FEATURES,
  OSM_QUERY_MAX_CONDITIONS,
  OSM_QUERY_MAX_FEATURES,
  OSM_QUERY_MAX_PRESETS,
  buildOsmQueryPath,
  clientRejectOsmQuery,
  type OsmQueryArgs,
} from './osm-query.js';

const BASE_URL = (
  process.env.GRATIS_GIS_BASE_URL ?? 'http://localhost:4000'
).replace(/\/+$/, '');
const TOKEN = process.env.GRATIS_GIS_TOKEN ?? '';
const USER_AGENT = 'gratis-gis-mcp/0.1';

const MISSING_TOKEN_MESSAGE = [
  'GRATIS_GIS_TOKEN is not set.',
  TOKEN_SETUP_HINT,
  'Then:',
  '  export GRATIS_GIS_TOKEN=ggk_...',
  'Or configure it inside your MCP client (Claude Desktop, Cursor, etc.).',
].join('\n');

const JWT_TOKEN_MESSAGE = [
  'GRATIS_GIS_TOKEN looks like a session JWT, not a portal API key.',
  TOKEN_SETUP_HINT,
].join('\n');

if (!TOKEN) {
  // Warn, but do not exit. Exiting at import time means an MCP
  // client only ever sees "server disconnected" with no reason,
  // and it turns a missing optional env var into a hard failure
  // for anything that happens to spawn this process. The guard
  // lives in requireToken() below, so list_tools still answers
  // and every tool call returns a readable error instead.
  // eslint-disable-next-line no-console
  console.error(MISSING_TOKEN_MESSAGE);
} else if (looksLikeJwt(TOKEN) && !looksLikePortalApiKey(TOKEN)) {
  // eslint-disable-next-line no-console
  console.error(JWT_TOKEN_MESSAGE);
}

function requireToken(): string {
  if (!TOKEN) throw new Error(MISSING_TOKEN_MESSAGE);
  return TOKEN;
}

const ITEM_TYPES = [
  'map',
  'data_layer',
  'arcgis_service',
  'form',
  'form_submission_collection',
  'web_app',
  'report_template',
  'dashboard',
  'file',
  'layer_package',
  'tool',
  'widget_package',
  'pick_list',
  'geo_boundary',
  'basemap',
  'derived_layer',
  'folder',
  'editor',
  'data_collection',
  'service',
  'geocoding_service',
  'tile_layer',
  'app_template',
  'theme',
  'print_template',
  'wms_service',
  'wfs_service',
] as const;

const listItemsSchema = z.object({
  type: z.enum(ITEM_TYPES).optional(),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const getItemSchema = z.object({
  id: z.string().uuid(),
});

const readLayerFeaturesSchema = z.object({
  itemId: z.string().uuid(),
  /** Sub-layer key for multi-layer data_layer items. Omit for
   *  v1 / v2 single-table items to hit the item-level endpoint. */
  layerKey: z.string().optional(),
  /** Hard cap on returned features so an MCP call against a
   *  multi-million-row layer doesn't fill the model's context
   *  window. The server may return fewer if the underlying
   *  GeoJSON dump has a lower built-in cap. */
  limit: z.number().int().min(1).max(5000).optional(),
});

const runToolSchema = z.object({
  toolId: z.string().uuid(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const geoJsonFeatureSchema = z.object({
  type: z.literal('Feature').optional(),
  id: z.union([z.string(), z.number()]).optional(),
  geometry: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).nullable().optional(),
});

const createDataLayerSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  access: z.enum(['private', 'org', 'public']).optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  /** Reuse an existing data_layer. Public create cannot mint a
   *  custom UUID; a missing id returns a clear error. */
  itemId: z.string().uuid().optional(),
  layerKey: z.string().min(1).max(80).optional(),
  features: z.array(geoJsonFeatureSchema).min(1).max(50_000),
  geometryType: z.enum(['point', 'line', 'polygon']).nullable().optional(),
});

const osmTagFilterSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.string().min(1).max(200),
  op: z.enum(['equals', 'contains', 'regex']).optional(),
});

const queryOsmSchema = z.object({
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .describe('WGS84 [west, south, east, north]. Required; unbounded queries are refused.'),
  mode: z.enum(['presets', 'relational']).optional(),
  presetIds: z.array(z.string().min(1).max(120)).max(OSM_QUERY_MAX_PRESETS).optional(),
  tagFilters: z.array(osmTagFilterSchema).max(20).optional(),
  anchorPresetId: z.string().min(1).max(120).optional(),
  conditions: z
    .array(
      z.object({
        presetId: z.string().min(1).max(120),
        distanceMeters: z.number().positive().max(50_000),
        tagFilters: z.array(osmTagFilterSchema).max(10).optional(),
      }),
    )
    .max(OSM_QUERY_MAX_CONDITIONS)
    .optional(),
  negations: z
    .array(
      z.object({
        presetId: z.string().min(1).max(120),
        distanceMeters: z.number().positive().max(50_000),
      }),
    )
    .max(OSM_QUERY_MAX_CONDITIONS)
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(OSM_QUERY_MAX_FEATURES)
    .optional(),
});

const TOOLS: Tool[] = [
  {
    name: 'list_items',
    description:
      'List items the caller can read in the GratisGIS portal. Filter by ' +
      'type (e.g. "map", "data_layer", "form") and / or a free-text query ' +
      'against title + description + tags. Returns up to `limit` items ' +
      '(default 25, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [...ITEM_TYPES],
          description: 'Filter by item type.',
        },
        query: {
          type: 'string',
          description:
            'Free-text search against item title / description / tags.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum items to return. Defaults to 25.',
        },
      },
    },
  },
  {
    name: 'get_item',
    description:
      'Fetch full metadata for a single item by id. Returns the item ' +
      'record including type, owner, sharing tier, description, tags, ' +
      'and the type-specific `data` blob.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          description: 'Item UUID.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'read_layer_features',
    description:
      'Read features from a data_layer item as a GeoJSON FeatureCollection. ' +
      'Pass `layerKey` for multi-layer v3 items (omit for legacy single-' +
      'table items). Capped to `limit` features so an MCP call against a ' +
      'large layer cannot exhaust the model context.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          format: 'uuid',
          description: 'data_layer item UUID.',
        },
        layerKey: {
          type: 'string',
          description:
            'Sub-layer key for multi-layer items. Omit for v1 / v2 ' +
            'single-table data_layer items.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 5000,
          description: 'Cap on returned features. Defaults to 1000.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'query_osm',
    description:
      'Query OpenStreetMap via the portal Overpass path ' +
      '(GET /api/osm/query). Pass a required WGS84 bbox ' +
      '[west, south, east, north] and either presetIds (mode=presets) ' +
      'or anchorPresetId + conditions (mode=relational). Caps: bbox ' +
      'area ≤ 1 square degree; at most 5000 features (default 1000). ' +
      'Unbounded / continent-scale queries are refused. Uses the org ' +
      'osmOverpassEndpoint when set. Returns a GeoJSON FeatureCollection ' +
      'plus attribution. Safe with a read-only API key. Optional ' +
      'follow-up: create_data_layer_from_geojson to persist results.',
    inputSchema: {
      type: 'object',
      properties: {
        bbox: {
          type: 'array',
          description:
            'Required WGS84 bounding box [west, south, east, north]. ' +
            'Max area 1 square degree.',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
        },
        mode: {
          type: 'string',
          enum: ['presets', 'relational'],
          description:
            'presets (default): filter by iD preset ids. relational: ' +
            'anchor near conditions (e.g. school near park).',
        },
        presetIds: {
          type: 'array',
          description:
            'iD preset catalog ids for mode=presets (e.g. ' +
            '"amenity_fuel", "leisure_park"). Max 10.',
          items: { type: 'string' },
        },
        tagFilters: {
          type: 'array',
          description:
            'Optional AND tag filters for mode=presets ' +
            '({key, value, op?}).',
          items: { type: 'object' },
        },
        anchorPresetId: {
          type: 'string',
          description: 'Anchor preset id for mode=relational.',
        },
        conditions: {
          type: 'array',
          description:
            'Near-conditions for mode=relational: ' +
            '[{presetId, distanceMeters, tagFilters?}]. Max 5.',
          items: { type: 'object' },
        },
        negations: {
          type: 'array',
          description:
            'Optional must-NOT-be-near rules for mode=relational.',
          items: { type: 'object' },
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: OSM_QUERY_MAX_FEATURES,
          description: `Cap on returned features. Defaults to ${OSM_QUERY_DEFAULT_FEATURES}.`,
        },
      },
      required: ['bbox'],
    },
  },
  {
    name: 'run_tool',
    description:
      'Execute a portal Tool recipe (POST /api/tools/:id/run). Pass ' +
      'toolId and a parameters map matching the tool item\'s ' +
      'data.action.parameters. Use get_item first to discover parameter ' +
      'names and kinds. Requires a non-read-only API key. Returns ' +
      '{ output: { kind, ... } }.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: {
          type: 'string',
          format: 'uuid',
          description: 'Tool item UUID.',
        },
        parameters: {
          type: 'object',
          additionalProperties: true,
          description:
            'Keyed by recipe parameter name. Value shapes depend on ' +
            'the tool (feature-source, distance meters, OSM preset ' +
            'input, point lng/lat, text, etc.).',
        },
      },
      required: ['toolId'],
    },
  },
  {
    name: 'create_data_layer_from_geojson',
    description:
      'Create a v3 data_layer from GeoJSON features (POST /api/items, ' +
      'then batched POST /api/items/:id/layers/:layerKey/features), or ' +
      'append into an existing itemId for reuse. Public create cannot ' +
      'set a custom item UUID. Pass stable Feature.id UUIDs for ' +
      'feature-level idempotency. Requires a non-read-only API key. ' +
      'At most 50_000 features; append batches of 5000.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Item title (required when creating).',
        },
        description: { type: 'string' },
        access: {
          type: 'string',
          enum: ['private', 'org', 'public'],
          description: 'Sharing tier. Defaults to private.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        itemId: {
          type: 'string',
          format: 'uuid',
          description:
            'Existing data_layer to append into. If omitted, a new ' +
            'item is created.',
        },
        layerKey: {
          type: 'string',
          description:
            'Sublayer id. Defaults to "default" on create, or the ' +
            'first sublayer when appending.',
        },
        features: {
          type: 'array',
          description: 'GeoJSON Feature objects (homogeneous geometry).',
          items: { type: 'object' },
        },
        geometryType: {
          type: 'string',
          enum: ['point', 'line', 'polygon'],
          description:
            'Override inferred geometry type. Omit to infer from features.',
        },
      },
      required: ['title', 'features'],
    },
  },
];

async function authedFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${requireToken()}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const base = `GratisGIS ${res.status}: ${text || res.statusText}`;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${base}\n${TOKEN_SETUP_HINT}`);
    }
    throw new Error(base);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

async function authedGet(path: string): Promise<unknown> {
  return authedFetch('GET', path);
}

async function authedPost(path: string, body: unknown): Promise<unknown> {
  return authedFetch('POST', path, body);
}

function firstSublayerId(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const data = (item as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers) || layers.length === 0) return undefined;
  const first = layers[0];
  if (!first || typeof first !== 'object') return undefined;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function toContent(json: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      { type: 'text', text: JSON.stringify(json, null, 2) },
    ],
  };
}

async function runTool(
  name: string,
  rawArgs: unknown,
): Promise<ReturnType<typeof toContent>> {
  switch (name) {
    case 'list_items': {
      const args = listItemsSchema.parse(rawArgs ?? {});
      const params = new URLSearchParams();
      if (args.type) params.set('type', args.type);
      if (args.query) params.set('query', args.query);
      params.set('limit', String(args.limit ?? 25));
      const out = await authedGet(`/api/items?${params.toString()}`);
      return toContent(out);
    }
    case 'get_item': {
      const args = getItemSchema.parse(rawArgs ?? {});
      const out = await authedGet(`/api/items/${args.id}`);
      return toContent(out);
    }
    case 'read_layer_features': {
      const args = readLayerFeaturesSchema.parse(rawArgs ?? {});
      const limit = args.limit ?? 1000;
      // Prefer the per-sublayer route when the caller supplied a
      // layerKey; fall back to the item-level dump otherwise.
      const path = args.layerKey
        ? `/api/items/${args.itemId}/layers/${encodeURIComponent(args.layerKey)}/geojson?limit=${limit}`
        : `/api/items/${args.itemId}/geojson?limit=${limit}`;
      const out = await authedGet(path);
      return toContent(out);
    }
    case 'query_osm': {
      const args = queryOsmSchema.parse(rawArgs ?? {}) as OsmQueryArgs;
      const reject = clientRejectOsmQuery(args);
      if (reject) throw new Error(reject);
      const out = await authedGet(buildOsmQueryPath(args));
      return toContent(out);
    }
    case 'run_tool': {
      const args = runToolSchema.parse(rawArgs ?? {});
      const out = await authedPost(`/api/tools/${args.toolId}/run`, {
        parameters: args.parameters ?? {},
      });
      return toContent(out);
    }
    case 'create_data_layer_from_geojson': {
      const args = createDataLayerSchema.parse(rawArgs ?? {});
      const features = args.features as GeoJsonFeatureInput[];
      const geometryType =
        args.geometryType !== undefined
          ? args.geometryType
          : inferGeometryType(features);
      const fields = inferFields(features);
      const appendPayload = toAppendFeatures(features);

      let itemId = args.itemId;
      let layerKey = args.layerKey;
      let created = false;

      if (itemId) {
        let existing: unknown;
        try {
          existing = await authedGet(`/api/items/${itemId}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('GratisGIS 404')) {
            throw new Error(
              `No data_layer with id ${itemId}. The public create API cannot mint a custom item UUID; omit itemId to create a new layer, or pass an existing id.`,
            );
          }
          throw err;
        }
        const type =
          existing && typeof existing === 'object'
            ? (existing as { type?: unknown }).type
            : undefined;
        if (type !== 'data_layer') {
          throw new Error(
            `Item ${itemId} has type ${String(type)}; create_data_layer_from_geojson only appends to data_layer items.`,
          );
        }
        if (!layerKey) {
          layerKey = firstSublayerId(existing);
        }
        if (!layerKey) {
          throw new Error(
            `Item ${itemId} has no sublayers; pass layerKey or recreate the item.`,
          );
        }
      } else {
        layerKey = layerKey ?? 'default';
        const data = buildV3LayerData({
          layerId: layerKey,
          label: args.title,
          geometryType,
          fields,
        });
        const createdItem = (await authedPost('/api/items', {
          type: 'data_layer',
          title: args.title,
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          access: args.access ?? 'private',
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          data,
        })) as { id?: string };
        if (typeof createdItem?.id !== 'string') {
          throw new Error('Create item response missing id.');
        }
        itemId = createdItem.id;
        created = true;
      }

      let inserted = 0;
      let deduplicated = 0;
      const batches = chunk(appendPayload, APPEND_BATCH_SIZE);
      for (const batch of batches) {
        const res = (await authedPost(
          `/api/items/${itemId}/layers/${encodeURIComponent(layerKey!)}/features`,
          { features: batch },
        )) as { inserted?: number; deduplicated?: number } | null;
        inserted += res?.inserted ?? batch.length;
        deduplicated += res?.deduplicated ?? 0;
      }

      return toContent({
        itemId,
        layerId: layerKey,
        created,
        inserted,
        deduplicated,
        batches: batches.length,
        featureCount: features.length,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    {
      name: 'gratis-gis-mcp',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await runTool(name, args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`gratis-gis-mcp connected to ${BASE_URL}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal:', err);
  process.exit(1);
});

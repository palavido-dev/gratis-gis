#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GratisGIS MCP server (#161 Phase 1).
 *
 * Exposes a read-only view of a GratisGIS portal to Model Context
 * Protocol clients (Claude Desktop, Cursor, etc.) over the
 * standard stdio transport. Phase 1 ships three tools:
 *
 *   - list_items: paginated browse of items the caller can read,
 *     filtered by item type and free-text query
 *   - get_item: full metadata for a single item by id
 *   - read_layer_features: the GeoJSON FeatureCollection of a
 *     data_layer, capped to a sane default
 *
 * Auth: a long-lived bearer token from the GRATIS_GIS_TOKEN env
 * var. Phase 1.5 will add a dedicated portal API-key model so
 * the user doesn't need to paste a Keycloak access token; for
 * now the simplest possible flow is the right one.
 *
 * Connectivity: GRATIS_GIS_BASE_URL points at the portal-api
 * deployment (default http://localhost:4000). The tool calls hit
 * the existing /api/items surface, so this server is genuinely
 * a thin facade — no business logic, just a typed MCP wrapper.
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

const BASE_URL = (
  process.env.GRATIS_GIS_BASE_URL ?? 'http://localhost:4000'
).replace(/\/+$/, '');
const TOKEN = process.env.GRATIS_GIS_TOKEN ?? '';
const USER_AGENT = 'gratis-gis-mcp/0.1';

const MISSING_TOKEN_MESSAGE = [
  'GRATIS_GIS_TOKEN is not set.',
  'Get a bearer token from your portal session and set it via:',
  '  export GRATIS_GIS_TOKEN=<your-token>',
  'Or configure it inside your MCP client (Claude Desktop, Cursor, etc.).',
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
];

async function authedGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      authorization: `Bearer ${requireToken()}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GratisGIS ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
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

# GratisGIS MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that
exposes a read-only view of a GratisGIS portal to MCP clients (Claude Desktop,
Cursor, custom agents). Connects over stdio. Phase 1 ships three tools.

The server ships with the platform under AGPL-3.0-or-later and works
against any GratisGIS portal you can sign into.

## Tools shipped in Phase 1

- `list_items`: paginated browse of items the caller can read, filtered by
  type and free-text query.
- `get_item`: full metadata for a single item by id.
- `read_layer_features`: GeoJSON FeatureCollection for a `data_layer`,
  capped per call so a large layer cannot exhaust the model context.

Phase 2 will add write tools (`run_tool`, `create_data_layer_from_geojson`).

## Quick start

```bash
# From the repo root
cd apps/portal-mcp
npm install
npm run build

# Set the portal base URL + a bearer token
export GRATIS_GIS_BASE_URL="https://gratisgis.org"
export GRATIS_GIS_TOKEN="<your-keycloak-access-token>"

# Run directly to test
node dist/index.js
```

The server speaks the MCP stdio transport; running it directly from a
terminal is only useful for verifying the binary starts. Real usage is via
an MCP client.

## Claude Desktop setup

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gratis-gis": {
      "command": "node",
      "args": ["/absolute/path/to/gratis-gis/apps/portal-mcp/dist/index.js"],
      "env": {
        "GRATIS_GIS_BASE_URL": "https://your-portal.example",
        "GRATIS_GIS_TOKEN": "your-bearer-token"
      }
    }
  }
}
```

Restart Claude Desktop. The three tools appear under the MCP server name in
the tool palette.

## Cursor setup

Edit your Cursor MCP settings to add the server with the same `command` /
`args` / `env` shape.

## Getting a bearer token (Phase 1)

Phase 1 uses a long-lived Keycloak access token from your portal session.
This is intentionally minimal so the MCP server ships without dragging in a
whole API-key UX. Phase 1.5 swaps to a dedicated portal API key.

1. Sign into the portal in your browser.
2. Open DevTools → Application → Cookies; find the `next-auth.session-token`
   cookie or whichever access-token cookie your portal uses.
3. Copy the JWT body and paste into `GRATIS_GIS_TOKEN`.

Tokens expire (typically minutes to hours). When the token expires the MCP
server will start returning 401 errors; sign back in and refresh the env
var. This is the rough edge Phase 1.5 smooths out.

## Why stdio transport

MCP clients spawn the server as a subprocess and pipe over stdin / stdout.
There is no port, no socket, no inbound network exposure to the user's
machine. The server is just a Node process that the MCP client owns.

## License

AGPL-3.0-or-later, same as the rest of GratisGIS.

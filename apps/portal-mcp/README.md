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
# From the repo root. This is a pnpm workspace: installing inside
# apps/portal-mcp instead would build a nested node_modules and
# bypass the lockfile.
pnpm install
pnpm --filter @gratis-gis/portal-mcp build

# Set the portal base URL + a portal API key (ggk_...)
export GRATIS_GIS_BASE_URL="https://gratisgis.org"
export GRATIS_GIS_TOKEN="ggk_..."

# Run directly to test
node apps/portal-mcp/dist/index.js
```

The server speaks the MCP stdio transport; running it directly from a
terminal is only useful for verifying the binary starts. Real usage is via
an MCP client.

Without `GRATIS_GIS_TOKEN` the server still starts and still answers
`list_tools`; every tool call returns the "token is not set" message as an
error. That is deliberate. It used to exit at startup instead, which an MCP
client could only report as a bare "server disconnected".

## Running it during development

This server is deliberately **not** part of `pnpm dev`. It is a stdio server
meant to be spawned by an MCP client, so it has no use as a watcher, and for
a while its absent-token exit took portal-api and portal-web down with it on
every fresh clone (discussion #238). To work on it:

```bash
pnpm --filter @gratis-gis/portal-mcp dev
```

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
        "GRATIS_GIS_TOKEN": "ggk_..."
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

## Getting a portal API key

Use a personal portal API key (`ggk_...`), not a browser session JWT.
Session tokens expire in minutes and will break MCP mid-conversation.

1. Sign into the portal.
2. Open **Profile -> API keys** (`/settings/api-keys`).
3. Mint a key (choose read-only unless you need writes later).
4. Copy the `ggk_...` secret once and set `GRATIS_GIS_TOKEN` to it.

Keys authenticate as `Authorization: Bearer <token>` against portal-api
the same way a JWT would; sharing and geo limits still apply as the key
owner. See `docs/auth-model.md` for storage and restrictions.

If `GRATIS_GIS_TOKEN` looks like a JWT (three dotted segments), the server
prints a warning at startup. On 401/403 responses it reminds you to mint
an API key.

## Why stdio transport

MCP clients spawn the server as a subprocess and pipe over stdin / stdout.
There is no port, no socket, no inbound network exposure to the user's
machine. The server is just a Node process that the MCP client owns.

## License

AGPL-3.0-or-later, same as the rest of GratisGIS.

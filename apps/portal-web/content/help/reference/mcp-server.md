---
id: reference-mcp-server
title: MCP server
summary: A small Model Context Protocol server that lets MCP-compatible AI clients read your portal (including the public Records catalog and a capped OpenStreetMap query) and, with a write-capable API key, run tools or create a data layer from GeoJSON.
category: reference
order: 50
complexity: advanced
tags:
  - mcp
  - integration
  - api
related:
  - reference-item-types
  - reference-api-keys
---

The GratisGIS MCP server lets compatible AI clients (desktop
assistants and code editors that speak the Model Context
Protocol) talk to your portal over plain HTTPS. The server is a
small standalone Node program that runs on the user's machine.

This is a power-user feature. Most viewers and contributors
will never need it. It's documented here for anyone who wants
to plug their portal into an MCP-compatible tool.

## What the MCP server can do

Read tools (safe with a read-only API key; `search_catalog`
works even without a key):

- **list_items**: paginated browse of items the caller can
  read, optionally filtered by item type and free-text query.
- **get_item**: full metadata for a single item by id.
- **read_layer_features**: GeoJSON FeatureCollection for a
  data layer, capped per call so a large layer doesn't fill
  the model's context window.
- **search_catalog**: search the portal's **public** OGC API
  Records catalog (`/api/public/ogc/collections/catalog/items`)
  by free text, item type, and optional bounding box. Returns
  only public items; private or org-shared items still need
  **list_items** with an API key. Caps: default 25 records
  (max 100); bbox area at most about 100 square degrees.
- **query_osm**: OpenStreetMap features for a required
  bounding box, via the portal's Overpass path. Pass iD
  preset ids (for example gas stations) or a relational
  "near" query. The area must stay within about one square
  degree, and results are capped (default 1000, max 5000)
  so continent-scale or unbounded queries are refused.

Write tools (need a key without the read-only flag):

- **run_tool**: run an existing portal tool item by id with
  the same inputs the browser uses.
- **create_data_layer_from_geojson**: create a private data
  layer from a GeoJSON FeatureCollection (thin facade over
  item create plus feature append).

Anything the bearer token can't do via the regular HTTP API,
the MCP server can't do either.

## How it runs

The MCP server is a Node.js script under `apps/portal-mcp/`
in the GratisGIS repo. It speaks the standard MCP stdio
transport: the client (your AI tool) spawns it as a
subprocess and talks to it over stdin / stdout. There's no
port to open, no socket to expose, and no inbound network
access required on your machine.

Every request the MCP server makes against your portal is a
normal authenticated HTTPS call, gated by the same permission
checks any other client gets.

## Setup

1. Clone the GratisGIS repo on the machine running the MCP
   client.
2. From the repo root: `cd apps/portal-mcp && npm install &&
   npm run build`.
3. Configure your MCP client to spawn the built binary,
   passing two environment variables:
   - `GRATIS_GIS_BASE_URL`: the URL of your portal API
     (typically the same domain your portal-web is served
     from, e.g. `https://gratisgis.org`).
   - `GRATIS_GIS_TOKEN`: a portal API key (`ggk_...` from
     Profile / API keys). Prefer an API key over a session
     JWT; JWTs expire quickly and are the wrong shape for a
     long-lived client config.
4. Restart the MCP client. The tools should appear in its
   tool palette under the server name you configured.

## Getting a token

Open **Profile**, then **API keys**, and create one named for
this client, for example `claude desktop`. Copy it into the
`GRATIS_GIS_TOKEN` environment variable in your MCP client
config.

- **Read only** if the client should only browse and inspect.
  Then no prompt can change your data through this connection.
- Leave read-only off only when you intentionally want
  `run_tool` or `create_data_layer_from_geojson`.

The key acts as the account that created it and keeps working
until it expires or you revoke it. See
[API keys](/help/reference/api-keys) for the details.

Earlier versions of this page told you to copy a session token
out of DevTools. That token expired within minutes and is no
longer the right approach.

## What an AI client can actually do with this

A few realistic prompts that work today, given a connected
portal:

- "What data layers do I have access to?"
- "Show me the first 200 features from the `parcels` layer
  near Charleston, WV."
- "Find all maps in my portal with `flood` in the title."
- "Search the public catalog for flood maps near Charleston."
- "Query OSM for gas stations inside this downtown bbox."
- With a write-capable key: "Create a private layer from this
  GeoJSON of survey points."

The AI client decides how to use the tools; the MCP server
just exposes the contracts.

## Privacy and audit

Every call the MCP server makes is logged by your portal-api
exactly the same way a browser request is. Audit logs,
sharing checks, geographic clips, and time-bounded scopes all
still apply. The MCP server is a thin facade; it doesn't
bypass any portal rules.

## Related

- [Item types](reference-item-types) for what you can ask
  list_items to filter by.
- [API keys](reference-api-keys) for minting and revoking keys.

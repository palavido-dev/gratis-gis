---
id: reference-mcp-server
title: MCP server
summary: A small Model Context Protocol server that exposes a read-only view of your portal to MCP-compatible AI clients.
category: reference
order: 50
complexity: advanced
tags:
  - mcp
  - integration
  - api
related:
  - reference-item-types
---

The GratisGIS MCP server lets compatible AI clients (desktop
assistants and code editors that speak the Model Context
Protocol) read items and layer features from your portal
directly. The server is a small standalone Node program that
runs on the user's machine and connects to the portal over
plain HTTPS.

This is a power-user feature. Most viewers and contributors
will never need it. It's documented here for anyone who wants
to plug their portal into an MCP-compatible tool.

## What the MCP server does in Phase 1

Three read-only tools:

- **list_items** — paginated browse of items the caller can
  read, optionally filtered by item type and free-text query.
- **get_item** — full metadata for a single item by id.
- **read_layer_features** — GeoJSON FeatureCollection for a
  data layer, capped per call so a large layer doesn't fill
  the model's context window.

Phase 2 will add write tools (run a tool, create a data layer
from GeoJSON).

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
   - `GRATIS_GIS_BASE_URL` — the URL of your portal API
     (typically the same domain your portal-web is served
     from, e.g. `https://gratisgis.org`).
   - `GRATIS_GIS_TOKEN` — a bearer token for an account with
     the permissions you want the AI client to use.
4. Restart the MCP client. The three tools should appear in
   its tool palette under the server name you configured.

## Getting a token

Use an API key. Open **Profile**, then **API keys**, and create
one named for this client, for example `claude desktop`. Copy
it into the `GRATIS_GIS_TOKEN` environment variable in your MCP
client config.

Because the MCP server only reads, tick **Read only** when you
create the key. Then no prompt, however creatively worded, can
change your data through this connection.

The key acts as the account that created it and keeps working
until it expires or you revoke it, so there is no mid-session
expiry to chase. See [API keys](/help/reference/api-keys) for
the details.

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

The AI client decides how to use the tools; the MCP server
just exposes the contracts. Anything the bearer token can't
do via the regular HTTP API, the MCP server can't do either.

## Privacy and audit

Every call the MCP server makes is logged by your portal-api
exactly the same way a browser request is. Audit logs,
sharing checks, geographic clips, and time-bounded scopes all
still apply. The MCP server is a thin facade; it doesn't
bypass any portal rules.

## Related

- [Item types](reference-item-types) for what you can ask
  list_items to filter by.

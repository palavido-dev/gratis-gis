# GratisGIS

[![CI](https://github.com/palavido-dev/gratis-gis/actions/workflows/ci.yml/badge.svg)](https://github.com/palavido-dev/gratis-gis/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![PostgreSQL + PostGIS](https://img.shields.io/badge/PostgreSQL%20%2B%20PostGIS-17%20%2F%203.5-336791?logo=postgresql&logoColor=white)](https://postgis.net/)

A self-hosted, open-source platform for geospatial portals: maps, layers, forms,
field data collection, dashboards, and reports. Runs on your own infrastructure.
Open file formats throughout (PostGIS, GeoJSON, MVT, OGC API). No license fees;
your only cost is the hardware (or cloud bill) you choose to run it on.

**Status:** Active development, pre-v1. Working today: the portal (items,
groups, sharing with row/column/geographic limits), web map authoring on
PostGIS-backed data layers with vector-tile rendering for large datasets,
Esri WebMap JSON import/export plus an ArcGIS Online content importer,
form authoring + submissions, App Builder (viewer, editor, and custom
widget apps), the offline-capable field PWA, derived-layer analysis
tools and a visual tool builder with OSM as a first-class source, live
PostgreSQL/PostGIS connections, print/PDF layouts, OGC API endpoints
(Features, Tiles, Styles, Records), an open MCP server, a QGIS plugin,
light and dark themes, five UI languages, and one-click sample data
that seeds a complete demonstration workspace. Underneath all of it is
the observation-log engine plus Cedar-based geometry-aware
authorization. 700+ backend tests, CI on every push.

**Try it:** [gratisgis.org](https://gratisgis.org) hosts a public test
instance during the open feedback period. The landing page lists test
credentials and the daily-reset window. The demo runs the bundled
Randolph County, West Virginia sample workspace, the same content the
in-app "Load sample data" button seeds on a fresh portal, so what you
explore there is what you get at home. Items, users, and edits made by
testers get rolled back every 24 hours to a curated golden state so
everyone gets a clean slate. Found a bug or want to chat?
[Open an issue](https://github.com/palavido-dev/gratis-gis/issues) or
start a [Discussion](https://github.com/palavido-dev/gratis-gis/discussions).

**A personal note:** This is a side project, not a startup. Built on
nights and weekends by one person with kids, a full-time job, and three
decades of GIS behind them, as a way to give back some of what working
in this field has given me. See [/why](https://gratisgis.org/why) on the
public instance for the longer version.

## Why GratisGIS

GratisGIS exists because operating a geospatial portal shouldn't require
six-figure annual licenses, named-user seats, or trusting your data to a
third party's cloud.

- **No per-user pricing.** Stand up one server, add as many users as you
  need. Adding a contractor for a six-week project doesn't reopen procurement.
- **Your hardware, your data.** PostGIS for vector data, MinIO for object
  storage. Both run inside your firewall. No data egress, no foreign
  jurisdictions, no hidden tenancy boundaries.
- **Open standards, in and out.** GeoJSON, OGC API Features, CSW / ISO 19115
  metadata, DCAT catalog, vector tiles. WebMap JSON import preserves the
  metadata (extent, basemap, layer list, symbology, popups) and the source
  URLs, so an AGO map referencing public FeatureServers renders against
  AGO's hosted data; cutting the cord fully requires a separate
  "stage as portal dataset" step. Export emits WebMap JSON pointing at the
  portal's own layer URLs (`GET /items/:id/web-map.json`); whether ArcGIS
  Pro / AGO / QGIS consume it natively depends on the importing tool's
  strictness and is worth testing in your environment.
  Beyond the AGO bridge, the project treats OGC API conformance
  (Features, Tiles, Styles, Records, etc.) as a guiding goal: anywhere a
  new surface can be shaped to match an OGC API standard at low extra cost,
  the OGC shape wins so QGIS, GDAL, OpenLayers, and other standards-aware
  tooling can consume the portal without bespoke connectors.
- **No proprietary file formats.** Your data lives in a documented
  Postgres + PostGIS schema with no opaque binary blobs. If GratisGIS
  disappears tomorrow, your data is still queryable with `psql` and
  dumpable with `pg_dump`.
- **Polished UX, not "engineer-built."** Open-source GIS has a long history of
  dated interfaces. GratisGIS targets the look and feel of modern consumer
  SaaS: considered typography, accessible components, motion that respects
  `prefers-reduced-motion`. See [docs/design-system.md](./docs/design-system.md).
- **Stand up in under 30 minutes.** A single command on a fresh Ubuntu box
  installs Docker, generates secrets, obtains a TLS cert, and prints your
  admin password. No license server, no multi-machine dance.

## The Six Pillars

1. **Portal**: users, groups, organizations, items, sharing, access control
2. **Web Maps**: interactive map authoring backed by PostGIS data layers,
   exportable to Esri WebMap JSON for ArcGIS Pro / AGO / QGIS consumption
3. **App Builder**: a WYSIWYG, widget-based builder for configurable web apps
4. **Data Collection**: a single web-and-mobile app with offline support for
   form-based collection, combining survey authoring and field geometry capture
5. **Reporting**: turn collected data into dashboards and document reports
6. **Tool & Widget Builder**: visual, node-graph authoring of custom
   geospatial tools and web-app widgets, friendly to non-developers

External clients (VS Code, RStudio, custom scripts) can connect to the
read-only portal data API with a personal access token. Share-level
geographic limits are still enforced server-side, so external clients
only see data the user has access to in-portal.

Underneath the pillars is the **observation-log engine**: a single
append-only feature substrate that gives the platform bitemporal time-travel
reads, free audit trails, and Cedar-based geometry-aware authorization.
See [docs/architecture/observation-log-engine.md](./docs/architecture/observation-log-engine.md)
and [docs/architecture/cedar-policy-integration.md](./docs/architecture/cedar-policy-integration.md).

## Built on

GratisGIS is built on a stack of open-source projects. Links go to
each project's home page; please consider supporting them directly.

### Stack at a glance

| Layer | Project |
| --- | --- |
| Language | [TypeScript](https://www.typescriptlang.org/) |
| Backend API | [Node.js](https://nodejs.org/) + [NestJS](https://nestjs.com/) |
| Database | [PostgreSQL](https://www.postgresql.org/) + [PostGIS](https://postgis.net/) |
| ORM / migrations | [Prisma](https://www.prisma.io/) |
| Auth / identity | [Keycloak](https://www.keycloak.org/) (OIDC) |
| Authorization | [Cedar](https://www.cedarpolicy.com/) (`@cedar-policy/cedar-wasm`) |
| Object storage | [MinIO](https://min.io/) (S3-compatible) |
| HTTP edge | [Caddy](https://caddyserver.com/) |
| Tile serving | [pg\_tileserv](https://github.com/CrunchyData/pg_tileserv) + in-house MVT controllers over PostGIS |
| Web frontend | [Next.js](https://nextjs.org/) (App Router) + [React](https://react.dev/) |
| Map rendering | [MapLibre GL](https://maplibre.org/) |
| Drawing tools | [Terra Draw](https://terradraw.io/) + [terra-draw-maplibre-gl-adapter](https://github.com/JamesLMilner/terra-draw) |
| Vector tile spec | [Mapbox Vector Tile](https://github.com/mapbox/vector-tile-spec) (via PostGIS `ST_AsMVT`) |
| Tile bundles | [PMTiles](https://github.com/protomaps/PMTiles) |
| Spatial indexing | [h3-js](https://github.com/uber/h3-js) |
| KML / GPX import | [@tmcw/togeojson](https://github.com/tmcw/togeojson) |
| Raster / vector I/O | [GDAL](https://gdal.org/) (via [`gdal-async`](https://github.com/mmomtchev/node-gdal-async)) |
| Component kit | [shadcn/ui](https://ui.shadcn.com/) (Radix primitives + Tailwind) |
| Charts | [Recharts](https://recharts.org/) |
| Icons | [lucide-react](https://lucide.dev/) |
| Markdown | [marked](https://marked.js.org/) |
| Styling | [Tailwind CSS](https://tailwindcss.com/) |
| Monorepo | [pnpm](https://pnpm.io/) + [Turborepo](https://turborepo.com/) |
| CI | [GitHub Actions](https://github.com/features/actions) |

Every load-bearing dependency is open-source. Where a project has
a narrow maintainer base and a wide surface, we track an internal
swap path so an abandoned upstream does not become an existential
threat.

## Repo Layout

```
gratis-gis/
├── apps/
│   ├── portal-api/        NestJS backend
│   ├── portal-web/        Next.js portal UI
│   └── (future) field-app, form-designer, app-builder,
│                report-builder, tool-builder
├── packages/
│   ├── shared-types/      Domain types shared across apps
│   ├── form-schema/       Form-definition types
│   └── ui/                Shared React component library
├── docs/                  Architecture and data-model docs
├── infra/                 Docker-compose and bootstrap scripts
└── .github/workflows/     CI
```

## Deploy for an Organization

GratisGIS is designed to be dramatically simpler to deploy than typical
enterprise GIS platforms. Three supported deployment modes:

| Mode | Good for | Time to first sign-in |
| --- | --- | --- |
| **Single-host Docker Compose** | 1–500 users, single VM | < 30 min |
| **Kubernetes via Helm** | 500+ users, HA needs | < 2 hours |
| **`gratisgis-installer` one-liner** | Fresh Ubuntu/Debian box | < 15 min |

```bash
# On a fresh Ubuntu 22.04 / Debian 12 server:
curl -fsSL https://get.gratisgis.org | sudo bash -s -- --domain portal.acme.org
# → installs Docker, pulls images, generates secrets, starts everything,
#   obtains a Let's Encrypt cert, prints the initial admin password.
```

See [docs/deployment.md](./docs/deployment.md) for full options, backup,
upgrade, and HA.

## Developer Quick Start

Prereqs: Node 20+, pnpm 9+, Docker Desktop, git.

```bash
# Clone and install
git clone https://github.com/<you>/gratis-gis.git
cd gratis-gis
pnpm install

# Start infra (Postgres/PostGIS, Keycloak, MinIO, pg_tileserv)
pnpm infra:up

# Run migrations and seed dev data
pnpm --filter @gratis-gis/portal-api db:migrate
pnpm --filter @gratis-gis/portal-api db:seed

# Start dev servers
pnpm dev
# -> portal-api  http://localhost:4000
# -> portal-web  http://localhost:3000
# -> keycloak    http://localhost:8080
# -> minio       http://localhost:9001
```

## Documentation

For new collaborators, start with these two:

- [docs/SETUP.md](./docs/SETUP.md): step-by-step local dev setup (Mac-focused, also covers Linux / WSL)
- [docs/walkthrough.md](./docs/walkthrough.md): quick orientation to the features that exist today, with AGO ↔ GratisGIS vocabulary mapping

Deeper design references:

- [ARCHITECTURE.md](./ARCHITECTURE.md): system design, services, boundaries
- [ROADMAP.md](./ROADMAP.md): phased delivery plan, milestones
- [docs/data-model.md](./docs/data-model.md): item, group, and sharing model
- [docs/sharing-granularity.md](./docs/sharing-granularity.md): per-user + column/row-level sharing design
- [docs/auth-model.md](./docs/auth-model.md): authentication and RBAC
- [docs/editing-and-collection.md](./docs/editing-and-collection.md): the Editor item type design
- [docs/folders.md](./docs/folders.md): folders + smart folders
- [docs/web-maps.md](./docs/web-maps.md): map composition + per-layer access matrix
- [docs/llm-integration.md](./docs/llm-integration.md): local-first LLM features (semantic search, authoring assistant, NL queries, RAG help)
- [docs/architecture/observation-log-engine.md](./docs/architecture/observation-log-engine.md): the engine substrate (observation log, lenses, bitemporal reads, provenance)
- [docs/architecture/cedar-policy-integration.md](./docs/architecture/cedar-policy-integration.md): Cedar as the policy engine, entity model, three-phase rollout
- [docs/tool-builder.md](./docs/tool-builder.md): visual tool/widget builder (planned)
- [docs/design-system.md](./docs/design-system.md): UI principles, tokens, components, the Contour brand
- [docs/sample-data.md](./docs/sample-data.md): the one-click Randolph County sample workspace
- [docs/deployment.md](./docs/deployment.md): how admins install and operate
- [docs/discoverability.md](./docs/discoverability.md): repo tags, badges, launch targets
- [CONTRIBUTING.md](./CONTRIBUTING.md): how to contribute

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See
[LICENSE](./LICENSE) for the full text.

In short: you are free to use, modify, self-host, and redistribute GratisGIS,
including in commercial settings. Hosting it as a service for others, or
running modified versions of it on a network, requires you to make the
corresponding source code available to your users under the same license.
Selling support, hosting, training, implementation, or custom integrations
around GratisGIS is fully compatible with this license; what is not is
wrapping it in a closed-source product and reselling it.

## Trademarks

GratisGIS is an independent open-source project, not affiliated with or
endorsed by any commercial GIS vendor. Any third-party product names, logos,
or trademarks referenced in this repository (including in code comments,
issue threads, or documentation) are the property of their respective
owners and appear only where necessary for descriptive interoperability.

---

> **Gratis** (Latin): *free*. No license fees; your only cost is the infrastructure you run it on.

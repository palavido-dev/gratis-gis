# GratisGIS

[![CI](https://github.com/palavido-dev/gratis-gis/actions/workflows/ci.yml/badge.svg)](https://github.com/palavido-dev/gratis-gis/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![PostgreSQL + PostGIS](https://img.shields.io/badge/PostgreSQL%20%2B%20PostGIS-17%20%2F%203.5-336791?logo=postgresql&logoColor=white)](https://postgis.net/)

A self-hosted GIS portal, field PWA, and QGIS plugin. Built for teams
that want data on their own hardware and want out of ArcGIS Online seat
licenses. What is credible today is the portal (items, groups, sharing),
field collection, and QGIS. It is not a full ArcGIS Online replacement,
and it is not a drop-in for Experience Builder, Survey123, Field Maps,
or enterprise identity depth.

**Status:** [v1.0.0](./CHANGELOG.md). The public surface follows
[semantic versioning](./docs/VERSIONING.md). For what ships today, see
[docs/walkthrough.md](./docs/walkthrough.md) and the
[changelog](./CHANGELOG.md). Store-listed native mobile apps are not
part of 1.0; the field PWA is the supported field client.

**Try it:** [gratisgis.org](https://gratisgis.org) is a public demo
(test credentials and a daily reset on the landing page). Same sample
workspace as in-app "Load sample data." Bugs and chat:
[Issues](https://github.com/palavido-dev/gratis-gis/issues) ·
[Discussions](https://github.com/palavido-dev/gratis-gis/discussions).

This is a side project, not a startup. Built on nights and weekends by
one person. Much of the code is written with AI coding agents; the
maintainer designs, directs, and is the final reviewer. See
[CONTRIBUTING.md](./CONTRIBUTING.md#how-this-project-is-built).

## Stack

| Layer | Project |
| --- | --- |
| Language | [TypeScript](https://www.typescriptlang.org/) |
| API | [Node.js](https://nodejs.org/) + [NestJS](https://nestjs.com/) |
| Database | [PostgreSQL](https://www.postgresql.org/) + [PostGIS](https://postgis.net/) |
| ORM | [Prisma](https://www.prisma.io/) |
| Auth | [Keycloak](https://www.keycloak.org/) (OIDC) |
| Authorization | [Cedar](https://www.cedarpolicy.com/) |
| Object storage | [MinIO](https://min.io/) |
| Edge | [Caddy](https://caddyserver.com/) |
| Tiles | [pg\_tileserv](https://github.com/CrunchyData/pg_tileserv) + PostGIS MVT |
| Web | [Next.js](https://nextjs.org/) + [React](https://react.dev/) |
| Maps | [MapLibre GL](https://maplibre.org/) + [Terra Draw](https://terradraw.io/) |
| Tile bundles | [PMTiles](https://github.com/protomaps/PMTiles) |
| Raster / vector I/O | [GDAL](https://gdal.org/) (`gdal-async`) |
| UI | [shadcn/ui](https://ui.shadcn.com/), Tailwind, lucide |
| Monorepo | [pnpm](https://pnpm.io/) + [Turborepo](https://turborepo.com/) |
| CI | [GitHub Actions](https://github.com/features/actions) |

## Repo layout

```
gratis-gis/
├── apps/
│   ├── portal-api/        NestJS backend
│   ├── portal-web/        Next.js portal (field PWA, app builder)
│   └── portal-mcp/        MCP server
├── packages/              engine, shared-types, form-schema, ui
├── tools/pointcloud-worker/
├── docs/
├── infra/                 Docker Compose, install, deploy
└── .github/workflows/
```

## Deploy

Single-host Docker Compose. A 4-core / 8 GB VPS is enough for a small
org (the public demo runs on that).

```bash
curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
```

Or by hand:

```bash
git clone https://github.com/palavido-dev/gratis-gis /opt/gratis-gis
cd /opt/gratis-gis
./infra/setup.sh
./infra/deploy.sh
./infra/doctor.sh
```

Installs track the latest release tag (`GG_REF` to pin). See
[docs/deployment.md](./docs/deployment.md) and
[docs/UPGRADING.md](./docs/UPGRADING.md).

## Developer quick start

Prereqs: Node 24.9+, pnpm 9+, Docker, git.

```bash
git clone https://github.com/palavido-dev/gratis-gis.git
cd gratis-gis
pnpm install
cp .env.example apps/portal-api/.env
cp .env.example apps/portal-web/.env
pnpm infra:up
pnpm --filter @gratis-gis/portal-api db:migrate
pnpm --filter @gratis-gis/portal-api db:seed
pnpm dev
# portal-api  :4000  ·  portal-web  :3000  ·  keycloak  :8080
```

## Docs

Start here:

- [docs/SETUP.md](./docs/SETUP.md) — local setup
- [docs/walkthrough.md](./docs/walkthrough.md) — features today
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute
- [docs/deployment.md](./docs/deployment.md) — install and operate

Deeper references live under [`docs/`](./docs/) (architecture, data
model, sharing, auth, design system, sample data, discoverability).
Roadmap: [ROADMAP.md](./ROADMAP.md). Architecture overview:
[ARCHITECTURE.md](./ARCHITECTURE.md).

## License

Copyright (C) 2026 Matt Palavido

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
See [LICENSE](./LICENSE).

You may use, modify, self-host, and redistribute, including
commercially. Hosting it as a network service (or running modified
versions on a network) requires offering corresponding source under
the same license. Selling support, hosting, training, or custom work
around it is fine; wrapping it in a closed-source product is not.

## Trademarks

GratisGIS is independent and not affiliated with or endorsed by any
commercial GIS vendor. Third-party names appear only for descriptive
interoperability.

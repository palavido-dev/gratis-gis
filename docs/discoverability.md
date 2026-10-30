# Discoverability

Notes on how we make GratisGIS easy to find on GitHub and the wider web
once the repo goes public. Re-read this before any release announcement.

## GitHub repo description

Recommended About text (206 characters; GitHub allows 350). It names
what ships today. It does not claim a visual tool builder. The app
builder is the widget builder, and dashboards are web-app layouts.
The QGIS plugin is the companion repo `gratis-gis-qgis`.

```
Self-hosted, open source GIS portal: web maps, PostGIS data layers, forms, an app builder with dashboards, an offline field PWA, OGC APIs, and a QGIS plugin. PostGIS + MapLibre + Keycloak on Docker Compose.
```

## GitHub topics (max 20)

Twenty topics. `react-native` is not one of them: the native client is
Kotlin in `clients/android`, and it is not released. `monorepo` and
`open-source` are dropped. `open-source-gis` stays.

```
gis
geospatial
mapping
webgis
open-source-gis
self-hosted
postgis
maplibre
offline-first
field-data-collection
form-builder
survey
keycloak
typescript
nextjs
nestjs
arcgis-alternative
qgis
ogc-api
pwa
```

Apply with the command below (bash line continuations; on Windows,
cmd.exe uses `^` and PowerShell uses a backtick instead of `\`):

```bash
gh repo edit <owner>/gratis-gis \
  --description "Self-hosted, open source GIS portal: web maps, PostGIS data layers, forms, an app builder with dashboards, an offline field PWA, OGC APIs, and a QGIS plugin. PostGIS + MapLibre + Keycloak on Docker Compose." \
  --homepage "https://gratisgis.org" \
  --remove-topic react-native --remove-topic monorepo --remove-topic open-source \
  --add-topic gis --add-topic geospatial --add-topic mapping --add-topic webgis \
  --add-topic open-source-gis --add-topic self-hosted \
  --add-topic postgis --add-topic maplibre --add-topic offline-first \
  --add-topic field-data-collection --add-topic form-builder --add-topic survey \
  --add-topic keycloak --add-topic typescript \
  --add-topic nextjs --add-topic nestjs \
  --add-topic arcgis-alternative --add-topic qgis --add-topic ogc-api --add-topic pwa
```

## README badges

Placed directly under the title so they render in listings. Keep the set
small; badge clutter looks unprofessional.

```markdown
[![CI](https://github.com/<owner>/gratis-gis/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/gratis-gis/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue)](https://www.typescriptlang.org/)
[![PostgreSQL + PostGIS](https://img.shields.io/badge/PostgreSQL%20%2B%20PostGIS-17%20%2F%203.5-336791?logo=postgresql&logoColor=white)](https://postgis.net/)
```

Keep the version badges in sync with `package.json` (TypeScript) and
`infra/postgres/Dockerfile` (PostgreSQL / PostGIS) when either is
bumped.

## package.json keywords

npm search and ecosystem tools index these. Added to root `package.json`.
`react-native` is not a keyword. The native client is Kotlin in
`clients/android`.

## Social preview image

GitHub lets us upload a 1280x640 PNG shown in link previews (Twitter,
Slack, etc.). Track this as a Phase 1 design task; it should show the
wordmark over a subtle map texture, matching the design system.

## Once public: outreach targets

- `awesome-gis` list (PR ourselves in)
- `awesome-self-hosted` list
- OSGeo news and mailing lists
- Hacker News "Show HN"
- `r/gis`, `r/selfhosted`
- Dev.to + Hashnode launch posts

Draft announcements live in `docs/marketing/` (TBD).

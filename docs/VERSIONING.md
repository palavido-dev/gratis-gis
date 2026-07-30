# Versioning policy

Releases are git tags named `vX.Y.Z`. Every release has a section in
[CHANGELOG.md](../CHANGELOG.md). The installer and the deploy script
pick the newest stable release tag by default; a tag with a suffix
(for example `v1.0.0-rc.1`) is a pre-release and is never picked
automatically. See [UPGRADING.md](./UPGRADING.md) for how to move
between releases.

## Before v1.0.0 (now)

- Versions are `0.MINOR.PATCH`, starting at v0.9.0.
- A minor bump (0.9 to 0.10) may include breaking changes to the
  public surface below. Every breaking change is called out in the
  release's changelog section with a line starting `Breaking:`.
- A patch bump (0.9.0 to 0.9.1) contains fixes, plus additions that
  are off by default and change nothing for a deployment that ignores
  them. It is always a safe upgrade: no configuration change, no
  behavior change you did not ask for.

## From v1.0.0 onward

Semantic versioning applies to the public surface: breaking changes
only in major releases, additions in minors, fixes in patches.

## The public surface (what the version number promises)

- The HTTP API served under `/api` on the portal hostname: the item,
  layer, feature, form, and export endpoints that external clients
  (scripts, QGIS, notebooks) call with a bearer token.
- The OGC API endpoints under `/api/public/ogc` (Features, Tiles,
  Styles, Records) and the other `/api/public` read surfaces. Where
  these track OGC specifications, the specification wins; conformance
  fixes are not treated as breaking.
- The MCP server's tool surface (`apps/portal-mcp`): tool names,
  inputs, and result shapes. There is no webhook surface today; if one
  ships, it joins this list.
- The deployment interface: `infra/install.sh` and `infra/deploy.sh`
  as entry points and their documented environment variables
  (`GG_REF`, `GRATIS_DIR`, `GRATIS_REPO`, `GRATISGIS_LOCK_FILE`), the
  variables in `infra/.env.prod.example`, and the compose service and
  volume names in `infra/docker-compose.prod.yml` that hold data
  (PostgreSQL, MinIO).
- The environment variables documented in `.env.example`. Renaming or
  repurposing one is a breaking change; adding one with a sensible
  default is not.

## Internal (may change in any release, no callout owed)

- The TypeScript packages under `packages/` and all code-level APIs.
  They are workspace-internal and are not published to npm.
- The database schema: Prisma models, engine tables, and indexes.
  Migrations move the schema forward on deploy; the supported
  contract is backups plus migrations rather than direct SQL access
  to a specific schema shape.
- Admin endpoints (`/api/admin/...`) and the portal-web BFF routes
  (`/api/portal/*`, `/api/auth/*`, `/api/geocode`). These are consumed
  by the bundled web UI and are versioned with it.
- The demo and maintenance tooling in `infra/` (golden snapshot,
  restore, seed scripts).
- Anything undocumented. If a behavior matters to you and is not
  listed above, open an issue asking for it to be covered; that is
  cheaper for everyone than depending on it silently.

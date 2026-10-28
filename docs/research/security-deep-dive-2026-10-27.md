# Security deep dive — 2026-10-27

Readonly application security review of GratisGIS for the autonomy
loop. Overall risk for a typical self-hosted instance: **low to
moderate**. Strong existing controls; highest actionable gaps are
AuthZ on derived-layer secondary sources and expression field-name
SQL embedding.

## Already solid

- Hashed `ggk_` API keys; read-only method allowlist; keys blocked
  on `/admin/*`.
- `safeFetch` + redirect re-check for SSRF on public proxy / probes.
- GDAL `assertSafeGdalOpenPath` (no `/vsicurl/`, VRT smuggling closed).
- Ingest root realpath + staging owner isolation.
- Anonymous markup opt-in + 30/min IP throttle; promote not public.
- Field `checkOnly` / dismiss / re-apply use normal edit ACL.
- Presence: single-use tickets, JWT not on WS URL, `canRead` gated.
- CI: `pnpm` audit (high/critical), Trivy FS + portal images, CodeQL.

## Findings to ship without input

| id | severity | summary |
| --- | --- | --- |
| SEC-otherSource-acl | High | Assert `canRead` on every pipeline `otherSource` (clip/erase/join/filter) on save, preview, recipe run, GeoJSON read; extend `extractDependencies`. (shipped #376) |
| SEC-expr-field-allowlist | High | Allowlist field identifiers at ingest + expression compile; stop quote-doubling-only SQL embed. (shipped #377) |
| SEC-ingest-zip-budget | Medium | Central-directory expansion budget before `/vsizip/` (reuse tile-conversion pattern). (shipped #378) |
| SEC-records-bbox-throttle | Medium | DB-side bbox or scan cap + tighter throttle on OGC Records. (shipped #379) |
| SEC-trivy-workers | Medium | Trivy matrix for `pointcloud-worker` and `script-runner`. (shipped #380) |
| SEC-jwt-aud | Medium | JWT `azp` allowlist for known clients (Keycloak omits `aud`). (shipped #381) |
| SEC-jwt-deletedAt | Medium | Mirror `deletedAt` on JWT auth path (API keys already check). (shipped #382) |
| SEC-ws-frame-cap | Low | Max Presence WebSocket frame size. (shipping) |

## Process

The autonomy **Security Sentinel** role (PLAYBOOK) runs this class of
checklist every work cycle and reports in the daily digest. Prefer
hardening PRs over waiting on the maintainer unless product or
Keycloak defaults are involved.

Private reports still go to the address in [SECURITY.md](../../SECURITY.md).

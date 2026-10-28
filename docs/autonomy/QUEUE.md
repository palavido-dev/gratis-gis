# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
| R7-i18n-erase-centroid-guides | research-cycle-7 | #162 Erase/Centroid Analyze chrome i18n | This PR |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| R7-analyze-dissolve-shortcut | research-cycle-7 | Analyze Dissolve → derived_layer | After dissolve help |
| R7-analyze-simplify-shortcut | research-cycle-7 | Analyze Simplify → derived_layer | Buffer-shaped |
| R7-recipe-aoi-honesty | research-cycle-7 | Recipe AOI hint: no wave-2 promise | Tiny copy |

## queued (needs-maintainer)

| id | source | summary | why blocked |
| --- | --- | --- | --- |
| Q-162b / R5-weblate-hosting | issue #162 | Weblate vs Crowdin vs Tolgee + community workflow | Process / hosting decision |
| Q-183b / R5-tile3d-heavy-clouds | issue #183 | COPC to 3D Tiles heavy-cloud path | Strategy phase B |
| R1-presence-crdt / R5-presence-crdt | research-cycle-1 | Live cursors Phase 2 CRDT on drawings | Abuse / transport defaults |
| R2-comments-mentions / R5-comments-mentions | research-cycle-2 / #155 | @-mentions on notifications | Abuse / email defaults |

## done

| id | when | result |
| --- | --- | --- |
| R7-contour-help-honesty | 2026-10-27 | Merged #390: contour help matches TIN iso-lines |
| R7-fishnet-help-honesty | 2026-10-27 | Merged #389: fishnet help matches square ST_SquareGrid |
| R7-dissolve-help-honesty | 2026-10-27 | Merged #388: dissolve help matches no-param ST_Union |
| Q-research-cycle-7 | 2026-10-27 | Merged #387: research-cycle-7 refill ship-without-input queue |
| R6-recipe-sink-honesty | 2026-10-27 | Merged #386: recipe sinks honest (no coming soon) |
| R6-mcp-search-catalog | 2026-10-27 | Merged #385: MCP search_catalog on public Records |
| R6-analyze-centroid-shortcut | 2026-10-27 | Merged #384: Analyze Centroid → PostGIS derived_layer |
| SEC-ws-frame-cap | 2026-10-27 | Merged #383: Presence WS max inbound frame 64 KiB |
| SEC-jwt-deletedAt | 2026-10-27 | Merged #382: refuse soft-deleted users on JWT path |
| SEC-jwt-aud | 2026-10-27 | Merged #381: JWT azp allowlist for known clients |
| SEC-trivy-workers | 2026-10-27 | Merged #380: Trivy matrix + worker image hardenings |
| SEC-records-bbox-throttle | 2026-10-27 | Merged #379: Records bbox scan cap + 60/min throttle |
| SEC-ingest-zip-budget | 2026-10-27 | Merged #378: zip expansion budget before /vsizip/ |
| R6-print-markup-kinds-help | 2026-10-27 | Merged #374: print help lists text/arrow/circle |
| SEC-expr-field-allowlist | 2026-10-27 | Merged #377: allowlist expression + ingest field names |
| R6-i18n-field-status-chrome | 2026-10-27 | Merged #373: field PWA Add-feature and status chrome i18n |
| SEC-otherSource-acl | 2026-10-27 | Merged #376: ACL-check derived-layer pipeline otherSource |
| Q-security-sentinel-ops | 2026-10-27 | Merged #375: Security Sentinel + hardenings queue |
| R6-i18n-analyze-guides | 2026-10-27 | Merged #372: Buffer/Clip Analyze chrome i18n (#162) |
| R6-analyze-erase-shortcut | 2026-10-27 | Merged #371: Analyze Erase → PostGIS derived_layer |
| R6-sync-conflict-dismiss | 2026-10-27 | Merged #370: Dismiss syncConflicts after review / re-apply |
| Q-research-cycle-6 | 2026-10-27 | Merged #369: research-cycle-6 refill ship-without-input queue |
| R5-arcgis-pull-to-local | 2026-10-27 | Merged #368: Copy selected FeatureServer layers to data_layer (50k cap) |
| R5-gdb-editor-server-ingest | 2026-10-27 | Merged #367: v3 Import stages .gdb via /ingest/stage |
| R5-android-conflict-reapply | 2026-10-27 | Merged #366: Android Re-apply / Recreate on rejected conflicts |
| R5-i18n-service-editors | 2026-10-27 | Merged #365: service / ArcGIS / OGC editor chrome i18n |
| R5-analyze-clip-shortcut | 2026-10-27 | Merged #364: Analyze Clip → PostGIS derived_layer recipe |
| R5-stac-ogc-help-honesty | 2026-10-27 | Merged #363: QGIS STAC help + honest OGC Features scope |
| Q-research-cycle-5 | 2026-10-27 | Merged #362: research-cycle-5 refill ship-without-input queue |

## rejected

| id | source | reason |
| --- | --- | --- |
| R7-reject-node-graph-canvas | research-cycle-7 | Visual node-graph recipe canvas is polish, not honesty |
| R7-reject-print-brand-kit | research-cycle-7 | Brand / chrome redesign fails playbook brand test |
| R7-reject-seat-pricing | research-cycle-7 | Named-user pricing contradicts ethos |
| R7-reject-recipe-materialize-sinks | research-cycle-7 | Materialize sinks deferred; honesty #386 points at derived_layer |
| R7-reject-tile3d-local-rebuild | research-cycle-7 | #183 stays open; no closing on local rebuilds |
| R7-reject-dissolve-groupby-feature | research-cycle-7 | Keyed dissolve stays on group-by; no second path |
| R6-reject-node-graph-canvas | research-cycle-6 | Visual node-graph recipe canvas is polish, not honesty |
| R6-reject-print-brand-kit | research-cycle-6 | Brand / chrome redesign fails playbook brand test |
| R6-reject-seat-pricing | research-cycle-6 | Named-user pricing contradicts ethos |
| R6-reject-recipe-materialize-sinks | research-cycle-6 | Materialize sinks deferred; honesty PR points at derived_layer |
| R6-reject-tile3d-local-rebuild | research-cycle-6 | #183 stays open; no closing on local rebuilds |

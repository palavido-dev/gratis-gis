# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
| R10-recipe-overpass-truncated-honesty | research-cycle-10 | Recipe OSM overlay truncated flag honesty | This PR |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| R10-analyze-random-sample-shortcut | research-cycle-10 | Analyze Random sample → PostGIS derived_layer | mode + value + seed |
| SEC-tools-run-throttle | research-cycle-10 | @Throttle 30/min on Public POST /api/tools/:id/run | Low; Overpass egress |

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
| R10-analyze-top-n-shortcut | 2026-10-28 | Merged #419: Analyze Top N → PostGIS derived_layer |
| R10-analyze-fishnet-shortcut | 2026-10-28 | Merged #418: Analyze Fishnet → PostGIS derived_layer |
| R10-analyze-nearest-neighbor-shortcut | 2026-10-28 | Merged #417: Analyze Nearest neighbor → PostGIS derived_layer |
| R10-data-collection-help-honesty | 2026-10-28 | Merged #416: Data collection help (offline, sync, QR) |
| R10-i18n-field-offline-gps-chrome | 2026-10-28 | Merged #415: Field offline / GPS / related chrome i18n (#162)
| Q-research-cycle-10 | 2026-10-28 | Merged #414: research-cycle-10 refill ship-without-input queue |
| R9-analyze-calculate-geometry-shortcut | 2026-10-28 | Merged #413: Analyze Calculate geometry → PostGIS derived_layer |
| R9-analyze-vertices-shortcut | 2026-10-28 | Merged #412: Analyze Vertices → PostGIS derived_layer |
| R9-analyze-bbox-shortcut | 2026-10-28 | Merged #411: Analyze Bounding boxes → PostGIS derived_layer |
| R9-i18n-field-collect-chrome | 2026-10-28 | Merged #410: Field collect / GPS / remove chrome i18n (#162) |
| R9-derived-layer-catalog-honesty | 2026-10-28 | Merged #409: derived-layer full step catalog + Analyze list |
| R9-sampling-nn-help-honesty | 2026-10-28 | Merged #408: Top N / Random sample / Nearest neighbor help |
| R9-spatial-filter-help-honesty | 2026-10-28 | Merged #407: Spatial filter help (predicates + otherSource) |
| R9-filter-help-honesty | 2026-10-28 | Merged #406: Filter help matches {{field}} expression dialect |
| Q-research-cycle-9 | 2026-10-28 | Merged #405: research-cycle-9 refill ship-without-input queue |
| R8-point-cloud-streaming-honesty | 2026-10-28 | Merged #404: point-cloud size-tier honesty (#183 open) |
| R8-analyze-densify-shortcut | 2026-10-27 | Merged #403: Analyze Densify → PostGIS derived_layer |
| R8-analyze-convex-hull-shortcut | 2026-10-27 | Merged #402: Analyze Convex hull → PostGIS derived_layer |
| R8-i18n-analyze-query-builder | 2026-10-27 | Merged #401: Analyze query-builder chrome i18n (#162) |
| R8-calculate-help-honesty | 2026-10-27 | Merged #400: Calculate vs Calculate geometry help honesty |
| R8-groupby-help-honesty | 2026-10-27 | Merged #399: group-by help matches aggregate ST_Union + ops |
| R8-spatial-join-help-honesty | 2026-10-27 | Merged #398: spatial-join help matches within/intersects/nearest |
| Q-research-cycle-8 | 2026-10-27 | Merged #397: research-cycle-8 refill ship-without-input queue |
| R7-recipe-aoi-honesty | 2026-10-27 | Merged #396: recipe AOI hint without wave-2 promise |
| R7-analyze-simplify-shortcut | 2026-10-27 | Merged #395: Analyze Simplify → PostGIS derived_layer |
| R7-analyze-dissolve-shortcut | 2026-10-27 | Merged #394: Analyze Dissolve → PostGIS derived_layer |
| R7-i18n-erase-centroid-guides | 2026-10-27 | Merged #392: Erase/Centroid Analyze chrome i18n (#162) |
| docs-every-commit | 2026-10-27 | Merged #393: docs ship in same PR as code |
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
| R10-reject-node-graph-canvas | research-cycle-10 | Visual node-graph recipe canvas is polish, not honesty |
| R10-reject-print-brand-kit | research-cycle-10 | Brand / chrome redesign fails playbook brand test |
| R10-reject-seat-pricing | research-cycle-10 | Named-user pricing contradicts ethos |
| R10-reject-recipe-materialize-sinks | research-cycle-10 | Materialize sinks deferred; honesty #386 points at derived_layer |
| R10-reject-tile3d-local-rebuild | research-cycle-10 | #183 stays open; no closing on local rebuilds |
| R10-reject-dissolve-groupby-feature | research-cycle-10 | Keyed dissolve stays on group-by; no second path |
| R10-reject-weblate-hosting | research-cycle-10 | Weblate vs Crowdin vs Tolgee stays needs-maintainer |
| R10-reject-analyze-contour-shortcut | research-cycle-10 | Contour levels/enrich heavier than Buffer-shaped; stay builder |
| R10-reject-analyze-multi-input-shortcuts | research-cycle-10 | Spatial join/filter multi-picker Analyze UX too heavy |
| R10-reject-analyze-calculate-field-shortcut | research-cycle-10 | Expression editor not a Buffer-shaped shortcut |
| R9-reject-node-graph-canvas | research-cycle-9 | Visual node-graph recipe canvas is polish, not honesty |
| R9-reject-print-brand-kit | research-cycle-9 | Brand / chrome redesign fails playbook brand test |
| R9-reject-seat-pricing | research-cycle-9 | Named-user pricing contradicts ethos |
| R9-reject-recipe-materialize-sinks | research-cycle-9 | Materialize sinks deferred; honesty #386 points at derived_layer |
| R9-reject-tile3d-local-rebuild | research-cycle-9 | #183 stays open; no closing on local rebuilds |
| R9-reject-dissolve-groupby-feature | research-cycle-9 | Keyed dissolve stays on group-by; no second path |
| R9-reject-weblate-hosting | research-cycle-9 | Weblate vs Crowdin vs Tolgee stays needs-maintainer |
| R8-reject-node-graph-canvas | research-cycle-8 | Visual node-graph recipe canvas is polish, not honesty |
| R8-reject-print-brand-kit | research-cycle-8 | Brand / chrome redesign fails playbook brand test |
| R8-reject-seat-pricing | research-cycle-8 | Named-user pricing contradicts ethos |
| R8-reject-recipe-materialize-sinks | research-cycle-8 | Materialize sinks deferred; honesty #386 points at derived_layer |
| R8-reject-tile3d-local-rebuild | research-cycle-8 | #183 stays open; no closing on local rebuilds |
| R8-reject-dissolve-groupby-feature | research-cycle-8 | Keyed dissolve stays on group-by; no second path |
| R8-reject-weblate-hosting | research-cycle-8 | Weblate vs Crowdin vs Tolgee stays needs-maintainer |
| R7-reject-node-graph-canvas | research-cycle-7 | Visual node-graph recipe canvas is polish, not honesty |
| R7-reject-print-brand-kit | research-cycle-7 | Brand / chrome redesign fails playbook brand test |
| R7-reject-seat-pricing | research-cycle-7 | Named-user pricing contradicts ethos |
| R7-reject-recipe-materialize-sinks | research-cycle-7 | Materialize sinks deferred; honesty #386 points at derived_layer |
| R7-reject-tile3d-local-rebuild | research-cycle-7 | #183 stays open; no closing on local rebuilds |
| R7-reject-dissolve-groupby-feature | research-cycle-7 | Keyed dissolve stays on group-by; no second path |
| R7-reject-weblate-hosting | research-cycle-7 | Weblate vs Crowdin vs Tolgee stays needs-maintainer |
| R6-reject-node-graph-canvas | research-cycle-6 | Visual node-graph recipe canvas is polish, not honesty |
| R6-reject-print-brand-kit | research-cycle-6 | Brand / chrome redesign fails playbook brand test |
| R6-reject-seat-pricing | research-cycle-6 | Named-user pricing contradicts ethos |
| R6-reject-recipe-materialize-sinks | research-cycle-6 | Materialize sinks deferred; honesty PR points at derived_layer |
| R6-reject-tile3d-local-rebuild | research-cycle-6 | #183 stays open; no closing on local rebuilds |

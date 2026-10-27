# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
<<<<<<< HEAD
| R6-i18n-field-status-chrome | research-cycle-6 | Field PWA status sheet i18n (#162) | This PR |
=======
| SEC-expr-field-allowlist | security-deep-dive-2026-10-27 | Allowlist field names in expressions + ingest | This PR |
| R6-i18n-field-status-chrome | research-cycle-6 | Field PWA status sheet i18n (#162) | #373 CI |
>>>>>>> fd38dcf7 (fix(security): allowlist expression and ingest field names)
| R6-print-markup-kinds-help | research-cycle-6 | Print help lists text/arrow/circle | #374 CI |
| SEC-expr-field-allowlist | security-deep-dive-2026-10-27 | Allowlist field names in expressions + ingest | #377 CI |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| SEC-ingest-zip-budget | security-deep-dive-2026-10-27 | Zip expansion budget before /vsizip/ | Medium |
| SEC-records-bbox-throttle | security-deep-dive-2026-10-27 | Records bbox scan cap + throttle | Medium |
| SEC-trivy-workers | security-deep-dive-2026-10-27 | Trivy matrix for worker images | Medium |
| SEC-jwt-aud | security-deep-dive-2026-10-27 | JWT audience allowlist | Medium |
| SEC-jwt-deletedAt | security-deep-dive-2026-10-27 | JWT path honors soft-deleted users | Medium |
| SEC-ws-frame-cap | security-deep-dive-2026-10-27 | Presence WS max frame size | Low |
| R6-analyze-centroid-shortcut | research-cycle-6 | Analyze Centroid → derived_layer | After Erase |
| R6-mcp-search-catalog | research-cycle-6 | MCP search_catalog on public Records | Power-user |
| R6-recipe-sink-honesty | research-cycle-6 | Recipe editor sinks: no coming soon lie | Honesty |

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
| R6-reject-node-graph-canvas | research-cycle-6 | Visual node-graph recipe canvas is polish, not honesty |
| R6-reject-print-brand-kit | research-cycle-6 | Brand / chrome redesign fails playbook brand test |
| R6-reject-seat-pricing | research-cycle-6 | Named-user pricing contradicts ethos |
| R6-reject-recipe-materialize-sinks | research-cycle-6 | Materialize sinks deferred; honesty PR points at derived_layer |
| R6-reject-tile3d-local-rebuild | research-cycle-6 | #183 stays open; no closing on local rebuilds |

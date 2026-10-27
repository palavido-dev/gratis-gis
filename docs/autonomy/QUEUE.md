# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| R5-stac-ogc-help-honesty | research-cycle-5 | STAC QGIS help + honest OGC Features scope | Docs first |
| R5-analyze-clip-shortcut | research-cycle-5 | Guided Clip → derived_layer (mirror Buffer) | |
| R5-i18n-service-editors | research-cycle-5 | Service / ArcGIS / OGC editor chrome i18n (#162) | No Weblate / RTL |
| R5-android-conflict-reapply | research-cycle-5 | Android re-apply rejected sync conflicts | After #360 |
| R5-gdb-editor-server-ingest | research-cycle-5 | Data-layer editor .gdb via server GDAL ingest | Honesty |
| R5-arcgis-pull-to-local | research-cycle-5 | Copy ArcGIS FeatureServer layers to data_layer | Caps required |

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
| R4-i18n-string-sweep-4 | 2026-10-27 | Merged #361: form paired-layer sharing notice i18n |
| R4-android-field-delta | 2026-10-27 | Merged #360: Android offline refresh via delta?since=N |
| R4-analyze-buffer-derived | 2026-10-27 | Merged #359: Analyze Buffer → PostGIS derived_layer recipe |
| R4-postgis-help-schema-browser | 2026-10-27 | Merged #358: capped table preview + honest PostGIS help |
| R4-offline-checkonly | 2026-10-27 | Merged #357: checkOnly before offline update/delete sync |
| R4-drawings-geojson-export | 2026-10-27 | Merged #356: markup panel GeoJSON download |
| R3-mcp-query-osm | 2026-10-27 | Merged #354: MCP `query_osm` + capped `GET /api/osm/query` |
| R3-sync-conflict-reapply | 2026-10-27 | Merged #353: re-apply losing syncConflicts from layer data panel |
| R3-dashboard-filter-widget | 2026-10-27 | Merged #352: help for existing Filter widget + cross-filter |
| R3-anonymous-markup | 2026-10-27 | Merged #351: anonymous markup when `allowAnonymousDrawings` |
| R3-field-delta-sync | 2026-10-27 | Merged #350: field offline pull via `delta?since=N` |
| R2-i18n-tile-layer-errors | 2026-10-27 | Merged #348: tile-layer editor error/progress i18n |
| R2-form-touch-reorder | 2026-10-27 | Merged #347: form designer up/down reorder for touch |
| R2-i18n-chrome-sweep | 2026-10-27 | Merged #346: error / receipts / terrain-chip chrome i18n |
| R2-citation-export | 2026-10-27 | Merged #345: BibTeX / RIS / JSON-LD citation export |
| R2-presence-websocket | 2026-10-27 | Merged #343: Nest WS presence + HTTP fallback |
| Q-docs-whats-new | 2026-10-27 | Merged #344: What's new + help + GitHub docs catch-up |
| R2-ogc-records-auth-docs | 2026-10-27 | Help API Records + MetaSearch catalog path; Aardvark/DCAT noted |
| R2-delta-sync-client-hint | 2026-10-27 | Help documents `delta?since=N` + syncConflicts review |
| R2-markup-annotation-kinds | 2026-10-27 | Merged #342: markup text / arrow / circle tools |
| R2-mcp-write-tools | 2026-10-27 | Merged #341: MCP run_tool + create_data_layer_from_geojson |
| R2-mcp-api-key-auth | 2026-10-27 | Merged #340: MCP prefers ggk_ API keys; JWT soft-warn |
| R2-sync-conflict-review-ui | 2026-10-27 | Merged #339: layer data panel lists syncConflicts |
| R2-lidar-dep-bump | 2026-10-27 | Merged #338: maplibre-gl-lidar 0.21; local overlay patch dropped |
| Q-R2a / R2-drawings-in-print | 2026-10-27 | Merged #337: print PDF paints visible markup drawings |
| Q-183a / R1-lidar-incremental-writeup | 2026-10-27 | Merged #336: research note; #183 stays open |
| Q-162a / R1-i18n-string-sweep | 2026-10-27 | Merged #335: terrain analysis panel i18n (`demAnalysis.*`) |
| R1-zonal-stats-primitive | 2026-10-27 | Merged #334: zonal stats analysis job + elevation UI |
| R1-meta-ui-viewer-hint | 2026-10-27 | Merged #333: server-computed `meta.ui` on item detail |
| R1-dcat-themes-aardvark | 2026-10-27 | Merged #332: curated themes + Aardvark export |
| R1-feature-anchored-comments | 2026-10-27 | Merged #331: feature- and markup-anchored comment threads |
| R1-drawings-lines-promote | 2026-10-27 | Merged #330: markup line/polygon tools + promote to data_layer |
| R1-sync-conflict-artifact | 2026-10-27 | Merged #329: checkOnly + layer syncConflicts artifacts |
| R1-layer-delta-sync | 2026-10-27 | Merged #328: layer syncVersion + GET .../delta?since=N |
| R1-records-metasearch | 2026-10-27 | Merged #327: `/collections/catalog` searchable-catalog for MetaSearch |
| Q-rel-09118 | 2026-10-27 | Tagged v0.9.118; app images on prod. PG18 boot failed; host rolled back to PG17 |
| Q-hotfix-pg17 | 2026-10-27 | Prod restored (site 200, PG 17.5). Tagged v0.9.119 on main |

## rejected

| id | source | reason |
| --- | --- | --- |
| R5-reject-node-graph-canvas | research-cycle-5 | Visual node-graph recipe canvas is polish, not honesty |
| R5-reject-print-brand-kit | research-cycle-5 | Brand / chrome redesign fails playbook brand test |
| R2-reject-ogc-cql2 | research-cycle-2 | CQL2 parked for v2; MetaSearch will not use it |
| R2-reject-print-brand-kit | research-cycle-2 | Brand / chrome redesign fails playbook brand test |
| R1-reject-brand-print-chrome | research-cycle-1 | Brand / chrome redesign fails playbook brand test |
| R1-reject-weblate-rtl | research-cycle-1 | Hosting + RTL are maintainer calls |
| R1-reject-seat-pricing | research-cycle-1 | Named-user pricing contradicts ethos |

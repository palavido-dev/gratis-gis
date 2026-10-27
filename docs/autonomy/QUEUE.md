# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
| Q-R2a / R2-drawings-in-print | research-cycle-2 / #159 | Markup drawings on print/PDF | PR #337 on `cursor/drawings-in-print-2838` |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| R2-lidar-dep-bump | research-cycle-2 / #183 | Bump maplibre-gl-lidar 0.21; drop local patch | After drawings-in-print |
| R2-sync-conflict-review-ui | research-cycle-2 / #329 | Surface syncConflicts in portal UI | Completes conflict artifacts |
| R2-mcp-api-key-auth | research-cycle-2 / #219 | MCP docs/examples use ggk_ API keys | Before write tools |
| R2-mcp-write-tools | research-cycle-2 / #161 | MCP run_tool + create_data_layer_from_geojson | After API-key auth docs |
| R2-markup-annotation-kinds | research-cycle-2 / #154 | text / arrow / circle markup tools | After drawings-in-print |
| R2-presence-websocket | research-cycle-2 / #156 | Nest WS for presence; HTTP fallback | Not Yjs CRDT |
| R2-citation-export | research-cycle-2 / #116 | BibTeX / RIS / JSON-LD on public items | |
| R2-i18n-chrome-sweep | issue #162 | Bounded chrome string extraction | No Weblate |
| R2-form-touch-reorder | research-cycle-2 | Form designer up/down on touch | |
| R2-ogc-records-auth-docs | research-cycle-2 / #116 | MetaSearch public vs private docs | |
| R2-delta-sync-client-hint | research-cycle-2 / #328 | Document delta?since=N | |

## queued (needs-maintainer)

| id | source | summary | why blocked |
| --- | --- | --- | --- |
| Q-162b | issue #162 | Weblate vs Crowdin vs Tolgee + community workflow | Process / hosting decision |
| Q-183b / R1-tile3d-heavy-clouds | issue #183 | COPC → 3D Tiles heavy-cloud path | Strategy phase B |
| R1-presence-crdt | research-cycle-1 | Live cursors Phase 2 CRDT on drawings | Abuse / transport defaults |
| R2-comments-mentions | research-cycle-2 / #155 | @-mentions on notifications | Abuse / email defaults |

## done

| id | when | result |
| --- | --- | --- |
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
| R2-reject-ogc-cql2 | research-cycle-2 | CQL2 parked for v2; MetaSearch will not use it |
| R2-reject-print-brand-kit | research-cycle-2 | Brand / chrome redesign fails playbook brand test |
| R1-reject-brand-print-chrome | research-cycle-1 | Brand / chrome redesign fails playbook brand test |
| R1-reject-weblate-rtl | research-cycle-1 | Hosting + RTL are maintainer calls |
| R1-reject-seat-pricing | research-cycle-1 | Named-user pricing contradicts ethos |

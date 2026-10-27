# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
| Q-183a / R1-lidar-incremental-writeup | issue #183 | Upstream incremental-append research note | Branch `cursor/lidar-incremental-writeup-2838`; do not close #183 |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| *(empty — research cycle 2 next)* | | | |

## queued (needs-maintainer)

| id | source | summary | why blocked |
| --- | --- | --- | --- |
| Q-162b | issue #162 | Weblate vs Crowdin vs Tolgee + community workflow | Process / hosting decision |
| Q-183b / R1-tile3d-heavy-clouds | issue #183 | COPC → 3D Tiles heavy-cloud path | Strategy phase B |
| R1-presence-crdt | research-cycle-1 | Live cursors Phase 2 CRDT on drawings | Abuse / transport defaults |

## done

| id | when | result |
| --- | --- | --- |
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
| R1-reject-brand-print-chrome | research-cycle-1 | Brand / chrome redesign fails playbook brand test |
| R1-reject-weblate-rtl | research-cycle-1 | Hosting + RTL are maintainer calls |
| R1-reject-seat-pricing | research-cycle-1 | Named-user pricing contradicts ethos |

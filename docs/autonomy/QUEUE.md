# Autonomy work queue

Driver-owned. Newest proposals at the top of each section.

## in-progress

| id | source | summary | notes |
| --- | --- | --- | --- |
| R1-sync-conflict-artifact | research-cycle-1 | `checkOnly` dry run + recoverable conflict artifacts | Branch `cursor/sync-conflict-artifact-2838` |

## queued (ship-without-input)

| id | source | summary | notes |
| --- | --- | --- | --- |
| R1-drawings-lines-promote | research-cycle-1 | Drawings Phase 1.5: line/polygon + promote to data layer | #154 |
| R1-feature-anchored-comments | research-cycle-1 | Feature-anchored comment threads | #155; after drawings kinds help |
| R1-dcat-themes-aardvark | research-cycle-1 | DCAT themes + Aardvark export | #116 |
| R1-meta-ui-viewer-hint | research-cycle-1 | Server-computed `meta.ui` viewer hint | Web + QGIS alignment |
| R1-zonal-stats-primitive | research-cycle-1 | Zonal statistics recipe step | Analysis tier |
| Q-162a / R1-i18n-string-sweep | issue #162 | Continue portal string extraction | Skip Weblate / locale switcher |
| Q-183a / R1-lidar-incremental-writeup | issue #183 | Upstream incremental-append research note | Do not close #183 |

## queued (needs-maintainer)

| id | source | summary | why blocked |
| --- | --- | --- | --- |
| Q-162b | issue #162 | Weblate vs Crowdin vs Tolgee + community workflow | Process / hosting decision |
| Q-183b / R1-tile3d-heavy-clouds | issue #183 | COPC → 3D Tiles heavy-cloud path | Strategy phase B |
| R1-presence-crdt | research-cycle-1 | Live cursors Phase 2 CRDT on drawings | Abuse / transport defaults |

## done

| id | when | result |
| --- | --- | --- |
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

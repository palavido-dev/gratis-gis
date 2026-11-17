# Research cycle 16 (summary for driver)

Driver id: `bc-e603b55a-71c9-500f-bec9-801907eb3974`. Artifacts: `research-cycle-16.json`.

**Drain first.** R15 ship-without-input is empty on origin/main (all nine items merged through #483-#491). No open R15 PRs to wait on. Live demo through v0.9.123; main ahead with R15 SEC + i18n + what-is honesty.

**Security Sentinel:** clean. After R15 SEC PRs, next Low list-class Public budgets: landing, items/:id, basemap items list, osm/presets, thumbnail.svg. Do not Nest-throttle MVT / OGC Tiles / storage / point-cloud / health / portal-info. pnpm audit high clean (1 low only).

**Ship-without-input (9), queueOrder:**
1. SEC-public-landing-throttle (60/min)
2. SEC-public-item-throttle (60/min)
3. SEC-public-basemap-items-throttle (60/min)
4. SEC-osm-presets-throttle (60/min)
5. SEC-thumbnail-svg-throttle (60/min)
6. R16-i18n-basemap-config-section-chrome (#162)
7. R16-i18n-print-parameters-chrome (#162)
8. R16-i18n-point-cloud-panel-chrome (#162)
9. R16-basemap-help-composed-map-honesty

**Needs-maintainer (unchanged):** Weblate hosting (#162), Tile3D / heavy clouds (#183), presence CRDT, comments @-mentions.

**Rejected again:** node-graph, brand/print redesign, seat pricing, recipe materialize, multi-input / calculate-field / filter Analyze shortcuts, report-template impl, byte-stream + health/portal-info Nest throttle, custom-app builder i18n-first, zonal-stats Analyze shortcut, High dep bump (none). Deferred: geocoding/geo-boundary unsaved chrome, osm-relational chrome, STAC/OGC static landing docs throttle.

Open issues remain #162 and #183 only. Live demo through v0.9.123.

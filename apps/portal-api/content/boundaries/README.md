# Vendored boundary lookups (#160 Phase 2)

- `us-states.geojson` — US state + DC + PR polygons with `name` and
  `abbr` properties. Derived from the PublicaMundi MappingAPI states
  file (Cartographic Boundary lineage; public domain). Density and
  other non-identity attributes were stripped; USPS abbreviations were
  added for abbreviation matching.

- `us-counties.geojson` — US county / equivalent polygons (Census
  Cartographic Boundary 2023, 20 m) with `name`, `state_abbr`,
  `state_name`, and `geoid`. Public domain. ~1.7 MB.

Used by `src/ingest/csv-geomatch.ts` when a CSV has a county or state
name column and no coordinate pair. Counties are preferred when a
county-like column validates; otherwise states.

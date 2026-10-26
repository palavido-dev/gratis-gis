# Vendored boundary lookups (#160 Phase 2)

`us-states.geojson` — US state + DC + PR polygons with `name` and
`abbr` properties. Derived from the PublicaMundi MappingAPI states
file (Cartographic Boundary lineage; public domain). Density and
other non-identity attributes were stripped; USPS abbreviations were
added for abbreviation matching.

Used by `src/ingest/csv-geomatch.ts` when a CSV has a state-name
column and no coordinate pair.

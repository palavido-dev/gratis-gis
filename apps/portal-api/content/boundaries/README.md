# Vendored boundary lookups (#160 Phase 2)

- `us-states.geojson` — US state + DC + PR polygons with `name` and
  `abbr` properties. Derived from the PublicaMundi MappingAPI states
  file (Cartographic Boundary lineage; public domain). Density and
  other non-identity attributes were stripped; USPS abbreviations were
  added for abbreviation matching.

- `us-counties.geojson` — US county / equivalent polygons (Census
  Cartographic Boundary 2023, 20 m) with `name`, `state_abbr`,
  `state_name`, and `geoid`. Public domain. ~1.7 MB.

- `us-zctas.geojson` — US ZIP Code Tabulation Area polygons (Census
  Cartographic Boundary 2020 ZCTA5 500k, geometry simplified) with a
  `zcta` property. Public domain. ~27 MB.

- `countries.geojson` — Natural Earth 110m admin-0 countries with
  `name`, `iso2`, `iso3`, and common `aliases` (USA/UK/…). Public
  domain. ~0.2 MB.

Used by `src/ingest/csv-geomatch.ts` when a CSV has a county, ZIP/ZCTA,
country, or state name column and no coordinate pair. Preference order:
counties → ZCTAs → countries → states.

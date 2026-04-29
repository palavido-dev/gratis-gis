-- Add the `derived-layer` variant to ItemType. A derived_layer item
-- holds a recipe (source data_layer + ordered tool pipeline) and
-- computes its features at read time on top of the source's PostGIS
-- table. v1 ships with one tool (buffer); the registry is designed
-- so future tools (dissolve, intersect, centroid, ...) plug in
-- without further enum migrations.
-- Enum alters run standalone per Postgres rules.
ALTER TYPE "ItemType" ADD VALUE 'derived-layer';

-- Task #52 follow-on: let an item_share reference a geo_boundary item
-- by id instead of inlining the polygon every time. The two columns
-- are mutually exclusive at the API layer (sharing.service treats
-- non-null geoBoundaryId as the source of truth and clears geoLimit
-- on any update that names a boundary, and vice versa).
--
-- We don't add a database FK to `item` here because `item` is a
-- polymorphic table covering every item type (geo_boundary, basemap,
-- map, etc.) and Postgres cannot enforce "FK + type check" cleanly
-- without a trigger. The sharing service dereferences this id at
-- request time and treats a missing or wrong-typed target as
-- "no clip" so a deleted boundary cannot silently expand access.

ALTER TABLE "item_share"
  ADD COLUMN "geo_boundary_id" UUID;

CREATE INDEX "item_share_geo_boundary_id_idx"
  ON "item_share"("geo_boundary_id");

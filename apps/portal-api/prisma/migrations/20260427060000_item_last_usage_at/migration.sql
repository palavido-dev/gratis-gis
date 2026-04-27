-- #96: stamp last user-initiated proxy request on each item.
-- Drives the stale-item heuristic for arcgis_service items (which
-- have no feature edits to track) and complements item.updatedAt
-- + v3 feature activity for the rest.
ALTER TABLE "item" ADD COLUMN "last_usage_at" TIMESTAMPTZ;

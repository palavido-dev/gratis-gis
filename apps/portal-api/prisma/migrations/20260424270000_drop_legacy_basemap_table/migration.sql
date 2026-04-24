-- Phase 1b of the basemap refactor (task #74 effectively folded into
-- #72 after Matt reaffirmed that basemaps belong in the items model,
-- not on a standalone admin surface). Drop the legacy `basemap` table
-- and its `BasemapSourceKind` enum now that:
--   - /admin/basemaps has been removed from the portal-web admin nav
--     and its page files deleted
--   - The Nest BasemapsModule (controller + service) has been deleted
--     so nothing else hits /api/basemaps
--   - The map detail page (apps/portal-web/src/app/items/[id]/page.tsx)
--     reads basemaps from /api/items?type=basemap instead of
--     /api/basemaps, with a BasemapData -> CustomBasemap transform
--
-- Existing rows were migrated into `item` rows with type=basemap by
-- 20260424260100_backfill_basemap_items so nothing is lost. In Matt's
-- current dev DB the legacy table is empty anyway.

DROP TABLE IF EXISTS "basemap";

DROP TYPE IF EXISTS "BasemapSourceKind";

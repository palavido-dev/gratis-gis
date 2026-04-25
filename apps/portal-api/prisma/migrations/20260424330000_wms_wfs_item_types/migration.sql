-- Add `wms_service` and `wfs_service` to the ItemType enum (#35).
-- Both follow the arcgis_service pattern: a thin pointer at a remote
-- service plus a curated layer-selection mixin. No data migrations
-- needed; existing rows are untouched and the new values become
-- available for new inserts.
--
-- Per Postgres rules ALTER TYPE ADD VALUE runs standalone, so each
-- value gets its own statement.

ALTER TYPE "ItemType" ADD VALUE 'wms-service';
ALTER TYPE "ItemType" ADD VALUE 'wfs-service';

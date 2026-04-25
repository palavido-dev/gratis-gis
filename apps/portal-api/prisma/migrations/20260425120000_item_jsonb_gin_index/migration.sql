-- Index hot-path queries that hit the item table on every items
-- list call.
--
-- Two indexes:
--
-- 1. GIN on data_json with jsonb_path_ops. The folder code
--    (sharing.service.ts inheritedSharesForFolder /
--    inheritedSharesForItem, items.service.ts spliceFromFolders)
--    uses `data @> jsonb_build_object('childItemIds', ...)` to find
--    folders that reference a given item id. Without an index that
--    is a sequential scan over every item row in the org, parsing
--    the full data_json blob each time. arcgis_service items can
--    carry hundreds of KB of layer metadata in data_json, so the
--    scan is not just slow in row count but in bytes touched.
--
--    jsonb_path_ops is the right opclass for `@>` containment
--    queries: it indexes only the value path used in containment
--    (no key existence operators), which is what every JSONB query
--    in the codebase uses today. Smaller and faster than the default
--    jsonb_ops.
--
-- 2. Composite (org_id, type, deleted_at). The all-items list and
--    the per-type list (the Add Layer dialog Portal tab fires two
--    of these in parallel for `data_layer` and `arcgis_service`)
--    both narrow on these three columns. The existing single-column
--    indexes on type / deletedAt let the planner use one or the
--    other but not both at once. A composite covers the common
--    visibleWhere predicate (orgId match + non-trash) AND the
--    ?type= filter without falling back to a bitmap heap scan.

CREATE INDEX IF NOT EXISTS "item_data_gin"
  ON "item"
  USING gin (data_json jsonb_path_ops);

CREATE INDEX IF NOT EXISTS "item_org_type_deleted_idx"
  ON "item" ("org_id", "type", "deleted_at");

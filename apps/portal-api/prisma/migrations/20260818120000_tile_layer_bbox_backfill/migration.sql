-- Backfill item.bbox for tile_layer and point_cloud items (#16).
--
-- itemBbox() had no case for either type, so their extents were
-- computed at finalize and stored in data_json while the cached
-- item.bbox column stayed empty forever. The code fix (a switch case
-- in item-bbox.ts) covers every upload from now on; this copies the
-- already-computed values across for the rows that predate it.
--
-- Notes for the reader:
--   * item.type stores the kebab-case enum values ('tile-layer',
--     'point-cloud'), not the TypeScript snake_case spellings. Raw
--     SQL against item.type must always use the kebab forms.
--   * Guarded by cardinality(bbox) = 0 so a row that somehow has an
--     extent already (for example via a manual fix on prod) is left
--     alone rather than overwritten.
--   * The jsonb_typeof / length / numeric checks mirror what
--     readBboxField() accepts, so the migration cannot write a shape
--     the code would have refused.

UPDATE "item"
SET "bbox" = ARRAY[
  ("data_json"->'bbox'->>0)::double precision,
  ("data_json"->'bbox'->>1)::double precision,
  ("data_json"->'bbox'->>2)::double precision,
  ("data_json"->'bbox'->>3)::double precision
]
WHERE "type" = 'tile-layer'
  AND cardinality("bbox") = 0
  AND jsonb_typeof("data_json"->'bbox') = 'array'
  AND jsonb_array_length("data_json"->'bbox') = 4
  AND jsonb_typeof("data_json"->'bbox'->0) = 'number'
  AND jsonb_typeof("data_json"->'bbox'->1) = 'number'
  AND jsonb_typeof("data_json"->'bbox'->2) = 'number'
  AND jsonb_typeof("data_json"->'bbox'->3) = 'number';

UPDATE "item"
SET "bbox" = ARRAY[
  ("data_json"->'bboxWgs84'->>0)::double precision,
  ("data_json"->'bboxWgs84'->>1)::double precision,
  ("data_json"->'bboxWgs84'->>2)::double precision,
  ("data_json"->'bboxWgs84'->>3)::double precision
]
WHERE "type" = 'point-cloud'
  AND cardinality("bbox") = 0
  AND jsonb_typeof("data_json"->'bboxWgs84') = 'array'
  AND jsonb_array_length("data_json"->'bboxWgs84') = 4
  AND jsonb_typeof("data_json"->'bboxWgs84'->0) = 'number'
  AND jsonb_typeof("data_json"->'bboxWgs84'->1) = 'number'
  AND jsonb_typeof("data_json"->'bboxWgs84'->2) = 'number'
  AND jsonb_typeof("data_json"->'bboxWgs84'->3) = 'number';

-- After 20260424280000_seed_builtin_basemaps inserts a basemap item
-- per built-in key per org, rewrite every map item's reference to use
-- the new item UUID instead of the legacy key string.
--
-- Before:  data_json.basemap = 'positron'
--          data_json.customBasemapId = '<uuid>'   (optional, preferred)
-- After:   data_json.basemap = '<uuid>'           (single field)
--          customBasemapId removed.
--
-- Priority: if customBasemapId is set AND the referenced basemap
-- item still exists, use that. Otherwise look up the seeded built-in
-- item with data_json.seededKey matching the old string key in the
-- same org.
--
-- Maps whose basemap key does not match any seeded built-in (should
-- not happen in dev but is possible in the wild) get fallen back to
-- the org's positron seed so the map still renders.

WITH resolved AS (
  SELECT
    m."id"        AS map_id,
    COALESCE(
      -- 1. honour an existing customBasemapId if the item still exists
      (SELECT c."id"
         FROM "item" c
         WHERE c."org_id" = m."org_id"
           AND c."type" = 'basemap'::"ItemType"
           AND c."id"::text = m."data_json"->>'customBasemapId'
         LIMIT 1),
      -- 2. find the seeded built-in with the matching key
      (SELECT s."id"
         FROM "item" s
         WHERE s."org_id" = m."org_id"
           AND s."type" = 'basemap'::"ItemType"
           AND s."data_json"->>'seededKey' = m."data_json"->>'basemap'
         LIMIT 1),
      -- 3. fall back to the org's positron seed
      (SELECT s."id"
         FROM "item" s
         WHERE s."org_id" = m."org_id"
           AND s."type" = 'basemap'::"ItemType"
           AND s."data_json"->>'seededKey' = 'positron'
         LIMIT 1)
    ) AS resolved_basemap_id
  FROM "item" m
  WHERE m."type" = 'map'::"ItemType"
)
UPDATE "item" m
SET "data_json" =
    (m."data_json" - 'customBasemapId')
    || jsonb_build_object('basemap', r.resolved_basemap_id::text)
FROM resolved r
WHERE m."id" = r.map_id
  AND r.resolved_basemap_id IS NOT NULL;

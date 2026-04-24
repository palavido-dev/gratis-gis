-- Backfill: copy every row in the legacy `basemap` table into `item`
-- with type = 'basemap' and a `data_json` shape that matches the new
-- BasemapData contract in @gratis-gis/shared-types.
--
-- Mapping from legacy.source_kind -> data_json.kind:
--   'vector-style' -> 'style-url'   (styleUrl carries the URL)
--   'xyz'          -> 'tile-url'    (tileUrl carries the template)
--   'wms'          -> 'wms'         (wmsUrl + wmsConfig carry params)
--
-- The design doc for #72 originally listed only style-url / tile-url /
-- composed-map. We extended the kind union with 'wms' so the backfill
-- can round-trip existing WMS rows without losing layers/format/etc.
-- See DECISIONS.md entry on 2026-04-24 for context.
--
-- Access level: 'org'. Historically basemaps were visible org-wide
-- through /admin/basemaps, so 'org' preserves the effective visibility
-- without leaking anything to the wider world. Owners are taken from
-- basemap.created_by.
--
-- Idempotency: we guard with NOT EXISTS on a data_json->>legacyId
-- match so reruns do not duplicate rows. The marker also lets Phase 1b
-- (#74) find and clean up these backfills if needed.

INSERT INTO "item" (
  "id",
  "org_id",
  "owner_id",
  "type",
  "title",
  "description",
  "tags",
  "thumbnail_url",
  "data_json",
  "access",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  b."org_id",
  b."created_by",
  'basemap'::"ItemType",
  b."label",
  b."description",
  ARRAY[]::text[],
  b."thumbnail_url",
  jsonb_build_object(
    'version', 1,
    'kind',
      CASE b."source_kind"::text
        WHEN 'vector-style' THEN 'style-url'
        WHEN 'xyz'          THEN 'tile-url'
        WHEN 'wms'          THEN 'wms'
      END
  )
  || CASE b."source_kind"::text
       WHEN 'vector-style' THEN jsonb_build_object('styleUrl', b."url")
       WHEN 'xyz'          THEN jsonb_build_object('tileUrl',  b."url")
       WHEN 'wms'          THEN jsonb_build_object(
                                  'wmsUrl',    b."url",
                                  'wmsConfig', COALESCE(b."config", '{}'::jsonb)
                                )
     END
  || CASE
       WHEN b."attribution" IS NOT NULL AND b."attribution" <> ''
         THEN jsonb_build_object('attribution', b."attribution")
       ELSE '{}'::jsonb
     END
  || CASE
       WHEN b."thumbnail_url" IS NOT NULL
         THEN jsonb_build_object('thumbnailUrl', b."thumbnail_url")
       ELSE '{}'::jsonb
     END
  || jsonb_build_object('legacyId', b."id"::text),
  'org'::"ItemAccess",
  b."created_at",
  b."updated_at"
FROM "basemap" b
WHERE NOT EXISTS (
  SELECT 1
  FROM "item" i
  WHERE i."type" = 'basemap'::"ItemType"
    AND i."data_json"->>'legacyId' = b."id"::text
);

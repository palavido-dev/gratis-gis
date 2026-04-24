-- Seed the five built-in basemaps as basemap items in every existing
-- org. Previously these lived as a hardcoded record in
-- apps/portal-web/src/lib/basemaps.ts (BASEMAPS, BASEMAP_KEYS, and the
-- BasemapKey string union). Matt: "no one should ever have to go to a
-- .env file and make changes like that to add a default basemap" -- so
-- the built-ins become regular items that participate in sharing,
-- ownership, housekeeping, and the items list like anything else.
--
-- Each seeded item carries a `seededKey` marker in data_json so the
-- follow-on migration can rewrite existing map items from the old
-- `basemap: <key>` string to the matching `basemap: <itemUuid>` shape.
-- The marker also lets the auth-sync service detect "this org has
-- already been seeded" and skip re-seeding on every login.
--
-- Owner: the first admin of the org. If the org has no admin yet, we
-- fall back to the first user. (Matt's dev DB has bob as the admin of
-- Acme Corp, so he picks up the ownership.)
-- Access: 'org'. Built-ins are visible to everyone in the org but
-- not published publicly.
-- Tags: ['built-in'] so they're easy to find in the items list filter.
--
-- Idempotency: WHERE NOT EXISTS on (org_id, data_json->>'seededKey').

INSERT INTO "item" (
  "id", "org_id", "owner_id", "type", "title", "description", "tags",
  "data_json", "access", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  o."id",
  -- Owner: first admin in the org, else first user.
  COALESCE(
    (SELECT u."id"
       FROM "user" u
       WHERE u."org_id" = o."id" AND u."org_role" = 'admin'
       ORDER BY u."created_at" ASC
       LIMIT 1),
    (SELECT u."id"
       FROM "user" u
       WHERE u."org_id" = o."id"
       ORDER BY u."created_at" ASC
       LIMIT 1)
  ),
  'basemap'::"ItemType",
  b."title",
  b."description",
  ARRAY['built-in']::text[],
  jsonb_build_object(
    'version',      1,
    'kind',         'tile-url',
    'tileUrl',      b."tile_url",
    'attribution',  b."attribution",
    'seededKey',    b."seeded_key"
  ),
  'org'::"ItemAccess",
  NOW(),
  NOW()
FROM "organization" o
CROSS JOIN (
  VALUES
    (
      'positron',
      'Positron',
      'Light and muted. Good base for overlay data.',
      'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
      '(c) OpenStreetMap contributors (c) Carto'
    ),
    (
      'osm',
      'OpenStreetMap',
      'Classic OSM raster. Broad coverage, familiar styling.',
      'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      '(c) OpenStreetMap contributors'
    ),
    (
      'voyager',
      'Voyager',
      'Balanced contrast with clear place labels.',
      'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      '(c) OpenStreetMap contributors (c) Carto'
    ),
    (
      'dark-matter',
      'Dark matter',
      'Dark theme for dashboards and presentations.',
      'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
      '(c) OpenStreetMap contributors (c) Carto'
    ),
    (
      'satellite',
      'Satellite',
      'ESA / ArcGIS Online World Imagery.',
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'Imagery (c) ESA WorldCover'
    )
) AS b(seeded_key, title, description, tile_url, attribution)
WHERE NOT EXISTS (
  SELECT 1 FROM "item" i
  WHERE i."org_id" = o."id"
    AND i."type" = 'basemap'::"ItemType"
    AND i."data_json"->>'seededKey' = b."seeded_key"
)
AND EXISTS (
  -- Skip orgs with no users at all (they can't own anything).
  SELECT 1 FROM "user" u WHERE u."org_id" = o."id"
);

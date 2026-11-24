-- Sites the Embed widget may frame, now kept per organization. The
-- list used to be one install-wide system_setting row (key
-- embed_origins). Copy that list onto the oldest organization, which
-- is the organization a single-organization install serves, so the
-- install keeps its list. Only string entries are copied; the API
-- normalizes the list again on every read. The old row is left in
-- place and is no longer read.
ALTER TABLE "organization" ADD COLUMN "embed_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "organization" o
SET "embed_origins" = ARRAY(
  SELECT e #>> '{}'
  FROM jsonb_array_elements(s."value" -> 'origins') WITH ORDINALITY AS t(e, n)
  WHERE jsonb_typeof(e) = 'string'
  ORDER BY n
)
FROM "system_setting" s
WHERE s."key" = 'embed_origins'
  AND jsonb_typeof(s."value" -> 'origins') = 'array'
  AND o."id" = (
    SELECT "id" FROM "organization" ORDER BY "created_at" ASC, "id" ASC LIMIT 1
  );

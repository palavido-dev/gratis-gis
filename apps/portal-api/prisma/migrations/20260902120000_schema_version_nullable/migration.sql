-- Make schema_version optional on every existing form-paired layer (#81).
--
-- The paired "submissions" data_layer each form gets declared
-- schema_version with nullable: false. Only the forms pipeline can
-- supply that value (it records which form schema a response was
-- captured against, and the submission endpoint rejects a mismatch),
-- while the field runtime writes to the same layer through the feature
-- endpoint and has no version to give. Nothing enforced the declaration
-- until feature writes started being validated in v0.9.97, at which
-- point a field submission into any paired layer created before that
-- release would be refused with "Schema version is required."
--
-- The template in items.service.ts was corrected for NEW forms in the
-- same release. This brings every layer that already exists into line.
-- The public demo was patched by hand the day it shipped; this is the
-- same change for every other deployment.
--
-- Notes for the reader:
--   * item.type stores the kebab-case enum value 'data-layer'. Raw SQL
--     against item.type must always use the kebab form.
--   * Only rows that actually carry a schema_version field marked
--     nullable=false are rewritten; everything else is untouched, so
--     the update is idempotent and touches no unrelated layer.
--   * The layer and field arrays are rebuilt element by element with
--     jsonb_agg over ordinality so order is preserved. jsonb_set cannot
--     address "the element whose name is X", which is why this is not
--     a one-liner.

UPDATE "item" AS i
SET "data_json" = jsonb_set(
  i."data_json",
  '{layers}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(l.value->'fields') = 'array' THEN
          jsonb_set(
            l.value,
            '{fields}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN f.value->>'name' = 'schema_version'
                   AND f.value->'nullable' = 'false'::jsonb
                  THEN jsonb_set(f.value, '{nullable}', 'true'::jsonb)
                  ELSE f.value
                END
                ORDER BY f.ordinality
              )
              FROM jsonb_array_elements(l.value->'fields') WITH ORDINALITY AS f(value, ordinality)
            )
          )
        ELSE l.value
      END
      ORDER BY l.ordinality
    )
    FROM jsonb_array_elements(i."data_json"->'layers') WITH ORDINALITY AS l(value, ordinality)
  )
)
WHERE i."type" = 'data-layer'
  AND i."data_json"->'version' = '3'::jsonb
  AND jsonb_typeof(i."data_json"->'layers') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(i."data_json"->'layers') AS l(value),
         jsonb_array_elements(l.value->'fields') AS f(value)
    WHERE jsonb_typeof(l.value->'fields') = 'array'
      AND f.value->>'name' = 'schema_version'
      AND f.value->'nullable' = 'false'::jsonb
  );

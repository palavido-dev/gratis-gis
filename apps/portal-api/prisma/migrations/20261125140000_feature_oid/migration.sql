-- ObjectIDs for the Esri FeatureServer interface (ArcGIS Pro editing).
--
-- Pro needs a positive integer ObjectID on every feature. Features here
-- are UUIDs, which do not fit, so each (scope, entity) gets a number from
-- one sequence the first time it is written. The number never changes
-- and is never reused, even after a delete, so a Pro edit session that
-- holds an ObjectID always names the same feature. The UUID stays the
-- real id everywhere else and reaches Pro as the GlobalID.
--
-- One sequence for the whole install, not one per layer: a per-layer
-- counter needs a lock held until commit, and an import holding it would
-- block every other create in that layer for minutes.
CREATE TABLE "feature_oid" (
    "scope" TEXT NOT NULL,
    "entity" UUID NOT NULL,
    "oid" BIGSERIAL NOT NULL,

    CONSTRAINT "feature_oid_pkey" PRIMARY KEY ("scope", "entity")
);

CREATE UNIQUE INDEX "feature_oid_oid_key" ON "feature_oid"("oid");

-- Layers whose features from before this migration have their
-- ObjectIDs. New writes are numbered by the trigger below, so once a
-- scope is listed here it stays complete.
CREATE TABLE "feature_oid_scope" (
    "scope" TEXT NOT NULL,
    "backfilled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_oid_scope_pkey" PRIMARY KEY ("scope")
);

-- Every write is an INSERT into observation, so a row trigger sees all
-- of them: portal edits, the field app, imports (COPY fires it too) and
-- anything run by hand. Only data layer scopes are numbered. The lookup
-- before the insert keeps an update from spending a sequence value on a
-- conflict. A row-level trigger on the partitioned parent is cloned onto
-- every partition, present and future.
CREATE OR REPLACE FUNCTION observation_assign_oid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM feature_oid WHERE scope = NEW.scope AND entity = NEW.entity
  ) THEN
    INSERT INTO feature_oid (scope, entity)
    VALUES (NEW.scope, NEW.entity)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS observation_assign_oid ON observation;
CREATE TRIGGER observation_assign_oid
  AFTER INSERT ON observation
  FOR EACH ROW
  WHEN (NEW.kind <> 'delete' AND NEW.scope LIKE 'data_layer:%')
  EXECUTE FUNCTION observation_assign_oid();

-- backup_config is a singleton, but nothing enforced it. Two replicas
-- booting against an empty table could each insert a row, after which
-- saves updated one row while reads returned the other.
--
-- Keep the most recently updated row and drop the rest, then pin the
-- table to one row with a unique, always-true column. The table holds
-- at most a handful of rows, so the DELETE and the index are instant.
DELETE FROM "backup_config"
 WHERE "id" NOT IN (
   SELECT "id" FROM "backup_config"
    ORDER BY "updated_at" DESC, "id" DESC
    LIMIT 1
 );

ALTER TABLE "backup_config"
  ADD COLUMN "singleton" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "backup_config"
  ADD CONSTRAINT "backup_config_singleton_true" CHECK ("singleton");
CREATE UNIQUE INDEX "backup_config_singleton_key" ON "backup_config"("singleton");

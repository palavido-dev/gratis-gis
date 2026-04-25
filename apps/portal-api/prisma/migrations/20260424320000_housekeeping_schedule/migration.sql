-- Task #67: scheduled housekeeping. Adds a singleton config row
-- driving an automatic auto-trash / auto-disable cron, plus a
-- HousekeepingRun audit table mirroring BackupRun's shape so the
-- admin UI can show what each pass did.
--
-- Both auto-actions default to disabled. Admins opt in explicitly
-- so a fresh portal never silently destroys content; the manual
-- bulk-action surface from #58 keeps working unchanged.

CREATE TABLE "housekeeping_config" (
  "id"                     UUID    NOT NULL DEFAULT gen_random_uuid(),
  "auto_trash_enabled"     BOOLEAN NOT NULL DEFAULT false,
  "auto_trash_days"        INTEGER,
  "auto_disable_enabled"   BOOLEAN NOT NULL DEFAULT false,
  "auto_disable_days"      INTEGER,
  "schedule_mode"          TEXT    NOT NULL DEFAULT 'off',
  "schedule_hour"          INTEGER NOT NULL DEFAULT 3,
  "schedule_minute"        INTEGER NOT NULL DEFAULT 0,
  "schedule_day_of_week"   INTEGER,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "housekeeping_config_pkey" PRIMARY KEY ("id")
);

CREATE TYPE "HousekeepingStatus" AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE "housekeeping_run" (
  "id"             UUID                NOT NULL DEFAULT gen_random_uuid(),
  "started_at"     TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"    TIMESTAMP(3),
  "status"         "HousekeepingStatus" NOT NULL DEFAULT 'running',
  "trigger"        TEXT                NOT NULL DEFAULT 'manual',
  "started_by"     UUID,
  "items_trashed"  INTEGER             NOT NULL DEFAULT 0,
  "users_disabled" INTEGER             NOT NULL DEFAULT 0,
  "error"          TEXT,

  CONSTRAINT "housekeeping_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "housekeeping_run_started_at_idx"
  ON "housekeeping_run"("started_at");

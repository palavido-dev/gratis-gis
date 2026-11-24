-- Off-site backups. The settings live on the backup_config singleton,
-- each column nullable so an unset one falls back to its environment
-- variable. Secrets are stored encrypted by the API, never in clear.
ALTER TABLE "backup_config"
  ADD COLUMN "offsite_enabled" BOOLEAN,
  ADD COLUMN "offsite_endpoint" TEXT,
  ADD COLUMN "offsite_region" TEXT,
  ADD COLUMN "offsite_bucket" TEXT,
  ADD COLUMN "offsite_prefix" TEXT,
  ADD COLUMN "offsite_path_style" BOOLEAN,
  ADD COLUMN "offsite_access_key_id" TEXT,
  ADD COLUMN "offsite_secret_encrypted" TEXT,
  ADD COLUMN "offsite_secret_iv" TEXT,
  ADD COLUMN "offsite_passphrase_encrypted" TEXT,
  ADD COLUMN "offsite_passphrase_iv" TEXT,
  ADD COLUMN "offsite_retention_days" INTEGER,
  ADD COLUMN "offsite_alert_days" INTEGER,
  ADD COLUMN "offsite_mirror_threshold_bytes" BIGINT;

-- What happened to the off-site copy of each run.
ALTER TABLE "backup_run"
  ADD COLUMN "offsite_status" TEXT,
  ADD COLUMN "offsite_mode" TEXT,
  ADD COLUMN "offsite_key" TEXT,
  ADD COLUMN "offsite_bytes" BIGINT,
  ADD COLUMN "offsite_sha256" TEXT,
  ADD COLUMN "offsite_error" TEXT,
  ADD COLUMN "offsite_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_finished_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_heartbeat_at" TIMESTAMPTZ(6);

-- One notice per off-site failure or quiet period.
CREATE TABLE "backup_offsite_notice" (
    "key" TEXT NOT NULL,
    "noticed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_offsite_notice_pkey" PRIMARY KEY ("key")
);

-- Results of "Test latest backup" (scratch restore of a dump).
CREATE TABLE "backup_restore_test" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "filename" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_by" UUID,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "backup_restore_test_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_restore_test_started_at_idx" ON "backup_restore_test"("started_at" DESC);

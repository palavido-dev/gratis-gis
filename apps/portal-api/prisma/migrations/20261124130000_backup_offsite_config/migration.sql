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

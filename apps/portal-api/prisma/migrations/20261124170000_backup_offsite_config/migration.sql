-- Off-site backups. The settings live on the backup_config singleton,
-- each column nullable so an unset one falls back to its environment
-- variable. The bucket secret is stored encrypted by the API, never in
-- clear. Off-site files are encrypted
-- to the admin's public key; the matching private key is never on the
-- server. Each copy is also signed with a key the server makes for
-- itself (Ed25519), stored with the same cipher; its public half, the
-- verify key, goes into the admin's key file.
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
  ADD COLUMN "offsite_public_key" TEXT,
  ADD COLUMN "offsite_install_id" TEXT,
  ADD COLUMN "offsite_retention_days" INTEGER,
  ADD COLUMN "offsite_alert_days" INTEGER,
  ADD COLUMN "offsite_key_changed_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_key_changed_by" UUID,
  ADD COLUMN "offsite_previous_fingerprint" TEXT,
  ADD COLUMN "offsite_signing_key_encrypted" TEXT,
  ADD COLUMN "offsite_signing_key_iv" TEXT,
  ADD COLUMN "offsite_verify_key" TEXT,
  ADD COLUMN "offsite_previous_verify_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "offsite_signing_key_changed_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_signing_key_changed_by" UUID;

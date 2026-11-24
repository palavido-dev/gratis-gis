-- Off-site backups, part two: the outcome of each run's off-site copy,
-- the local index of mirrored files, off-site notices, and "Test
-- latest backup" results.
-- What happened to the off-site copy of each run.
ALTER TABLE "backup_run"
  ADD COLUMN "offsite_status" TEXT,
  ADD COLUMN "offsite_mode" TEXT,
  ADD COLUMN "offsite_key" TEXT,
  ADD COLUMN "offsite_bytes" BIGINT,
  ADD COLUMN "offsite_sha256" TEXT,
  ADD COLUMN "offsite_key_fingerprint" TEXT,
  ADD COLUMN "offsite_verify_fingerprint" TEXT,
  ADD COLUMN "offsite_error" TEXT,
  ADD COLUMN "offsite_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_finished_at" TIMESTAMPTZ(6),
  ADD COLUMN "offsite_heartbeat_at" TIMESTAMPTZ(6);

-- At most one off-site upload at a time for the whole install, so two
-- uploads (or an upload and the mirror clean-up) never overlap. Not
-- expressible in schema.prisma; the drift check ignores partial
-- indexes, as with backup_run_one_running_idx.
CREATE UNIQUE INDEX "backup_run_one_offsite_running_idx"
  ON "backup_run" ("offsite_status")
  WHERE "offsite_status" = 'running';

-- Mirror mode: what this server has uploaded, so it never needs to
-- read back (or be able to decrypt) what is in the bucket. A missing
-- row only means "upload it again" under a new name. "name" is the
-- file's name in the bucket, new for every upload; "source" says which
-- stored file and version it holds.
CREATE TABLE "backup_offsite_object" (
    "target" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "key_fingerprint" TEXT NOT NULL,
    "plain_bytes" BIGINT NOT NULL,
    "sealed_bytes" BIGINT NOT NULL,
    "sealed_sha256" TEXT,
    "content_type" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_run_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "backup_offsite_object_pkey" PRIMARY KEY ("target","name")
);

CREATE INDEX "backup_offsite_object_target_last_run_at_idx" ON "backup_offsite_object"("target", "last_run_at");

CREATE INDEX "backup_offsite_object_target_source_idx" ON "backup_offsite_object"("target", "source");

-- Mirror runs this server started. A file the local index does not
-- know is removed only when every run folder in the bucket is listed.
CREATE TABLE "backup_offsite_mirror_run" (
    "target" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_offsite_mirror_run_pkey" PRIMARY KEY ("target","run_id")
);

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

-- One backup test at a time: two would share the database volume and
-- each one clears scratch databases left by earlier tests. Not
-- expressible in schema.prisma, like the index above on backup_run.
CREATE UNIQUE INDEX "backup_restore_test_one_running_idx"
  ON "backup_restore_test" ("status")
  WHERE "status" = 'running';

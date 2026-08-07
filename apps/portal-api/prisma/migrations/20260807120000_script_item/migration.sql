-- #221: `script` item type and its run history.
--
-- Hand-written for the same reason as the feedback migration: this dev
-- database has drifted from the migration history, so `migrate dev`
-- asks to reset it. Verified by applying the full history to an empty
-- database built from the prod postgres image.

-- AlterEnum
-- Adding an enum value cannot run inside the same transaction that
-- uses it on PostgreSQL 11 and earlier. Prisma emits these as their
-- own statement for that reason; nothing below references the new
-- value, so there is no ordering hazard here.
ALTER TYPE "ItemType" ADD VALUE 'script';

-- CreateTable
CREATE TABLE "script_run" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "log" TEXT,
    "exit_code" INTEGER,
    "error" TEXT,
    "source_snapshot" TEXT,
    "api_key_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "heartbeat_at" TIMESTAMPTZ(6),

    CONSTRAINT "script_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "script_run_state_created_at_idx" ON "script_run"("state", "created_at");

-- CreateIndex
CREATE INDEX "script_run_script_id_created_at_idx" ON "script_run"("script_id", "created_at");

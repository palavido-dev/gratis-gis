-- A held byte count. Released when the import finishes or fails.
CREATE TABLE "storage_reservation" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "bytes" BIGINT NOT NULL,
    "purpose" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_reservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "storage_reservation_org_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "storage_reservation_org_idx" ON "storage_reservation" ("org_id");

-- One notice per failed backup run. A second insert is the dedupe.
CREATE TABLE "backup_failure_notice" (
    "run_id" UUID NOT NULL,
    "noticed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_failure_notice_pkey" PRIMARY KEY ("run_id")
);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'backup-failed';

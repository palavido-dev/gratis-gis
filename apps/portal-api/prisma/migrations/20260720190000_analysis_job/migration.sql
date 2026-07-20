-- #184 / workbench foundation: server-side analysis job queue.
-- Workers claim rows with FOR UPDATE SKIP LOCKED; the state+created
-- index serves the poll, the source index serves per-item job lists.
CREATE TABLE "analysis_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "source_item_id" UUID NOT NULL,
    "target_item_id" UUID,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "analysis_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "analysis_job_state_created_at_idx" ON "analysis_job"("state", "created_at");
CREATE INDEX "analysis_job_source_item_id_idx" ON "analysis_job"("source_item_id");

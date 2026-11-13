-- 2026-11 review, finding 06-5: "Build search indexes" ran inside the
-- HTTP request. The API now queues one of these rows and the worker
-- runs the build, recording the outcome for the admin page to poll.

CREATE TABLE "search_index_build" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "requested_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "result" JSONB,
  "error" TEXT,
  CONSTRAINT "search_index_build_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "search_index_build_org_id_created_at_idx"
  ON "search_index_build" ("org_id", "created_at");
CREATE INDEX "search_index_build_status_created_at_idx"
  ON "search_index_build" ("status", "created_at");

-- One build in flight per org. A second click while one is queued or
-- running gets the existing row back instead of a duplicate build.
CREATE UNIQUE INDEX "search_index_build_one_active_per_org"
  ON "search_index_build" ("org_id")
  WHERE "status" IN ('queued', 'running');

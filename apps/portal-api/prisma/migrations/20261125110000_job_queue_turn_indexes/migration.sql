-- Indexes for the job queues' turn order (src/common/fair-queue.ts).
-- With many organizations, a worker that claims the next job looks up
-- when each waiting organization last started a job. These indexes
-- answer that from the index instead of reading the whole table.
--
-- Plain CREATE INDEX (not CONCURRENTLY): these queue tables are small,
-- so the short lock while each index builds goes unnoticed.
CREATE INDEX IF NOT EXISTS "import_job_org_id_started_at_idx"
  ON "import_job" ("org_id", "started_at");
CREATE INDEX IF NOT EXISTS "offline_package_org_id_started_at_idx"
  ON "offline_package" ("org_id", "started_at");
CREATE INDEX IF NOT EXISTS "script_run_org_id_started_at_idx"
  ON "script_run" ("org_id", "started_at");
CREATE INDEX IF NOT EXISTS "search_index_build_org_id_started_at_idx"
  ON "search_index_build" ("org_id", "started_at");

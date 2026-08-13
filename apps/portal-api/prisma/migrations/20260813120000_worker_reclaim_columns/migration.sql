-- #232 worker crash-recovery for two job pipelines that had none.
--
-- AgoImportJob and Notification each lacked a liveness timestamp, so a
-- portal-api replica dying mid-run left an AGO migration stuck at
-- status='running' (the wizard polls a spinner forever) or a
-- notification stranded at status='sending' (drainBatch selects only
-- 'queued', and the admin retry only touches 'failed', so nothing
-- could ever reach it). The reclaim sweeps that fix this need a
-- timestamp to threshold a stale row against.
--
-- Both columns are plain TIMESTAMP(3), matching started_at /
-- scheduled_at on their own tables: the reclaim compares them against
-- a Prisma Date cutoff (as ImportJob.recoverStaleRunning does), not
-- raw now() in SQL, so they need no zone anchoring the way the
-- analysis-bridge beat did.

-- AGO import runner liveness beat (stamped on running-flip, every
-- per-item progress write, and a 30s timer during a long single item).
ALTER TABLE "ago_import_job" ADD COLUMN "last_heartbeat_at" TIMESTAMP(3);

-- When a notification was claimed queued -> sending. The stale-sending
-- reclaim thresholds off this.
ALTER TABLE "notification" ADD COLUMN "sending_at" TIMESTAMP(3);

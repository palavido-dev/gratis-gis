-- #235: at most one BackupRun may be status='running'. The
-- check-then-create in runBackup is racy across two portal-api
-- replicas; this partial unique index makes the second INSERT fail
-- so two backups cannot stage at once and double peak disk.
-- Dead 'running' rows must be reclaimed before a new run starts
-- (runBackup already calls reclaimStaleRuns first).
CREATE UNIQUE INDEX "backup_run_one_running_idx"
  ON "backup_run" (status)
  WHERE status = 'running';

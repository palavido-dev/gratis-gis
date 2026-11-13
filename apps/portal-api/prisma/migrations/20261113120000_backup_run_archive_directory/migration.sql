-- Hand-written. 2026-11 review, finding 05-6: run rows stored only the
-- archive file name and looked it up in whatever folder the backup
-- settings named now, so changing the folder hid every older archive
-- (no download, no restore) and retention could not delete them.
-- Each run now records the folder it wrote to. Null on older rows,
-- which keep using the current folder.

ALTER TABLE "backup_run" ADD COLUMN IF NOT EXISTS "archive_directory" TEXT;

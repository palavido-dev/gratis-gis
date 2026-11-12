-- Hand-written. 2026-11 review, finding 02-3: script_run had no
-- foreign key to item, so purging a script left its runs behind
-- (logs, source snapshots, executed notebooks) with no way to remove
-- them. Same shape as 20260825010000_offline_package_fk.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'script_run_script_id_fkey'
  ) THEN
    -- Runs of scripts that are already gone would make ADD CONSTRAINT
    -- fail. Deleting them is what the constraint does from here on.
    DELETE FROM "script_run" r
    WHERE NOT EXISTS (SELECT 1 FROM "item" i WHERE i."id" = r."script_id");

    ALTER TABLE "script_run"
      ADD CONSTRAINT "script_run_script_id_fkey"
      FOREIGN KEY ("script_id") REFERENCES "item"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

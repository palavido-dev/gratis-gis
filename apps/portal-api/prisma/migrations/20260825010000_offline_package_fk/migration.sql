-- Hand-written. 2026-08-24 review, finding M1: nothing deleted
-- offline_package rows when their item died, and the orphan sweep
-- treats any row with a storage_key as a live reference, so every
-- archive for a deleted deployment was pinned in MinIO forever.
--
-- The cascade covers item deletion. Area deletion (a JSON edit on a
-- surviving item) is handled in code, on the item-save path.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'offline_package_item_id_fkey'
  ) THEN
    -- Defensive: an orphan row would make ADD CONSTRAINT fail, and a
    -- pre-FK install may already have some. Deleting them is exactly
    -- the semantics the constraint enforces from here on.
    DELETE FROM "offline_package" op
    WHERE NOT EXISTS (SELECT 1 FROM "item" i WHERE i."id" = op."item_id");

    ALTER TABLE "offline_package"
      ADD CONSTRAINT "offline_package_item_id_fkey"
      FOREIGN KEY ("item_id") REFERENCES "item"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

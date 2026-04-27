-- #93: opt-in periodic recompute-extents during the housekeeping pass.
ALTER TABLE "housekeeping_config"
  ADD COLUMN "recompute_extents_enabled" BOOLEAN NOT NULL DEFAULT false;

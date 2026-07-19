-- #147 Phase 3: per-org getting-started checklist state.
-- Stores only non-derivable state (manual completions + per-item
-- dismissals); everything else is computed from live data at read
-- time, so there is nothing to backfill.
ALTER TABLE "organization" ADD COLUMN "onboarding" JSONB NOT NULL DEFAULT '{}';

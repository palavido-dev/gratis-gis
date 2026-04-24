-- Per-user capability override table. See task #68 and
-- docs/handoff/per-user-capability-overrides.md.
--
-- Capabilities live as plain strings (validated in service layer
-- against a code-side catalog) so adding a new capability is a code
-- change, not a schema migration. Role baselines also live in code.
-- The DB only stores deviations from the baseline.
--
-- One row per (user, capability). enabled=true grants; enabled=false
-- revokes. Cascade on user delete so we don't leak orphan overrides.

CREATE TABLE "user_capability_override" (
  "id"          UUID    NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID    NOT NULL,
  "capability"  TEXT    NOT NULL,
  "enabled"     BOOLEAN NOT NULL,
  "granted_by"  UUID    NOT NULL,
  "granted_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"        TEXT,

  CONSTRAINT "user_capability_override_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_capability_override_user_capability_key"
  ON "user_capability_override"("user_id", "capability");

CREATE INDEX "user_capability_override_user_id_idx"
  ON "user_capability_override"("user_id");

ALTER TABLE "user_capability_override"
  ADD CONSTRAINT "user_capability_override_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

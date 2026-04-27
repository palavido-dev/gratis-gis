-- Time-bounded user accounts (#85). When `auto_disable_at` is
-- non-null and in the past, the user gets disabled in Keycloak
-- (enabled: false) so the SSO flow rejects the next sign-in.
-- The local row stays put for ownership integrity. Null means
-- "no auto-disable" and is the default so existing users keep
-- working unchanged.
--
-- Enforcement is two-layered just like share expiry (#84):
--   1) auth-sync.service.ts checks at every request and flips
--      Keycloak the moment it sees an overdue auto_disable_at,
--      so even a delayed cron sweep can't leak access.
--   2) the housekeeping cron (#86) sweeps hourly to disable in
--      bulk and clean up the audit log.

ALTER TABLE "user"
  ADD COLUMN "auto_disable_at" TIMESTAMPTZ;

-- Partial index for the cron sweep ("disable users where
-- auto_disable_at <= now()") and the housekeeping "soon to
-- expire" panel ("users with auto_disable_at in the next 7
-- days"). Most rows never have one set, so the partial index
-- stays small.
CREATE INDEX "user_auto_disable_at_idx"
  ON "user" ("auto_disable_at")
  WHERE "auto_disable_at" IS NOT NULL;

-- Local mirror of "an admin or housekeeping disabled this account".
-- Keycloak's enabled flag stops sign-in, but API keys and scheduled
-- scripts never ask Keycloak, so they check this column instead.
-- Nullable with no default: adding it does not rewrite the table.
-- The ALTER still needs a brief exclusive lock on "user"; give up
-- after 5 s rather than queue every request behind a long transaction
-- (rerun the deploy if it times out). RESET so later migrations in
-- the same run keep the default.
SET lock_timeout = '5s';
ALTER TABLE "user" ADD COLUMN "disabled_at" TIMESTAMP(3);
RESET lock_timeout;

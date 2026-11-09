-- Local mirror of "an admin or housekeeping disabled this account".
-- Keycloak's enabled flag stops sign-in, but API keys and scheduled
-- scripts never ask Keycloak, so they check this column instead.
-- Nullable with no default: adding it does not rewrite the table.
ALTER TABLE "user" ADD COLUMN "disabled_at" TIMESTAMP(3);

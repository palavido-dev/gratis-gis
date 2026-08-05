-- Personal API keys for machine-to-machine access (#219).
--
-- Four documents (README, ARCHITECTURE, ROADMAP, OSGEO-SUBMISSION)
-- have claimed personal access tokens exist since the hosted-notebook
-- item type was dropped in 20260507230100 on the explicit grounds that
-- "users connect their own Jupyter / VS Code / whatever via personal
-- access tokens". This table is that mechanism, finally.
--
-- The token is never stored: token_hash is SHA-256 of a 32-byte random
-- token and is the lookup key, prefix is the leading characters kept
-- for display. Revoked keys are retained rather than deleted so a
-- leaked key stays burned and the audit trail survives.

CREATE TABLE "api_key" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- Unique so verification is one indexed lookup, never a scan.
CREATE UNIQUE INDEX "api_key_token_hash_key" ON "api_key"("token_hash");

CREATE INDEX "api_key_user_id_idx" ON "api_key"("user_id");

ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Opt-in per-organization AI provider.
--
-- No row means AI is off: draft endpoints refuse and the API does
-- not call a model. encrypted_secret is AES-256-GCM ciphertext from
-- credential-cipher.ts (CREDENTIAL_ENCRYPTION_KEY). The org id is
-- the AAD, so copying a row onto another organization fails decrypt.

CREATE TABLE "org_ai_provider" (
    "org_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "base_url" TEXT,
    "encrypted_secret" TEXT NOT NULL,
    "encrypted_secret_iv" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "org_ai_provider_pkey" PRIMARY KEY ("org_id")
);

ALTER TABLE "org_ai_provider"
    ADD CONSTRAINT "org_ai_provider_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

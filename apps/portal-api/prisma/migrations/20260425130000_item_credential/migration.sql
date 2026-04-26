-- Per-item stored credentials for secured external services (#36).
-- arcgis_service / wms_service / wfs_service items can require auth
-- to fetch from the upstream provider. Storing the credential
-- server-side lets the browser hit our proxy instead of carrying a
-- token; the credential never leaves the server.
--
-- Encryption: ciphertext is AES-256-GCM via Node's crypto, with the
-- master key in CREDENTIAL_ENCRYPTION_KEY (base64 32-byte). The IV
-- is stored alongside the ciphertext (12 bytes, base64). The
-- item_id is used as additional authenticated data so a row can't
-- be moved between items without invalidating the GCM tag.
--
-- One credential per item -- multi-credential setups (e.g. dev
-- token vs prod token) can come later via a separate slot column;
-- today nobody wants that complexity.

CREATE TABLE "item_credential" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"            UUID NOT NULL UNIQUE
                         REFERENCES "item"("id") ON DELETE CASCADE,
  -- 'bearer' = Authorization: Bearer <token>
  -- 'basic'  = Authorization: Basic <base64(user:pass)>
  -- 'arcgis_token' = appended as ?token=<token> on each request,
  --                  the convention for ArcGIS REST named-user auth
  "auth_kind"          TEXT NOT NULL,
  "encrypted_payload"  TEXT NOT NULL,
  "iv"                 TEXT NOT NULL,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Last user to set / change the credential. Surfaces in the
  -- item editor's "Credential set by Alice on 2026-04-25" caption.
  "updated_by"         UUID NOT NULL
);

CREATE INDEX "item_credential_item_id_idx"
  ON "item_credential" ("item_id");

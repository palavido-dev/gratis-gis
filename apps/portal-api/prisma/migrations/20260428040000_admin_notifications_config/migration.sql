-- Admin notifications config (#137).
--
-- Two new tables: a singleton-ish key/value bag for SMTP and other
-- platform settings the admin should be able to edit from the UI
-- (no env file editing), and a per-(type, channel) override table
-- for org-wide defaults that beat the code defaults in
-- notification-types.ts.
--
-- system_setting:
--   key             primary key, free string ('smtp', etc.)
--   value           JSON for non-secret fields
--   encrypted_secret + encrypted_secret_iv: AES-256-GCM payload from
--                   credential-cipher.ts. Used today for the SMTP
--                   password; null for keys with no secret.
--   updated_*       last write timestamp + actor (Keycloak sub) so an
--                   admin can see when SMTP was last changed and by
--                   whom.
--
-- notification_type_default:
--   (type, channel) primary key. Presence of a row overrides the
--   code default in notification-types.ts at the org-wide level.
--   When a user's notification_preference also exists, that still
--   wins. Sparse: an admin keeping the code default has no row.

CREATE TABLE "system_setting" (
    "key"                 TEXT     NOT NULL PRIMARY KEY,
    "value"               JSONB    NOT NULL DEFAULT '{}'::jsonb,
    "encrypted_secret"    TEXT,
    "encrypted_secret_iv" TEXT,
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_by"          UUID
);

CREATE TABLE "notification_type_default" (
    "type"       TEXT NOT NULL,
    "channel"    TEXT NOT NULL,
    "enabled"    BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("type", "channel")
);

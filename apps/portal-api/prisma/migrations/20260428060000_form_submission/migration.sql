-- Form Submission storage (#131).
--
-- Each row is one captured response against a form item. Keys:
--   form_id        FK to the form item (the schema source of truth).
--   client_id      idempotency key minted by the client at capture
--                  time (so a re-drained offline queue is a no-op).
--   schema_version the form schema version the response was captured
--                  against; durable so a forward-rolled schema can
--                  still resolve the row.
--   response       the pruned Response JSON (only visible/answered
--                  questions).
--   submitted_by   user.id of the respondent. Nullable to keep
--                  room for anonymous public-link submissions in
--                  Phase 2 (org_id alone is enough to scope them).
--   org_id         org tenancy key.
--   captured_at    when the client originally captured the response
--                  (may pre-date created_at by hours/days for
--                  offline submissions).

CREATE TABLE "form_submission" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    "form_id"        UUID         NOT NULL REFERENCES "item"("id") ON DELETE CASCADE,
    "org_id"         UUID         NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
    "client_id"      TEXT         NOT NULL,
    "schema_version" INTEGER      NOT NULL,
    "response"       JSONB        NOT NULL,
    "submitted_by"   UUID         REFERENCES "user"("id") ON DELETE SET NULL,
    "captured_at"    TIMESTAMPTZ  NOT NULL,
    "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT "form_submission_form_client_unique"
        UNIQUE ("form_id", "client_id")
);

CREATE INDEX "form_submission_form_idx" ON "form_submission" ("form_id");
CREATE INDEX "form_submission_submitted_by_idx" ON "form_submission" ("submitted_by");

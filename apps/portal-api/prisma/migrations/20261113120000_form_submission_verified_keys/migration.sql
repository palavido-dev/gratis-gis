-- Hand-written. 2026-11 review, finding 10-2: the form mirror repair
-- pass registered every attachment key a stored submission named,
-- without a grant check, and those keys were never checked when the
-- submission was stored. Submit now records the keys the submitter
-- was issued (checked against storage_upload_grant at that moment),
-- and repair re-registers only those. Rows from before this column
-- have none, so repair registers their keys only with a live grant.

ALTER TABLE "form_submission"
  ADD COLUMN IF NOT EXISTS "verified_attachment_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

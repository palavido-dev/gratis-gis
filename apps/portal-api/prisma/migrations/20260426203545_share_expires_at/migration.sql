-- Time-bounded item shares (#84). When `expires_at` is non-null
-- and in the past, the share no longer grants access -- enforced
-- at request time in sharing.service.ts and cleaned up by the
-- housekeeping cron sweep (#86). Null means "never expires" and
-- is the default so existing shares keep working unchanged.

ALTER TABLE "item_share"
  ADD COLUMN "expires_at" TIMESTAMPTZ;

-- Index supports the cron sweep ("delete shares where
-- expires_at <= now()") and the housekeeping "soon to expire"
-- panel ("shares with expires_at in the next 7 days"). Partial
-- on non-null so it stays small -- the bulk of shares never
-- expire.
CREATE INDEX "item_share_expires_at_idx"
  ON "item_share" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

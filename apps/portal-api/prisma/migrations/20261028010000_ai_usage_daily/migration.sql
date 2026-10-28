-- Daily AI call counters for org and per-user spend caps.
--
-- user_id = all-zero UUID is the org-wide bucket. Other rows are
-- per-user. Counters are incremented atomically with
-- INSERT ... ON CONFLICT DO UPDATE before each provider call.

CREATE TABLE "ai_usage_daily" (
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_usage_daily_pkey" PRIMARY KEY ("org_id","user_id","day")
);

CREATE INDEX "ai_usage_daily_org_day_idx"
  ON "ai_usage_daily"("org_id", "day");

ALTER TABLE "ai_usage_daily"
    ADD CONSTRAINT "ai_usage_daily_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

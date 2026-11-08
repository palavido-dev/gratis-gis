-- AlterTable
-- Worker lease for analysis_job. Nullable so rows already running
-- keep finishing: finish_job treats a NULL column as "no lease yet".
ALTER TABLE "analysis_job" ADD COLUMN "claim_token" UUID;

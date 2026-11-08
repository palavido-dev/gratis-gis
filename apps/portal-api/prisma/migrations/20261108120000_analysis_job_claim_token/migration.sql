-- AlterTable
-- Worker lease for analysis_job. Nullable so a worker image from
-- before this column still runs: its UPDATEs do not mention the
-- column. Once a row has a token, the trigger below ignores an
-- UPDATE that does not present that token (or the reclaim flag).
-- A claim from queued to running is allowed so a new worker can
-- take a row an older attempt left queued.
ALTER TABLE "analysis_job" ADD COLUMN "claim_token" UUID;

CREATE OR REPLACE FUNCTION analysis_job_lease_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  presented text;
  reclaim text;
BEGIN
  IF OLD.claim_token IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'queued' AND NEW.state = 'running' THEN
    RETURN NEW;
  END IF;
  reclaim := current_setting('gratis.reclaim', true);
  IF reclaim = '1' THEN
    RETURN NEW;
  END IF;
  presented := current_setting('gratis.claim_token', true);
  IF presented IS NOT DISTINCT FROM OLD.claim_token::text THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS analysis_job_lease_guard ON analysis_job;
CREATE TRIGGER analysis_job_lease_guard
BEFORE UPDATE ON analysis_job
FOR EACH ROW
EXECUTE FUNCTION analysis_job_lease_guard();

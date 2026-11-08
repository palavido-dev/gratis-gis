-- AlterTable
-- Worker lease for analysis_job. Nullable so a worker image from
-- before this column still runs: its UPDATEs do not mention the
-- column.
--
-- The fence covers only the states a claimed worker owns: 'running'
-- and 'cancel_requested'. While a row with a token is in one of
-- those states, the trigger below ignores an UPDATE that does not
-- present that token, with three exceptions:
--   * 'running' to 'cancel_requested' (the user cancel from the API),
--   * the stale-job reclaim sweep (gratis.reclaim = '1'),
--   * a claim from 'queued' to 'running'.
-- The worker clears the token when it hands a vector result to the
-- API bridge ('ingest'), and the bridge never presents one, so
-- 'ingest', 'importing', and the terminal states are not fenced.
ALTER TABLE "analysis_job" ADD COLUMN "claim_token" UUID;

CREATE OR REPLACE FUNCTION analysis_job_lease_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  presented text;
  reclaim text;
BEGIN
  IF OLD.state = 'queued' AND NEW.state = 'running' THEN
    -- A claimer that does not set a token (an older worker image)
    -- must not inherit one left by an earlier attempt, or every
    -- later write of its own would be fenced off.
    IF NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token THEN
      NEW.claim_token := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.claim_token IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state NOT IN ('running', 'cancel_requested') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'running' AND NEW.state = 'cancel_requested' THEN
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

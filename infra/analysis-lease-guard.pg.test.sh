#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The lease trigger ignores an update that does not present the token,
# including a writer that does not know about claim_token. A reclaim
# flag and a queued-to-running claim still apply. A matching token
# may heartbeat and finish. A second token cannot.
set -euo pipefail

if [[ -n "${PG_DOCKER:-}" ]]; then
  psql_exec() {
    docker exec -i "$PG_DOCKER" psql -U "${PGUSER:-gratisgis}" -d "${PGDATABASE:-gratisgis}" -v ON_ERROR_STOP=1 "$@"
  }
else
  psql_exec() {
    psql -v ON_ERROR_STOP=1 "$@"
  }
fi

psql_exec <<'SQL'
DROP TABLE IF EXISTS analysis_job CASCADE;
CREATE TABLE analysis_job (
  id uuid PRIMARY KEY,
  state text NOT NULL,
  progress int NOT NULL DEFAULT 0,
  error text,
  claim_token uuid,
  heartbeat_at timestamptz,
  finished_at timestamptz
);

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

INSERT INTO analysis_job (id, state, claim_token)
VALUES ('11111111-1111-1111-1111-111111111111', 'running', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- Old worker: no GUC, no token in the statement. The row must stay running.
UPDATE analysis_job
SET state = 'done', progress = 100
WHERE id = '11111111-1111-1111-1111-111111111111';

-- Wrong token.
BEGIN;
SELECT set_config('gratis.claim_token', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true);
UPDATE analysis_job SET heartbeat_at = now()
WHERE id = '11111111-1111-1111-1111-111111111111'
  AND claim_token = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
COMMIT;

-- Matching token finishes.
BEGIN;
SELECT set_config('gratis.claim_token', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
UPDATE analysis_job SET state = 'done', progress = 100, finished_at = now()
WHERE id = '11111111-1111-1111-1111-111111111111'
  AND claim_token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
  AND state IN ('running', 'cancel_requested');
COMMIT;

-- Reclaim of a new running row.
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('22222222-2222-2222-2222-222222222222', 'running', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
BEGIN;
SELECT set_config('gratis.reclaim', '1', true);
UPDATE analysis_job SET state = 'failed', error = 'worker stopped responding', finished_at = now()
WHERE id = '22222222-2222-2222-2222-222222222222' AND state = 'running';
COMMIT;

-- New claim of a queued row that still carries an old token.
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('33333333-3333-3333-3333-333333333333', 'queued', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
UPDATE analysis_job
SET state = 'running', claim_token = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
WHERE id = '33333333-3333-3333-3333-333333333333' AND state = 'queued';

DO $$
DECLARE
  st text;
  tok uuid;
BEGIN
  SELECT state INTO st FROM analysis_job WHERE id = '11111111-1111-1111-1111-111111111111';
  IF st <> 'done' THEN
    RAISE EXCEPTION 'owner finish did not land, state=%', st;
  END IF;
  SELECT state INTO st FROM analysis_job WHERE id = '22222222-2222-2222-2222-222222222222';
  IF st <> 'failed' THEN
    RAISE EXCEPTION 'reclaim did not land, state=%', st;
  END IF;
  SELECT state, claim_token INTO st, tok FROM analysis_job WHERE id = '33333333-3333-3333-3333-333333333333';
  IF st <> 'running' OR tok <> 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid THEN
    RAISE EXCEPTION 'reclaim-to-running claim failed state=% token=%', st, tok;
  END IF;
END $$;
SQL

psql_exec <<'SQL'
DROP TABLE IF EXISTS item;
CREATE TABLE item (
  id uuid PRIMARY KEY,
  data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz
);
INSERT INTO item (id, data_json)
VALUES ('99999999-9999-9999-9999-999999999999', '{"keep":1}');
INSERT INTO analysis_job (id, state, claim_token)
VALUES (
  '44444444-4444-4444-4444-444444444444',
  'running',
  'ffffffff-ffff-ffff-ffff-ffffffffffff'
);

WITH held AS (
  SELECT id FROM analysis_job
  WHERE id = '44444444-4444-4444-4444-444444444444'
    AND claim_token = '00000000-0000-0000-0000-000000000000'::uuid
    AND state IN ('running', 'cancel_requested')
  FOR UPDATE
)
UPDATE item
SET data_json = data_json || '{"processingState":"stale"}'::jsonb
WHERE id = '99999999-9999-9999-9999-999999999999'
  AND EXISTS (SELECT 1 FROM held);

WITH held AS (
  SELECT id FROM analysis_job
  WHERE id = '44444444-4444-4444-4444-444444444444'
    AND claim_token = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
    AND state IN ('running', 'cancel_requested')
  FOR UPDATE
)
UPDATE item
SET data_json = data_json || '{"processingState":"ready"}'::jsonb,
    updated_at = now()
WHERE id = '99999999-9999-9999-9999-999999999999'
  AND EXISTS (SELECT 1 FROM held);

DO $$
DECLARE
  doc jsonb;
BEGIN
  SELECT data_json INTO doc FROM item WHERE id = '99999999-9999-9999-9999-999999999999';
  IF doc->>'keep' <> '1' OR doc->>'processingState' <> 'ready' THEN
    RAISE EXCEPTION 'item publish fence failed: %', doc;
  END IF;
END $$;
SQL

echo "analysis lease guard: passed"

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# The lease trigger ignores an update to a running or cancel_requested
# row that does not present the token, including a writer that does
# not know about claim_token. A reclaim flag, a queued-to-running
# claim, and a user cancel (running to cancel_requested) still apply.
# A matching token may heartbeat and finish. A second token cannot.
# After the worker hands a row to 'ingest', the API bridge moves it
# through 'importing' to a terminal state without any token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION="$HERE/../apps/portal-api/prisma/migrations/20261108120000_analysis_job_claim_token/migration.sql"

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
  heartbeat_at timestamptz,
  finished_at timestamptz
);
SQL

# Load the trigger from the migration itself so this test cannot
# drift from what ships. The migration adds claim_token.
psql_exec < "$MIGRATION"

psql_exec <<'SQL'
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

psql_exec <<'SQL'
-- Worker claim, then hand-off to the API bridge. The worker presents
-- its token and clears it in the same statement, as runner.py does.
INSERT INTO analysis_job (id, state)
VALUES ('55555555-5555-5555-5555-555555555555', 'queued');
UPDATE analysis_job
SET state = 'running', claim_token = '12121212-1212-1212-1212-121212121212'
WHERE id = '55555555-5555-5555-5555-555555555555' AND state = 'queued';
BEGIN;
SELECT set_config('gratis.claim_token', '12121212-1212-1212-1212-121212121212', true);
UPDATE analysis_job
SET state = 'ingest', progress = 80, claim_token = NULL
WHERE id = '55555555-5555-5555-5555-555555555555' AND state = 'running'
  AND claim_token = '12121212-1212-1212-1212-121212121212'::uuid;
COMMIT;

-- Bridge, no GUC: ingest to importing, then importing to done. Each
-- step must report one row, or the bridge treats it as lost.
DO $$
DECLARE
  n int;
BEGIN
  UPDATE analysis_job SET state = 'importing', progress = 82
  WHERE id = '55555555-5555-5555-5555-555555555555' AND state = 'ingest';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'bridge ingest to importing updated % rows', n;
  END IF;
  UPDATE analysis_job SET progress = 90
  WHERE id = '55555555-5555-5555-5555-555555555555';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'bridge progress nudge updated % rows', n;
  END IF;
  UPDATE analysis_job SET state = 'done', progress = 100, finished_at = now()
  WHERE id = '55555555-5555-5555-5555-555555555555' AND state = 'importing';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'bridge importing to done updated % rows', n;
  END IF;
END $$;

-- A row that reached 'ingest' still holding a token (a worker image
-- that does not clear it) is not fenced either: the fence is by state.
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('66666666-6666-6666-6666-666666666666', 'ingest', '34343434-3434-3434-3434-343434343434');
UPDATE analysis_job SET state = 'importing'
WHERE id = '66666666-6666-6666-6666-666666666666' AND state = 'ingest';
UPDATE analysis_job SET state = 'failed', error = 'The import step failed.', finished_at = now()
WHERE id = '66666666-6666-6666-6666-666666666666' AND state = 'importing';

-- User cancel of a running, claimed row, from the API (no token).
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('77777777-7777-7777-7777-777777777777', 'running', '56565656-5656-5656-5656-565656565656');
UPDATE analysis_job SET state = 'cancel_requested'
WHERE id = '77777777-7777-7777-7777-777777777777' AND state = 'running';

-- A stale worker without the token cannot finish it, beat it, or
-- flip it back to running.
UPDATE analysis_job SET state = 'done', progress = 100, finished_at = now()
WHERE id = '77777777-7777-7777-7777-777777777777'
  AND state IN ('running', 'cancel_requested');
UPDATE analysis_job SET heartbeat_at = now(), progress = 50
WHERE id = '77777777-7777-7777-7777-777777777777';
UPDATE analysis_job SET state = 'running'
WHERE id = '77777777-7777-7777-7777-777777777777';

-- A stale worker with a different token cannot finish a running row.
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('88888888-8888-8888-8888-888888888888', 'running', '78787878-7878-7878-7878-787878787878');
BEGIN;
SELECT set_config('gratis.claim_token', '90909090-9090-9090-9090-909090909090', true);
UPDATE analysis_job SET state = 'done', progress = 100
WHERE id = '88888888-8888-8888-8888-888888888888';
COMMIT;

-- An older worker image claims a queued row that still carries a
-- token from an earlier attempt, without setting one. The token is
-- dropped, so that worker's own later writes are not fenced.
INSERT INTO analysis_job (id, state, claim_token)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'queued', 'abababab-abab-abab-abab-abababababab');
UPDATE analysis_job SET state = 'running'
WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001' AND state = 'queued';
UPDATE analysis_job SET state = 'done', progress = 100
WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND state IN ('running', 'cancel_requested');

DO $$
DECLARE
  st text;
  tok uuid;
  prog int;
BEGIN
  SELECT state, claim_token INTO st, tok
  FROM analysis_job WHERE id = '55555555-5555-5555-5555-555555555555';
  IF st <> 'done' OR tok IS NOT NULL THEN
    RAISE EXCEPTION 'bridge path failed state=% token=%', st, tok;
  END IF;
  SELECT state INTO st FROM analysis_job WHERE id = '66666666-6666-6666-6666-666666666666';
  IF st <> 'failed' THEN
    RAISE EXCEPTION 'bridge settle on a token row failed, state=%', st;
  END IF;
  SELECT state, progress INTO st, prog
  FROM analysis_job WHERE id = '77777777-7777-7777-7777-777777777777';
  IF st <> 'cancel_requested' OR prog <> 0 THEN
    RAISE EXCEPTION 'cancel did not stick, state=% progress=%', st, prog;
  END IF;
  SELECT state INTO st FROM analysis_job WHERE id = '88888888-8888-8888-8888-888888888888';
  IF st <> 'running' THEN
    RAISE EXCEPTION 'wrong token finished a running row, state=%', st;
  END IF;
  SELECT state, claim_token INTO st, tok
  FROM analysis_job WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
  IF st <> 'done' OR tok IS NOT NULL THEN
    RAISE EXCEPTION 'tokenless claim kept a stale token state=% token=%', st, tok;
  END IF;
END $$;
SQL

echo "analysis lease guard: passed"

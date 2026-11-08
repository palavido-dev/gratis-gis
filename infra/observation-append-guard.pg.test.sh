#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Proves append de-dupe deletes only rows this transaction inserted.
# Committed history, updates, other scopes, and already-stored
# duplicates stay. A create after a committed delete is kept.
#
#   PG_DOCKER=gg-pg-idem ./infra/observation-append-guard.pg.test.sh
#   PGPASSWORD=... PGHOST=127.0.0.1 PGUSER=gratisgis PGDATABASE=gratisgis \
#     ./infra/observation-append-guard.pg.test.sh
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
DROP TABLE IF EXISTS observation CASCADE;
CREATE TABLE observation (
  id uuid NOT NULL,
  tx_time timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  scope text NOT NULL,
  entity uuid NOT NULL,
  kind text NOT NULL,
  attrs jsonb,
  PRIMARY KEY (id, tx_time)
);

INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, attrs) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '2026-01-01', '2026-01-01', 'layer-a', '11111111-1111-1111-1111-111111111111', 'create', '{"n":1}'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '2026-01-02', '2026-01-02', 'layer-a', '11111111-1111-1111-1111-111111111111', 'update', '{"n":2}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '2026-01-03', '2026-01-03', 'layer-a', '22222222-2222-2222-2222-222222222222', 'create', '{"dup":1}'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', '2026-01-04', '2026-01-04', 'layer-a', '22222222-2222-2222-2222-222222222222', 'create', '{"dup":2}'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', '2026-01-05', '2026-01-05', 'layer-b', '11111111-1111-1111-1111-111111111111', 'create', '{"other":1}'),
  ('44444444-4444-4444-4444-444444444401', '2026-02-01', '2026-02-01', 'layer-a', '44444444-4444-4444-4444-444444444444', 'create', '{"was":1}'),
  ('44444444-4444-4444-4444-444444444402', '2026-02-02', '2026-02-02', 'layer-a', '44444444-4444-4444-4444-444444444444', 'delete', NULL);

BEGIN;
INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, attrs) VALUES
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', now(), now(), 'layer-a', '11111111-1111-1111-1111-111111111111', 'create', '{"shadow-live":1}'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd2', now(), now(), 'layer-a', '33333333-3333-3333-3333-333333333333', 'create', '{"fresh":1}'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd3', now() + interval '1 second', now(), 'layer-a', '33333333-3333-3333-3333-333333333333', 'create', '{"fresh-dup":1}'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd4', now(), now(), 'layer-a', '44444444-4444-4444-4444-444444444444', 'create', '{"resurrect":1}');

SELECT pg_advisory_xact_lock(hashtextextended(k, 0))
FROM (
  SELECT DISTINCT scope || '|' || entity::text AS k
  FROM observation
  WHERE scope = 'layer-a' AND kind = 'create' AND xmin = pg_current_xact_id()::xid
  ORDER BY 1
) locks;

DELETE FROM observation AS fresh
WHERE fresh.scope = 'layer-a'
  AND fresh.kind = 'create'
  AND fresh.xmin = pg_current_xact_id()::xid
  AND (
    EXISTS (
      SELECT 1 FROM (
        SELECT prev.kind
        FROM observation AS prev
        WHERE prev.scope = fresh.scope
          AND prev.entity = fresh.entity
          AND prev.xmin IS DISTINCT FROM pg_current_xact_id()::xid
        ORDER BY prev.valid_from DESC, prev.tx_time DESC, prev.id DESC
        LIMIT 1
      ) prior
      WHERE prior.kind <> 'delete'
    )
    OR EXISTS (
      SELECT 1 FROM observation AS sibling
      WHERE sibling.scope = fresh.scope
        AND sibling.entity = fresh.entity
        AND sibling.kind = 'create'
        AND sibling.xmin = pg_current_xact_id()::xid
        AND sibling.id <> fresh.id
        AND (sibling.tx_time, sibling.id) < (fresh.tx_time, fresh.id)
    )
  );

DO $$
DECLARE
  hist int;
  kept_fresh int;
  kept_resurrect int;
  dropped_shadow int;
  dropped_dup int;
  other_scope int;
BEGIN
  SELECT count(*) INTO hist FROM observation WHERE id IN (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    '44444444-4444-4444-4444-444444444401',
    '44444444-4444-4444-4444-444444444402'
  );
  IF hist <> 7 THEN
    RAISE EXCEPTION 'committed history changed: %', hist;
  END IF;
  SELECT count(*) INTO kept_fresh FROM observation WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';
  SELECT count(*) INTO kept_resurrect FROM observation WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd4';
  SELECT count(*) INTO dropped_shadow FROM observation WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
  SELECT count(*) INTO dropped_dup FROM observation WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd3';
  SELECT count(*) INTO other_scope FROM observation WHERE id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
  IF kept_fresh <> 1 OR kept_resurrect <> 1 OR dropped_shadow <> 0 OR dropped_dup <> 0 OR other_scope <> 1 THEN
    RAISE EXCEPTION 'append guard mismatch fresh=% resurrect=% shadow=% dup=% other=%',
      kept_fresh, kept_resurrect, dropped_shadow, dropped_dup, other_scope;
  END IF;
END $$;
ROLLBACK;

-- After rollback the new rows are gone and history is still intact.
DO $$
DECLARE
  hist int;
  fresh int;
BEGIN
  SELECT count(*) INTO hist FROM observation;
  SELECT count(*) INTO fresh FROM observation WHERE id::text LIKE 'dddd%';
  IF hist <> 7 OR fresh <> 0 THEN
    RAISE EXCEPTION 'rollback did not restore the log: rows=% fresh=%', hist, fresh;
  END IF;
END $$;
SQL

# xmin is 32-bit. txid_current() keeps the epoch, so casting xmin
# through text and comparing it to txid_current() misses every row
# once the counter passes 2^32. The predicate above compares xid to
# xid. This statement does not need a wrapped cluster to prove the
# two predicates disagree on a wrapped value.
psql_exec <<'SQL'
DO $$
DECLARE
  wrapped bigint := 4294967296 + 42;
  low xid := '42';
  old_match boolean;
  xid_match boolean;
BEGIN
  old_match := (low::text::bigint = wrapped);
  xid_match := (low = (wrapped % 4294967296)::text::xid8::xid);
  IF old_match THEN
    RAISE EXCEPTION 'epoch compare unexpectedly matched a wrapped xid';
  END IF;
  IF NOT xid_match THEN
    RAISE EXCEPTION 'xid compare missed the low 32 bits of a wrapped xid';
  END IF;
END $$;
SQL

echo "observation append guard: passed"

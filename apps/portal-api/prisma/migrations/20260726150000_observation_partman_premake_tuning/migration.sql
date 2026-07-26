-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Reduce pg_partman premake on public.observation from 24 to 4 and
-- drop the already-created FUTURE month partitions beyond the new
-- premake window, if (and only if) they are empty.
--
-- Why: premake=24 was a deliberate crutch. The Phase 8 cutover
-- (20260508081000_partition_observation_table) pre-created two
-- years of future partitions because nothing scheduled
-- partman.run_maintenance() yet (see ROADMAP Phase 8). The cost
-- surfaced in production: every query that cannot prune on tx_time
-- (which is most of the hot read path, since reads filter on
-- scope/entity, not tx_time) plans and probes ~40 child tables,
-- ~20 of which are empty months in the future that can never hold
-- a row until that month arrives.
--
-- The scheduling gap is closed alongside this migration in infra:
-- both docker-compose files now start postgres with
-- shared_preload_libraries=pg_partman_bgw, the extension's own
-- background worker, which runs run_maintenance on an hourly
-- interval. With maintenance actually running, premake=4 keeps four
-- future months provisioned (months of runway against a wedged
-- maintenance job, plus the default partition as the final
-- backstop) while hot queries drop from ~40 partition probes to
-- ~20 and shrinking (past months remain until a retention policy
-- says otherwise; removing history is out of scope here).
--
-- Guards, because this must be safe on ANY deployment state:
--   * no-op when pg_partman is not installed (to_regclass check)
--   * no-op when public.observation is not partman-managed
--   * only child partitions whose range LOWER bound starts after
--     the new premake horizon are candidates
--   * the DEFAULT partition is never touched
--   * a candidate is dropped only after a row-existence probe
--     proves it empty; a future partition that somehow holds rows
--     (clock skew writes, manual inserts) is kept and reported
--   * DROP TABLE IF EXISTS, and everything runs inside the
--     migration's transaction: an error rolls the whole thing back
--
-- Lock note: dropping a partition takes a brief ACCESS EXCLUSIVE
-- lock on the parent while the child detaches. These partitions are
-- empty and the drops are metadata-only, so the window is
-- milliseconds per child; acceptable inside a deploy-time
-- migration.
--
-- Verification note: exercised two ways before shipping.
--   1. Against a scratch build of the real infra/postgres image
--      (postgis 17 + postgresql-17-partman): create_parent with
--      premake=24 and p_start_partition='2025-01-01' reproduced
--      the prod shape (43 month partitions), this migration then
--      dropped the 20 empty future months and set premake=4, and a
--      subsequent partman.run_maintenance() did NOT recreate the
--      dropped tail (23 partitions remained: history + current +
--      exactly 4 future). Existing rows survived untouched.
--   2. Against a plain postgis 17 container with a mocked
--      partman.part_config, to prove the edge guards: both no-op
--      guards fire, a future partition holding rows is kept and
--      reported, the DEFAULT partition is never considered, and
--      past partitions are left alone.

DO $$
DECLARE
  horizon timestamptz;
  child record;
  has_rows boolean;
  dropped integer := 0;
  kept_nonempty integer := 0;
BEGIN
  -- Guard 1: partman not installed on this database. Possible for
  -- source checkouts that run migrations against a vanilla postgres
  -- while developing unrelated features; the premake concept does
  -- not exist there, so there is nothing to tune.
  IF to_regclass('partman.part_config') IS NULL THEN
    RAISE NOTICE 'observation premake tuning: partman.part_config not found; nothing to do.';
    RETURN;
  END IF;

  -- Guard 2: observation is not under partman management (e.g. the
  -- partition cutover migration was skipped or the table was
  -- rebuilt by hand). Touching child tables would be guesswork.
  IF NOT EXISTS (
    SELECT 1 FROM partman.part_config
    WHERE parent_table = 'public.observation'
  ) THEN
    RAISE NOTICE 'observation premake tuning: public.observation is not partman-managed; nothing to do.';
    RETURN;
  END IF;

  UPDATE partman.part_config
     SET premake = 4
   WHERE parent_table = 'public.observation';

  -- The last month-start that premake=4 still wants to exist:
  -- current month + 4. Anything whose range STARTS after this is
  -- beyond the new window.
  horizon := date_trunc('month', now()) + interval '4 months';

  FOR child IN
    SELECT
      c.oid::regclass AS rel,
      -- relpartbound renders as:
      --   FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00')
      -- Pull the lower bound; the DEFAULT partition renders as
      -- 'DEFAULT' and is filtered out below (regexp yields NULL for
      -- it as a second belt).
      (regexp_match(
        pg_get_expr(c.relpartbound, c.oid),
        'FROM \(''([^'']+)''\)'
      ))[1]::timestamptz AS lower_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.observation'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) NOT LIKE 'DEFAULT%'
  LOOP
    IF child.lower_bound IS NULL OR child.lower_bound <= horizon THEN
      CONTINUE; -- current, past, or inside the new premake window
    END IF;
    -- Emptiness proof: probe for a single row right before the
    -- drop, inside the same transaction. A future partition with
    -- rows (clock-skewed writer, manual backfill) is kept; dropping
    -- data is never worth a tidier catalog.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', child.rel)
      INTO has_rows;
    IF has_rows THEN
      kept_nonempty := kept_nonempty + 1;
      RAISE NOTICE 'observation premake tuning: keeping future partition % because it contains rows.', child.rel;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TABLE IF EXISTS %s', child.rel);
    dropped := dropped + 1;
  END LOOP;

  RAISE NOTICE 'observation premake tuning: premake set to 4; dropped % empty future partition(s); kept % non-empty future partition(s).',
    dropped, kept_nonempty;
END $$;

-- Related finding, recorded here because this migration is the one
-- touching observation partition plumbing: observation_tx_time_idx
-- (btree on tx_time DESC, one child index per partition) was
-- flagged as drop-worthy by review, but it is NOT dropped. It has a
-- live plausible consumer: DataLayerTablesService.lastDataActivityAt
-- runs `SELECT MAX(tx_time) FROM observation WHERE scope = $1` for
-- the housekeeping stale-item heuristic, and the planner's min/max
-- optimization rewrites that into InitPlan Limit over a Merge
-- Append of per-partition Index Scans on the tx_time child indexes
-- with the scope filter applied during the walk (verified with
-- EXPLAIN on postgres 17 against a partitioned replica of this
-- table's shape). Dropping the index would push that query onto a
-- per-scope heap aggregate. Fewer premade partitions also shrink
-- that Merge Append, which is this migration's point. If
-- lastDataActivityAt ever moves off MAX(tx_time), re-evaluate.

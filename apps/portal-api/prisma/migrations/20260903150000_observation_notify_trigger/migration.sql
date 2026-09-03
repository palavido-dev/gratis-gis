-- Tell every tile-serving process the moment a scope changes.
--
-- portal-api keeps an in-process MVT tile cache (TileCacheService) with
-- a 60 s TTL, and prod runs two replicas, each with its own cache.
-- Nothing invalidated those caches on a write, so an edit made through
-- the map builder stayed invisible on the map for up to a minute even
-- though the client asked for fresh tiles: the server ignores the
-- client's `?refresh` serial and served the pre-edit tile from memory.
-- A deleted feature that stays on the map reads as "delete is broken".
--
-- Every write to the observation log is an INSERT, so a row trigger is
-- the one place that sees all of them: the engine's single write, its
-- batched writes, the idempotent create path, and anything a future
-- script does by hand. The payload is the scope
-- (`data_layer:<itemId>:<layerId>`), which is exactly the cache key
-- prefix. NOTIFY fires on commit, so a listener never learns about a
-- row a rolled-back transaction did not keep, and Postgres delivers one
-- event per distinct (channel, payload) per transaction, so a 100k-row
-- import into one layer costs one notification, not 100k.
--
-- `observation` is range-partitioned. A row-level AFTER trigger on the
-- parent is cloned onto every existing partition and onto every
-- partition pg_partman creates later, so no per-partition maintenance.

CREATE OR REPLACE FUNCTION observation_notify_written() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('gg_observation_written', NEW.scope);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS observation_notify_written ON observation;
CREATE TRIGGER observation_notify_written
  AFTER INSERT ON observation
  FOR EACH ROW EXECUTE FUNCTION observation_notify_written();

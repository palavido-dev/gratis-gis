-- Hand-written. 2026-11 review, finding 20-6: the pyramid worker's
-- stale-tiling recovery cast item.data_json text to timestamptz and
-- int across every tile layer. One owner-written bad value made the
-- whole statement fail, so no stale row in any org was ever recovered.
-- These return NULL for a value that does not parse instead.

CREATE OR REPLACE FUNCTION gg_try_timestamptz(value text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION gg_try_int(value text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN value::integer;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

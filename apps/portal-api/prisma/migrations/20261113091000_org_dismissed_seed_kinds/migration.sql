-- 2026-11 review, finding 04-8: a built-in starter (basemap, app
-- template, theme, print template) the admin deleted came back on the
-- next API start once the trash was emptied, because the seeders only
-- saw surviving rows. The organization now records each starter that
-- was purged, as '<item type>/<seed_kind>', and the seeders skip those.
-- The housekeeping "Restore starter" buttons still create them on
-- request.

ALTER TABLE "organization"
  ADD COLUMN "dismissed_seed_kinds" TEXT[] NOT NULL DEFAULT '{}';

-- Recorded by a trigger so every purge path (item purge, trash purge,
-- housekeeping) is covered without each one remembering to do it.
CREATE OR REPLACE FUNCTION gg_record_dismissed_seed_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tag text := OLD.type::text || '/' || OLD.seed_kind;
BEGIN
  UPDATE organization
  SET dismissed_seed_kinds = array_append(dismissed_seed_kinds, tag)
  WHERE id = OLD.org_id
    AND NOT (tag = ANY (dismissed_seed_kinds));
  RETURN OLD;
END;
$$;

CREATE TRIGGER item_record_dismissed_seed_kind
  AFTER DELETE ON item
  FOR EACH ROW
  WHEN (OLD.seed_kind IS NOT NULL)
  EXECUTE FUNCTION gg_record_dismissed_seed_kind();

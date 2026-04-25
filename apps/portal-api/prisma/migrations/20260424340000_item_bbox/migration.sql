-- Item-level bbox (#37 / #24). Cached extent in EPSG:4326 as a
-- Float[4] storing [west, south, east, north]. Indexed via a
-- functional GiST so geographic search can use it without table
-- scans. Recomputed by the application layer on every save (see
-- itemBbox() helper); we don't compute it in SQL because the
-- per-type extraction logic lives in TypeScript and traffics with
-- the data_json blob.

ALTER TABLE "item"
  ADD COLUMN "bbox"     DOUBLE PRECISION[] NOT NULL DEFAULT '{}'::double precision[],
  ADD COLUMN "bbox_srs" TEXT DEFAULT 'EPSG:4326';

-- Functional GiST index on a postgis geometry derived from the
-- bbox. ST_MakeEnvelope returns a geometry whose && check is
-- index-accelerated. We materialise it as a "virtual" geometry
-- via a generated column so future migrations don't have to
-- re-derive it.
ALTER TABLE "item"
  ADD COLUMN "bbox_geom" geometry(Polygon, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN array_length("bbox", 1) = 4
      THEN ST_MakeEnvelope("bbox"[1], "bbox"[2], "bbox"[3], "bbox"[4], 4326)
      ELSE NULL
    END
  ) STORED;

CREATE INDEX "item_bbox_geom_idx"
  ON "item" USING GIST ("bbox_geom");

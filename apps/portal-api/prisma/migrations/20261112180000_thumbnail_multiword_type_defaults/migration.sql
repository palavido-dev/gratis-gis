-- Multi-word item types never got their thumbnail colors.
--
-- 20260513170100_thumbnail_design_backfill matched type::text against
-- Prisma member names ('data_layer', 'web_app', ...), but the stored
-- enum labels are hyphenated ('data-layer', 'web-app', ...). Every
-- multi-word arm missed, those items fell through to the grey ELSE
-- pair (#f8fafc / #475569), and 20260717150000_earth_thumbnail_defaults
-- skipped them too because it keyed on each type's old color.
--
-- This sets the current defaults (defaultThumbnailDesign in
-- packages/shared-types/src/thumbnail.ts) on exactly those rows: a
-- multi-word type whose design still holds the untouched grey pair.
-- A design someone edited in the designer keeps its colors.
--
-- Runs in milliseconds: item is a metadata table.

UPDATE "item"
SET thumbnail_design = thumbnail_design || jsonb_build_object(
  'sidebar', CASE type::text
    WHEN 'data-layer' THEN '#55677a'
    WHEN 'derived-layer' THEN '#4c5f45'
    WHEN 'arcgis-service' THEN '#4e6e69'
    WHEN 'form-submission-collection' THEN '#8d6a74'
    WHEN 'web-app' THEN '#9c7648'
    WHEN 'report-template' THEN '#8a5252'
    WHEN 'layer-package' THEN '#6f6b3f'
    WHEN 'widget-package' THEN '#74573b'
    WHEN 'pick-list' THEN '#837448'
    WHEN 'geo-boundary' THEN '#96573b'
    WHEN 'wms-service' THEN '#43625e'
    WHEN 'wfs-service' THEN '#3a5652'
    WHEN 'data-collection' THEN '#7c6280'
    WHEN 'geocoding-service' THEN '#92603a'
    WHEN 'tile-layer' THEN '#715e6e'
    WHEN 'app-template' THEN '#8f6c42'
    WHEN 'point-cloud' THEN '#5b6472'
  END,
  'background', CASE type::text
    WHEN 'data-layer' THEN '#edf1f5'
    WHEN 'derived-layer' THEN '#edf1eb'
    WHEN 'arcgis-service' THEN '#ecf2f1'
    WHEN 'form-submission-collection' THEN '#f4eef0'
    WHEN 'web-app' THEN '#f5f0e8'
    WHEN 'report-template' THEN '#f4eded'
    WHEN 'layer-package' THEN '#f2f1e7'
    WHEN 'widget-package' THEN '#f2ede7'
    WHEN 'pick-list' THEN '#f3f0e6'
    WHEN 'geo-boundary' THEN '#f5eee9'
    WHEN 'wms-service' THEN '#ecf2f1'
    WHEN 'wfs-service' THEN '#ecf2f1'
    WHEN 'data-collection' THEN '#f1edf2'
    WHEN 'geocoding-service' THEN '#f5efe9'
    WHEN 'tile-layer' THEN '#f1eef1'
    WHEN 'app-template' THEN '#f5f0e8'
    WHEN 'point-cloud' THEN '#eef0f3'
  END,
  'titleBar', CASE type::text
    WHEN 'data-layer' THEN '#55677a'
    WHEN 'derived-layer' THEN '#4c5f45'
    WHEN 'arcgis-service' THEN '#4e6e69'
    WHEN 'form-submission-collection' THEN '#8d6a74'
    WHEN 'web-app' THEN '#9c7648'
    WHEN 'report-template' THEN '#8a5252'
    WHEN 'layer-package' THEN '#6f6b3f'
    WHEN 'widget-package' THEN '#74573b'
    WHEN 'pick-list' THEN '#837448'
    WHEN 'geo-boundary' THEN '#96573b'
    WHEN 'wms-service' THEN '#43625e'
    WHEN 'wfs-service' THEN '#3a5652'
    WHEN 'data-collection' THEN '#7c6280'
    WHEN 'geocoding-service' THEN '#92603a'
    WHEN 'tile-layer' THEN '#715e6e'
    WHEN 'app-template' THEN '#8f6c42'
    WHEN 'point-cloud' THEN '#5b6472'
  END
)
WHERE thumbnail_design IS NOT NULL
  AND type::text IN ('data-layer', 'derived-layer', 'arcgis-service', 'form-submission-collection', 'web-app', 'report-template', 'layer-package', 'widget-package', 'pick-list', 'geo-boundary', 'wms-service', 'wfs-service', 'data-collection', 'geocoding-service', 'tile-layer', 'app-template', 'point-cloud')
  AND thumbnail_design->>'sidebar' = '#475569'
  AND thumbnail_design->>'background' = '#f8fafc'
  AND COALESCE(thumbnail_design->>'titleBar', '#475569') = '#475569';

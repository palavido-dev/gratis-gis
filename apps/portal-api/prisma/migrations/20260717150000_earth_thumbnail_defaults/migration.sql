-- Earth thumbnail defaults (#173).
--
-- The Contour brand replaced the saturated per-type thumbnail palette
-- with a muted earth family, but thumbnailDesign blobs are stamped at
-- item creation, so every existing item that still carries a factory
-- default renders the old colors forever. This migration normalizes
-- exactly those rows: a row is touched only when its sidebar equals
-- the OLD factory default for its hue (plus a type key where two
-- types shared a hex), so any user-customized design is left alone.
-- titleBar follows only when it still equals the old sidebar, and
-- background only when it still equals the old default background.
--
-- Runs in milliseconds: item is a metadata table.

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#ecfdf5'
        THEN jsonb_set(thumbnail_design, '{background}', '"#eef1ec"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#5c6b58"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#10b981' THEN '"#5c6b58"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#10b981';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f0f9ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#edf1f5"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#55677a"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#0284c7' THEN '"#55677a"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#0284c7';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#eff6ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#edf1eb"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#4c5f45"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#1d4ed8' THEN '"#4c5f45"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#1d4ed8';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#ecfeff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#ecf2f1"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#4e6e69"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#0891b2' THEN '"#4e6e69"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#0891b2';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f5f3ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f4eef0"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#7d5a64"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#7c3aed' THEN '"#7d5a64"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#7c3aed';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f5f3ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f4eef0"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#8d6a74"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#8b5cf6' THEN '"#8d6a74"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#8b5cf6';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fffbeb'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5f0e8"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#9c7648"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#d97706' THEN '"#9c7648"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#d97706';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fff1f2'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f4eded"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#8a5252"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#e11d48' THEN '"#8a5252"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#e11d48';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#eef2ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f4f0e6"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#8f7440"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#4f46e5' THEN '"#8f7440"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#4f46e5';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f8fafc'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f2f0ec"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#6e675e"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#475569' THEN '"#6e675e"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#475569' AND type::text = 'file';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f8fafc'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f1f0ee"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#565049"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#475569' THEN '"#565049"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#475569' AND type::text = 'print-template';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#ecfdf5'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f2f1e7"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#6f6b3f"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#047857' THEN '"#6f6b3f"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#047857';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f0fdfa'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f3efe6"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#85683f"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#0d9488' THEN '"#85683f"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#0d9488';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f0fdfa'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f2ede7"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#74573b"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#0f766e' THEN '"#74573b"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#0f766e';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f7fee7'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f3f0e6"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#837448"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#65a30d' THEN '"#837448"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#65a30d';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fff7ed'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5eee9"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#96573b"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#ea580c' THEN '"#96573b"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#ea580c';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f1f5f9'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f1f0ec"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#625f55"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#334155' THEN '"#625f55"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#334155';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#ecfeff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#ecf2f1"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#43625e"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#0e7490' THEN '"#43625e"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#0e7490';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#ecfeff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#ecf2f1"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#3a5652"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#155e75' THEN '"#3a5652"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#155e75';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fffbeb'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5f0e6"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#a1793f"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#b45309' THEN '"#a1793f"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#b45309' AND type::text = 'folder';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fffbeb'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5f0e8"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#8f6c42"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#b45309' THEN '"#8f6c42"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#b45309' AND type::text = 'app-template';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#faf5ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f1edf2"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#6d5570"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#9333ea' THEN '"#6d5570"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#9333ea';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#f5f3ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f1edf2"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#7c6280"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#6d28d9' THEN '"#7c6280"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#6d28d9';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fff7ed'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5efe9"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#92603a"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#c2410c' THEN '"#92603a"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#c2410c';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fdf4ff'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f1eef1"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#715e6e"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#c026d3' THEN '"#715e6e"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#c026d3';

UPDATE "item"
SET thumbnail_design = jsonb_set(
  jsonb_set(
    CASE
      WHEN thumbnail_design->>'background' = '#fdf2f8'
        THEN jsonb_set(thumbnail_design, '{background}', '"#f5eef0"')
      ELSE thumbnail_design
    END,
    '{sidebar}', '"#94606b"'
  ),
  '{titleBar}',
  CASE
    WHEN thumbnail_design->>'titleBar' = '#db2777' THEN '"#94606b"'::jsonb
    ELSE COALESCE(thumbnail_design->'titleBar', 'null'::jsonb)
  END
)
WHERE thumbnail_design IS NOT NULL AND thumbnail_design->>'sidebar' = '#db2777';

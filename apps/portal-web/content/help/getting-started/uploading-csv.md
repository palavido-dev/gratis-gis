---
id: getting-started-uploading-csv
title: Uploading a CSV with coordinates
summary: Pick a CSV on the New Data Layer page and get a mapped layer in one step, even when the latitude / longitude columns aren't named perfectly.
category: getting-started
order: 35
complexity: basic
tags:
  - csv
  - upload
  - data-layer
  - ingest
related:
  - items-data-layer
---

If your spreadsheet has latitude and longitude columns, you can
turn it into a mapped data layer without renaming anything
first. On the New Data Layer page choose **Import**, pick the
file, and the ingest service works out which columns are the
coordinates and which are the attributes.

If your data is in Excel, save it as CSV first: **File → Save As
→ CSV**. The portal reads `.csv`, `.tsv` and `.txt`, but not
`.xlsx` directly.

## How the detection works

When you upload a `.csv`, `.tsv`, or `.txt` file, the server
scans the column headers and the first few rows looking for
a latitude / longitude pair. It matches against a vocabulary
of common names:

- **Latitude side:** `lat`, `latitude`, `latitude_decimal`,
  `lat_dd`, `y`, `y_coord`, `northing`, `point_y`.
- **Longitude side:** `lng`, `lon`, `long`, `longitude`,
  `longitude_decimal`, `lon_dd`, `x`, `x_coord`, `easting`,
  `point_x`.

Capitalization doesn't matter. Underscores, dots, and spaces
in column names are ignored for matching ("Lat (decimal)"
matches "lat").

After identifying a candidate pair, the server validates that
the column values actually look like coordinates:

- Latitudes between -90 and 90.
- Longitudes between -180 and 180.
- A majority of the sampled rows have valid numeric values in
  both columns.

If the candidate pair fails the value check, it's discarded
and the next candidate is tried. If no pair survives, the
upload falls through to the general ingest path and you'll
need to map columns by hand.

## Files we already handle

- **Comma-delimited** (`,`) — the standard CSV.
- **Tab-delimited** (`\t`) — common from spreadsheet "Save as
  TSV" or pasted from a wiki table.
- **Semicolon-delimited** (`;`) — common in European Excel
  exports.
- **UTF-8 BOM** at the start of the file is tolerated.
- **European decimal commas** like `40,7` are recognized when
  the file uses semicolons as delimiters (so the comma in
  the value isn't confused with the field separator).

## When it falls back

The smart-detection path bails out cleanly in these cases,
and the upload proceeds as an attribute-only or geometry-from-
WKT layer:

- No columns matched the latitude / longitude vocabulary.
- Values that looked like coordinates were actually UTM
  eastings / northings (out of the WGS84 lat/lng range).
- The file had no parseable data rows.

In those cases the existing geospatial driver kicks in. If
your file has a `geometry` column with WKT or a `.shp` /
`.gpkg` / `.kml` / etc. sibling, that path will pick the
geometry up.

## Tips for a smooth upload

- Use simple column names when you control the source file.
  `lat` and `lng` always work and read clearly in the
  attribute table later.
- Numeric coordinates should be **decimal degrees**, not
  degrees-minutes-seconds.
- If your spreadsheet exports with quoted fields, that's
  fine — the parser handles `"40.7","Site name with, comma"`.

## What happens next

Once the layer ingests, it appears as a new data layer item
you own. Drop it onto any map to render it as a point layer
with all the other columns available as attributes.

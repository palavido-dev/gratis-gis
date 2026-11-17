---
id: items-file
title: File
summary: An item that wraps an arbitrary uploaded file. Use for reference documents, archived deliverables, or anything that doesn't fit a more specific item type.
category: items/data
order: 80
complexity: basic
tags:
  - file
  - item-type
related:
  - items-data-layer
---

A **file** is an item that wraps a single uploaded file: a PDF, a
spreadsheet, a Word doc, a zipped Shapefile you're hanging onto
for reference, a contract scan. The portal stores the bytes in
MinIO and exposes the item the same way every other item is
exposed.

## When to use file vs. something more specific

If the file is functionally something the portal can do more with,
upload it through that item type instead:

- A Shapefile / GeoJSON / GeoPackage / KML you want to render →
 **Data layer** (the new-item wizard offers upload-and-ingest).
- A PMTiles / MBTiles / zipped XYZ tile bundle → **Tile layer**.
- A DOCX you want as a designed document report → that would be
 **Report template**, which is not built; keep it as a **File**
 for now, or use a **Print template** for map-on-paper PDF.
- An XLSX form spec → **Form** (import the XLSForm).

Otherwise, **File** is the catch-all. Reference data, archived
deliverables, supporting documentation, anything you want
discoverable from the portal that doesn't fit a more specific
item type lands here.

## What's stored

- **The file itself**, in MinIO under an opaque storage key.
- **Original filename and content-type**, for download.
- **Size** in bytes, surfaced on the item card.
- **Metadata** (title, description, tags, sharing). Standard for
 all item types.

## Download vs. inline view

The detail page has a **Download** button. For a small number of
content types (PDF, plain text, common image formats), an inline
preview also appears. Anything else, you download to look at it.

## Sharing

Standard three-tier. A public file shows up as a direct download
link to anyone with the URL. Org-only requires a sign-in.

## Notes

- **No transformations.** Files come out exactly as they went in.
 The portal doesn't transcode, re-encode, OCR, or otherwise touch
 the bytes.
- **Versioning** isn't built in. Uploading a new version is a
 fresh file item; if you want history, keep the old item and tag
 it appropriately.

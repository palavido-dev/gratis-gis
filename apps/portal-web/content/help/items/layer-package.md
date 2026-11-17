---
id: items-layer-package
title: Layer package
summary: An archive item that bundles a data layer's schema, styling, and (optionally) features into one downloadable file for sharing with other portals.
category: items/data
order: 180
complexity: advanced
tags:
  - layer-package
  - item-type
  - export
related:
  - items-data-layer
  - bundle-export
---

A **layer package** is an archive item: one downloadable file that
bundles a data layer's schema, default symbology, and optionally
its features, so another GratisGIS portal can import a working
copy without you having to re-set anything up.

This is the right item type when you're handing a layer to a
sibling org or open-sourcing a reference dataset and want the
recipient to see the same thing you see.

## Layer package vs. bundle export

The two surfaces look similar; they answer different questions:

- **Bundle export** is a one-shot file you generate from a layer's
 detail page (or feature browser). It's a working archive: data
 plus related tables plus attachments. Use to hand someone a
 snapshot.
- **Layer package** is a portal item with its own identity. It
 holds the package file but also remembers the source layer it
 was generated from. Use to publish a sharable version.

You can build a layer package FROM a bundle export, or generate
one directly.

## What's in the archive

- **Schema**. Field list, types, domains, required flags.
- **Symbology**. Default style (when imported, the new layer
 starts with this style).
- **Popup config**.
- **Optional related-table schemas** (one-to-many child tables).
- **Optional features**. The actual rows, in GeoPackage format.
 You can publish a package WITHOUT features (schema-only) for
 templates.
- **Optional attachments**. Photos and files bound to features.
 Big packages get big fast when attachments are included.

## Importing one

The new-item wizard accepts `.gpkg` and `.zip` layer packages.
On import, the portal:

1. Creates a new data layer with the package's schema.
2. Applies the package's default symbology.
3. Bulk-loads any included features.
4. Restores attachments by re-uploading each file.

## Sharing

Standard three-tier. Layer packages are often the right thing to
share publicly when the underlying data layer is sensitive: the
package can include schema only, and the layer remains private.

## Notes

- **Two-way sync isn't a thing.** Importing a layer package
 produces a new, independent data layer. Edits in the new layer
 don't propagate back to the source. To re-publish, re-export
 the package.
- **Format stability.** The package format is GeoPackage
 (`.gpkg`) plus a sidecar JSON for portal metadata, wrapped in
 a ZIP when attachments are included. Any portal at the same
 version (or newer) can import; older portals may reject newer
 schema features.

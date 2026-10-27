---
id: reference-cite-an-item
title: Cite a public item
summary: Download BibTeX, RIS, or Schema.org JSON-LD for a public catalogue item.
category: reference
order: 49
complexity: basic
tags:
  - citation
  - bibtex
  - ris
  - metadata
related:
  - reference-api
  - items-data-layer
---

When an item is shared as **Public**, anyone can cite it. Open the
item, go to the **Metadata** tab, and use the **Cite** menu to
download:

- **BibTeX** (`.bib`) for LaTeX and most reference managers
- **RIS** (`.ris`) for EndNote, Zotero, and similar tools
- **Schema.org JSON-LD** for structured web metadata

The same files are available without signing in:

```
GET /api/public/ogc/citation/{item-id}.bib
GET /api/public/ogc/citation/{item-id}.ris
GET /api/public/ogc/citation/{item-id}.jsonld
```

## What goes into the citation

- **Title**, **description**, and **license** from the item
- **Author** from the owner's display name (or the organization
  name when no owner name is set)
- **Year** from the item's created date
- **URL** pointing at the portal item page
- The item's UUID as a durable identifier

GratisGIS does not mint DOIs. If you need a DOI, register one with
your preferred agency and put that URL in the item description or
license field until a dedicated DOI field exists.

## Related

- [The HTTP API](reference-api) for the full public catalog surface
- [Data layer](items-data-layer) for the most common citable item type

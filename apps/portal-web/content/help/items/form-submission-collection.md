---
id: items-form-submission-collection
title: Form submission collection
summary: A non-spatial item type that stores form responses when those responses don't map onto a feature.
category: items/field-and-forms
order: 40
complexity: intermediate
tags:
  - form-submission-collection
  - item-type
  - forms
related:
  - items-form
  - items-data-layer
---

A **form submission collection** is a non-spatial table that backs
a form whose answers don't belong on a map. Think customer
satisfaction surveys, meeting RSVPs, training rosters, internal
incident reports. Same form designer, same submission flow, but no
PostGIS geometry column.

## When to use this vs. a data layer

Pick a form submission collection when:

- The questions don't have a "where" answer at all.
- Or they do, but the location is incidental (an inspector typed an
 address, but you're not going to map it).

Pick a data layer when:

- The submission represents a feature on a map (a damaged hydrant,
 an observed bird, a parcel boundary).
- You want the answers to render alongside other layers in the map
 builder.

You can change your mind later by exporting and re-importing into
the other item type. There's no schema-level promotion path
because the two backing tables differ structurally.

## What's stored

- **A schema**. Same field-type vocabulary as a data layer's
 sublayer schema (text, number, date, single-select, etc.) minus
 the geometry column.
- **Rows**. One per submitted response, with the submitter's user
 id and timestamp.
- **Optional attachments**. Files bound to a submission, same as
 feature attachments on a data layer.

## Browsing responses

The submission collection's detail page has a **Responses** table:
filter, sort, export. The same export pipeline as a data layer
(CSV, XLSX, bundle ZIP) is available.

## Sharing

Standard three-tier sharing (Owner only, Organization, Public).
Sharing the *collection* is separate from sharing the *form*. A
public form can still post into an owner-only collection: the
submitter writes one row, but they can't see the rest.

## Notes

- **No map rendering.** You can't put a submission collection on
 a map. The map builder filters them out of the layer picker.
- **No geometry editing.** Submissions can be edited from the
 Responses table, attribute-only.

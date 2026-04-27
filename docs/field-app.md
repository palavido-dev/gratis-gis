# Field app (form + form_submission_collection items)

> **Superseded.** The design for editing existing data and capturing
> new data (in the field or on the web) lives in
> [`editing-and-collection.md`](./editing-and-collection.md). That
> document introduces two new item types (`editor` and
> `data_collection`) that wrap and replace the patterns sketched here.
> This file is kept as a pointer for anyone who follows references
> from older comments or commits.

## What changed

The earlier sketch on this page proposed a single "field app" that
combined Survey123-style and Field Maps-style flows over the existing
`form` + `form_submission_collection` items. The current design
splits the write-side workflows along clearer lines:

- **Editor** for online, tool-driven editing of existing data on a
  desktop. Feature templates, snap, vertex editing, attribute panel.
- **Data Collection** for form-driven capture, online or offline,
  with map-centric and form-centric modes. Wraps the existing `form`
  and `form_submission_collection` items.

`form` and `form_submission_collection` keep their roles as the
schema and submission-store primitives. They are referenced by
Data Collection items rather than being the deployment surface
themselves.

See [`editing-and-collection.md`](./editing-and-collection.md) for
goals, item shapes, schema-evolution policy, offline architecture,
and desktop GIS integration.

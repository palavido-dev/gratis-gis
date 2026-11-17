---
id: print-templates-tokens
title: Template tokens
summary: Parameter and dynamic chips in print-template text elements — not mustache report syntax or DOCX merge fields.
category: print-templates
order: 30
complexity: advanced
tags:
  - print-templates
  - tokens
related:
  - print-templates-overview
  - print-templates-parameters
  - items-print-template
---

Print template **text** elements are built from **segments**:
literal text mixed with **binding chips**. The designer shows
chips in the canvas; at print time the renderer joins literals
with resolved values.

This is not a `{{ ... }}` mustache language, not a `for` /
`query(...)` report engine, and not DOCX mail-merge. Those belong
to the unbuilt [report template](items-report-template) design.

## Binding sources

A binding chip has a **source** and a **token id**:

- **Parameter.** Resolves to a declared
  [parameter](print-templates-parameters)'s value (`tokenId` =
  parameter id).
- **Dynamic.** Resolves to a built-in filled at print time.

Optional **format** hints (for example a date pattern) may be
stored on the chip; keep them simple.

## Dynamic tokens

Built-ins the renderer fills automatically:

| Token id | Meaning |
| --- | --- |
| `today_date` | Today's date |
| `today_datetime` | Today's date and time |
| `now_time` | Current time |
| `map_scale` | Scale of the print job's map |
| `map_extent_bbox` | Map extent as a bbox string |
| `map_center_latlon` | Map center lat/lon |
| `user_display_name` | Signed-in user's display name |
| `org_name` | Organization name |
| `app_name` | Host web app name (when printing from an app) |
| `page_number` | Page number (single-page layouts today) |

Map / legend / scalebar / north-arrow elements do **not** use
text tokens; they bind to the print job's map as whole elements.

## What is not supported

- Mustache bodies, filters (`| upper`), or chained pipes.
- `for` / `if` blocks over layer queries.
- Embedded `{{ map(...) }}` helpers inside text.
- DOCX or HTML document merge.

For structured documents from feature rows or form submissions,
that product is not built. Use print templates for paper maps.

## Notes

- Prefer chips in the designer over hand-editing JSON segments.
- Empty parameter values fall back to the parameter's default
  when one is set.
- Images are separate **image** elements (URL or data URI), not
  tokens inside text.

---
id: form-xlsform-import
title: Importing an XLSForm
seoTitle: "Import an XLSForm from Survey123, ODK or KoboToolbox"
summary: Bring a Survey123, ODK, or KoboToolbox XLSForm into a GratisGIS form item.  The form designer's Import button accepts .xlsx alongside .json.
category: forms
order: 30
complexity: basic
controls:
  - id: form-import-button
    label: "Import button on the form designer toolbar"
tags:
  - forms
  - xlsform
  - survey123
  - import
  - migration
related:
  - items-form
---

The form designer's **Import** button accepts XLSForm `.xlsx`
files in addition to native `.gratisgis-form.json` exports. Drop
a Survey123 template, an ODK form, or a KoboToolbox export onto
the picker and the translator produces a GratisGIS form you can
immediately edit + publish.

This is the standard migration path off Survey123.

<!-- screenshot: form designer Import button highlighted, file picker open showing an .xlsx file selected -->
## How to import

1. Open the form designer.
2. Click **Import**.
3. Pick an `.xlsx` (the file picker accepts `.xlsx`, `.xls`, and
 `.xlsm`).
4. Confirm the replacement. Existing questions on the form are
 replaced wholesale.

The result drops you into the designer with the imported questions
ready to edit.

## What translates cleanly

- **Question types**: text, integer, decimal, date, time,
 datetime, geopoint, geotrace, geoshape, image, audio, video,
 file, barcode, note, acknowledge, calculate, hidden, range, rank,
 select_one, select_multiple.
- **begin_group / end_group** become group containers.
- **begin_repeat / end_repeat** become groups with `repeat: true`.
- **Appearance refinement**: text+multiline → multiline question;
 text+url → URL question; integer+rating → rating.
- **Choice lists**. Looked up by `list_name`.
- **Labels, hints, defaults**, `required`, `read_only`.
- **Multi-language labels**. The bare `label` column wins; first
 `label::*` variant is the fallback.
- **Settings sheet**. `form_title` becomes the form title.

## What preserves as raw strings

Expressions in `relevant`, `constraint`, `constraint_message`,
`calculation`, and `choice_filter` columns land on the question's
`meta.xlsform` block verbatim. They're stored, but not yet
evaluated at runtime.

The importer surfaces a warning per affected question pointing
you at the GratisGIS expression editor to re-author them.

Re-authoring is straightforward because the GratisGIS expression
language and XLSForm share the same shape (boolean operators,
field references, common functions like `today()`, `selected()`,
`concat()`).

## What gets dropped

- **Meta question types** (`start`, `end`, `today`, `deviceid`,
 etc.). GratisGIS records submission timestamps + the
 submitter's identity automatically, so these don't need to be
 declared.
- **Cascading `select_one_external`** (treated as plain
 `select_one`).
- **`pulldata()`** and audit metadata.
- **`bind::*` / `body::*` extension columns.**
- **Image-map appearance.**

Unrecognized rows produce a warning and are skipped, so a
95%-supported survey still imports cleanly.

## After import

- **Field bindings**: if the imported form should write into an
 existing data layer, link the data layer at the top of the
 form designer and the importer's question ids will auto-bind
 to matching field names.
- **Validation**: walk the warnings panel; each warning links to
 the question that needs attention.
- **Test it**: switch to the **Preview** tab and submit a test
 response.

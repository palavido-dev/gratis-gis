---
id: coming-from-arcgis-survey123
title: Survey123 to form
summary: Bring a Survey123 survey over by exporting its XLSForm and importing into a GratisGIS form item.
category: coming-from-arcgis
order: 40
complexity: intermediate
tags:
  - migration
  - survey123
  - form
  - xlsform
related:
  - items-form
  - forms-xlsform-import
  - coming-from-arcgis-terminology
---

A Survey123 survey can be brought over as a GratisGIS **form** by
importing its XLSForm on the form designer. That is a file import,
not a Survey123 drop-in. The ArcGIS Online content importer skips
surveys and forms. The field PWA runs the form offline. It is not
Field Maps.

## Getting the XLSForm out of Survey123

Two paths, depending on how the survey was authored:

- **If you built it in Survey123 Connect** (the desktop authoring
 tool), you already have the `.xlsx`. Use that.
- **If you built it in the Survey123 web designer**, open the
 survey in Survey123 Connect once (it'll download the `.xlsx`
 representation) or use the API: `GET /content/items/<id>/data`
 on the survey form item returns the XLSForm.

## Pick the backing item type

Before importing, decide what the responses are bound to:

- **A new data layer** (the survey records features on a map). The
 form import wizard offers to create one with a schema matching
 the form. Pick this for spatial surveys.
- **An existing data layer** whose schema is compatible with the
 form. Pick this when you're consolidating spatial data already
 in GratisGIS.
- **A new form submission collection** (non-spatial). For surveys
 like satisfaction questionnaires, training rosters.

You can change which item the form binds to at import time; you
can't change it after.

## Running the import

1. Create a new form in GratisGIS (or open an existing form's
 designer in "import / replace" mode).
2. Click **Import** → **XLSForm (`.xlsx`)**.
3. Pick the binding (data layer or form submission collection).
4. The importer reads the survey, questions, choices, and
 settings sheets, maps each row to a GratisGIS question, and
 shows a preview.
5. Review the warnings list (see below) and click Apply.

## What carries over

- **Questions.** Most XLSForm types map directly: `text`,
 `integer`, `decimal`, `select_one`, `select_multiple`, `date`,
 `time`, `dateTime`, `geopoint`, `geotrace`, `geoshape`, `image`,
 `audio`, `video`, `file`, `note`, `calculate`.
- **Choices.** Each `select_one` / `select_multiple` choice list
 becomes either an inline list on the field or (if you ask the
 importer to) a reusable **Pick list** item.
- **Required / read-only / relevant / constraint** column values.
- **Default values.** Including computed defaults that use the
 expression language (today, position, username).
- **Group structure.** Begin-group / end-group are honored as
 form sections; nested groups become nested sections.

## What does NOT carry over

- **Pulldata / external choices** from a Survey123 reference CSV.
 The importer surfaces these as warnings; rebuild as joined
 layers or pick lists in GratisGIS.
- **JavaScript helpers** in calculations. The XLSForm expression
 dialects align mostly; anything that calls a custom function
 specific to Survey123 needs a rewrite.
- **Theming / images.** Survey123 themes don't transfer; rebrand
 in the form item's designer.
- **Existing responses.** The form definition imports; the data
 (existing submissions) is a separate move. Export from
 Survey123 as CSV / FGDB, import into the bound data layer.

## After import

- **Test submission.** Open the form in the field PWA preview
 mode and submit a test response. Verify it lands in the bound
 item.
- **Sharing.** Set deliberately on the new form item; AGO
 sharing didn't carry.
- **Public submission URL.** If you want anonymous public
 submission, enable it in the form's settings; the form gets a
 tokenized URL distinct from the org-internal URL.

## See also

- **Form**. The native item type docs.
- **Importing an XLSForm**. The field mapping reference (covers
 ODK and KoboToolbox alongside Survey123).

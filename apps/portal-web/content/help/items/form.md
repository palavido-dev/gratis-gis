---
id: items-form
title: Form
summary: An item that collects new features or non-spatial responses from people in the field or at their desks. The native equivalent of a Survey123 survey.
category: items/field-and-forms
order: 30
complexity: basic
tags:
  - form
  - item-type
  - data-collection
related:
  - items-form-submission-collection
  - items-data-layer
  - items-data-collection
  - forms-form-designer
  - forms-xlsform-import
---
![Form designer canvas](/help/forms/form-designer-canvas.png)

A **form** is an item that presents a question list to a respondent
and writes their answers into a backing layer when they submit.
Forms are how non-GIS people contribute data: damage assessments,
inspections, citizen reports, training rosters.

## What a form binds to

Every form is bound to a single backing item. Two cases:

- **Bound to a data layer**. Submissions become new features in
 the layer's sublayer. The form is essentially a feature-collection
 survey.
- **Bound to a form-submission-collection**. Submissions are
 non-spatial rows in a dedicated submission table. Use this when
 the answers aren't tied to a feature (a customer satisfaction
 survey, a meeting attendance log).

The binding is set when you create the form and can't be changed
after; the field layout is built against the target schema.

## What's in a form

- **Questions**, each mapped to a backing field. Question types
 include short text, long text, single-select, multi-select,
 number, date, photo, location, signature, and a few composite
 types.
- **Layout**. Question order, page breaks, section headers,
 conditional visibility rules.
- **Validation**. Required, min, max, regex, custom expression.
- **Defaults**. Pre-filled values, including computed defaults
 (geolocate-on-open, today's date, current user).
- **Submission permissions**. Who can submit; an option to allow
 anonymous public submission via a tokenized URL.

## How submissions flow

1. A respondent opens the form in the portal or the field PWA.
2. They fill it in and tap **Submit**.
3. The portal validates against the schema and writes the row.
4. The submission shows up in the bound layer's feature browser
 immediately. No approval step by default.

Approval workflows (queue submissions for a reviewer before
publishing) are a separate item type, **Form review queue**, layered
on top.

## Form sharing vs response sharing

The form item's sharing controls who can **open** the form and
submit. The paired data layer (created when you save a form with at
least one question) has its **own** sharing, and that is what
controls who can **view** submitted responses. By default the layer
is private to you.

The form designer shows a short notice above the canvas with the
paired layer's current access tier and a link to manage it. Sharing
the form publicly to collect answers does not automatically make
responses public.

## Importing an existing form

The form designer's **Import** button accepts:

- **XLSForm** (`.xlsx`) from Survey123, ODK, or KoboToolbox.
- **GratisGIS form JSON** (`.json`) exported from another portal.

See **Importing an XLSForm** for the field mapping rules.

## Versions and edits

Editing a deployed form is allowed but constrained: you can add
new questions, reorder, change labels, tighten validation. You
cannot remove a field that has data in it or change a field's type
without first archiving the existing responses. The designer
surfaces blocked operations with an explanation.

## See also

- **Form designer**. The visual builder, page by page.
- **XLSForm import**. The one-time conversion from external surveys.
- **Form submission collection**. The non-spatial backing item.

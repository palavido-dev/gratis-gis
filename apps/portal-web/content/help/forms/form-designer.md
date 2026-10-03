---
id: forms-form-designer
title: Form designer
summary: The visual builder for a form item. Drag in questions, set validation, preview, publish.
category: forms
order: 5
complexity: basic
tags:
  - form-designer
  - forms
related:
  - items-form
  - forms-question-types
  - forms-conditional-logic
  - forms-xlsform-import
---

The **form designer** is the visual builder that defines a form
item's question list, layout, validation, and submission
behavior. It opens from a form item's detail page (**Open
designer**).

![Form designer with a location question and a text question](/help/form-designer.svg)

Open the designer's **Responses** tab. Owners and organization
admins see the latest submissions there. **Download PDF** saves
a text receipt of that submission's answers. It is not a
designed report and it does not include a map image.

## The four panels

- **Question palette** (left). The catalog of question types you
 can drop into the form. Drag onto the canvas.
- **Canvas** (center). The visual layout. Drag questions to
 reorder; click to select; right-click for delete / duplicate.
- **Question editor** (right). Per-question settings: label,
 backing field, validation, default, conditional visibility,
 hint text.
- **Preview** (toggleable). Renders the form the way a
 respondent would see it. Submitting in preview mode does NOT
 write to the backing layer; it's purely a UI dry run.

## Authoring flow

1. Decide the **backing item** (data layer for spatial forms,
 form submission collection for non-spatial). Picked at form
 creation; can't change after.
2. Drop the first **question** from the palette.
3. In the editor on the right, pick the **backing field**. The
 portal lists the fields available on the backing item; the
 question reads/writes that field.
4. Set label, hint, validation, default.
5. Repeat for each question.
6. Use the preview toggle to verify the flow.
7. **Save**. Saved forms are queryable but not yet shared; share
 deliberately from the detail page.

## Page breaks and sections

For long forms, break into pages:

- **Section header**: a non-input question that groups
 subsequent questions visually. Renders as a heading.
- **Page break**: forces a new page in the runtime; the
 respondent clicks "Next" between pages.

Both are drag-in palette items.

## Conditional visibility

Questions can be hidden based on the answers to earlier
questions. See **Conditional logic** for the full expression
syntax. The designer surfaces conditional state in the canvas
(faded-out questions show as conditional on a tooltip).

## Importing instead of authoring

If you already have an XLSForm (from Survey123, ODK,
KoboToolbox), use **Import** instead of building from scratch.
See **Importing an XLSForm**.

## Versioning

Saving a form publishes a new version. The detail page shows
version history; you can roll back to a previous version, which
becomes the new latest.

## Notes

- **Field type drives question type.** A question bound to a
 `date` field can only be a date question; the designer
 disables incompatible question types in the palette per
 selected question.
- **Required vs. constraint.** Required means "must answer";
 constraint means "answer must match this expression."
 Constraint without Required allows blank.
- **Hint vs. label.** Label is the question text; hint is
 secondary helper text below.

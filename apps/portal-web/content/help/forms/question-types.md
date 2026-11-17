---
id: forms-question-types
title: Question types
summary: The catalog of form question types and which backing field types they're compatible with.
category: forms
order: 20
complexity: basic
tags:
  - forms
  - question-types
related:
  - forms-form-designer
  - items-pick-list
---

A **question type** is the runtime widget a respondent
interacts with. Each type binds to a specific backing-field type;
the designer enforces compatibility.

## Text input

- **Short text**. One-line input. Compatible with `text`
 (varchar) fields. Settings: max length, placeholder, regex
 validation.
- **Long text**. Multi-line text area. Compatible with `text`
 fields without a length cap.
- **Email**. Short text with email validation. Compatible with
 `text` fields.
- **URL**. Short text with URL validation. Compatible with
 `text` fields.

## Numeric

- **Integer**. Whole number input with up/down spinner.
 Compatible with `integer` and `bigint`.
- **Decimal**. Floating-point input with configurable
 precision. Compatible with `decimal`, `float`, `double`.
- **Percent**. Decimal with `%` suffix and 0-100 default
 constraint. Stored as 0-100 (not 0-1.0).
- **Currency**. Decimal with a currency symbol prefix.

## Date and time

- **Date**. Calendar picker. Compatible with `date`.
- **Time**. Clock picker. Compatible with `time`.
- **Datetime**. Combined. Compatible with `timestamp` or
 `timestamp with timezone`.

## Choice

- **Single select (dropdown)**. One option from a list.
 Compatible with text or pick-list-typed fields.
- **Single select (radio buttons)**. Same data shape; different
 widget. Use for short lists where one-click is faster than a
 dropdown.
- **Multi-select (checkboxes)**. Multiple values. Compatible
 with text-array fields or with a delimited-list convention.
- **Single select (autocomplete)**. For long lists (50+).
 Searchable; the data shape is the same as the dropdown.

Choice lists can be inline (defined per question) or reference
a **Pick list** item (preferred for reusable vocabularies; see
**Pick list**).

## Spatial

- **Location** (`geopoint`). Compatible with `point` geometry.
 The capture mode decides the control:
 - **Auto** (default): a "Capture location" GPS button plus a
   small map. Tap the map or drag the pin when you are reporting
   a spot you are not standing on, or have no GPS fix.
 - **Map**: the map only; tap or drag the pin. If the map cannot
   load (no WebGL, or the map library is blocked), the GPS button
   and latitude and longitude boxes appear instead.
 - **GPS**: the GPS button only, no map.
 - **Manual**: latitude and longitude boxes.
- **Draw line / polygon**. A map with line/polygon draw tools.
 Compatible with `line` / `polygon` geometry.

## File and media

- **Photo**. Camera capture or upload. Stored as a feature
 attachment.
- **Audio**. Microphone capture or upload.
- **Video**. Camera capture or upload. Often size-capped per
 org settings.
- **Signature**. Touch-pad signature capture. Stored as a PNG
 attachment: uploaded as soon as you stop signing when there is a
 connection, otherwise when the response syncs.
- **File**. Any document upload (PDF, DOCX, etc.).

## Special

- **Note**. A non-input that displays helper text. Doesn't
 produce a stored value.
- **Calculate**. A non-input that computes a value from other
 questions and stores it. Compatible with any field. Common
 use: a "completed_at" timestamp set to `now()` on submit.
- **Barcode**. Camera-based barcode/QR scanner. Compatible with
 text fields.

## See also

- **Conditional logic**. Showing or hiding questions based on
 answers.
- **Form designer**. The visual builder that orchestrates
 these.

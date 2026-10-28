---
id: print-templates-parameters
title: Parameters
summary: Inputs a print template declares; the Print widget form prompts for them at print time.
category: print-templates
order: 20
complexity: intermediate
tags:
  - print-templates
  - parameters
related:
  - print-templates-overview
  - print-templates-tokens
  - items-print-template
  - widget-print
---

A print template's **parameters** are the inputs the Print form
collects at print time. The template author declares them on the
item; text elements bind to them with parameter chips. They are
not report-template "run against this feature" inputs — print
templates do not take feature references, date ranges, or layer
pickers.

## Supported parameter types

- **Text**. A short string.
- **Long text**. A multi-line string (notes, disclaimers).
- **Number**. Numeric input.
- **Date**. Calendar date input.
- **Dropdown**. Single pick from author-defined options
  (`value` + `label`).

Each parameter has:

- **Id.** Stable machine name used by text-element bindings
  (lowercase ASCII, no spaces). Renaming the label does not break
  bindings.
- **Label.** Shown in the Print form.
- **Description** (optional). Helper text under the input.
- **Default value** (optional). Initial form value and fallback
  when the user leaves the field empty.
- **Required** (optional). The runtime form blocks Print until
  filled.

## Authoring

In the print template designer, the **Parameters** list is the
editor. Starters typically seed a Title (and sometimes Subtitle,
Author, Project, Notes). Add more as the layout needs them.

## Running

In a web app, the **Print** widget renders one control per
parameter for the selected template, then opens the print page
with those values. From the map editor Print path, the same
parameter model applies once you open a template.

There is no separate "Run" action on the item detail page that
generates a stored DOCX or archived PDF. Print is the browser
print / Save as PDF flow against the layout.

## Notes

- **Required parameters** block Print until filled.
- **Ids stay stable.** Bind text chips to the id, not the label.
- **No feature / layer parameters.** For map-driven content, use
  map / legend / scalebar / north-arrow elements; they bind to
  the print job's map automatically.

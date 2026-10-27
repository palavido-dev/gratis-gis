---
id: widget-filter
title: Filter widget
summary: Pick categories from a layer field to narrow charts, indicators, maps, and tables on the same dashboard page.
category: web-apps/widgets
order: 81
complexity: intermediate
tags:
  - widget
  - filter
  - dashboard
  - cross-filter
related:
  - widget-chart
  - items-web-app
  - items-dashboard
---

The **Filter** widget shows distinct values from a chosen field
on a bound layer. Choosing one or more values narrows other
widgets on the same page that share that layer (charts,
indicators, maps, attribute tables). The selection is temporary:
it is not saved with the app, and only one page-wide selection
is active at a time.

## Inputs

- **Bound layer**. A data layer (or derived layer) the rest of
  the dashboard already uses.
- **Category field**. The discrete field whose values appear as
  options (status, type, region, and similar).
- **Title** (optional).

## How it interacts with charts

Clicking a bar or pie slice on a **Chart** widget can set the
same page-wide selection. The Filter widget’s own option list
ignores its own selection so the full list of values stays
visible while other widgets narrow.

## Notes

- Prefer a field with a modest number of distinct values. Huge
  cardinality makes a long checklist and a heavy group-by.
- Clearing the selection restores the unfiltered view for every
  consumer on the page.
- Numeric or date range filtering from this widget is not in
  the category checklist yet; histogram bars on a chart can
  still publish range clauses into the same cross-filter path.

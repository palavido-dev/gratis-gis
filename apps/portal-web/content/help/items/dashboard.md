---
id: items-dashboard
title: Dashboard
summary: Dashboards are web apps started from the KPI Dashboard or Operations Board template. There is no dashboard item type.
category: items
order: 60
complexity: intermediate
tags:
  - dashboard
  - item-type
  - reporting
related:
  - items-map
  - items-data-layer
  - items-report-template
---

A **dashboard** in GratisGIS is a **web app** that starts from the
**KPI Dashboard** or **Operations Board** template. Create one
from **Create, Web app**, then pick that template. The old
`dashboard` item type is not offered. A leftover row explains
this and links to a new web app. It has no editor of its own.

Those layouts use the web app builder's widgets (including the
indicator) and can grow a map, a chart, or another page. The
dashboard templates refresh on a schedule (once a minute unless
you change it). This is not an ArcGIS Operations Dashboard
drop-in.

Edit the layout in the web app builder, the same place you edit
any other web app. Sharing follows the web app: sharing the app
does not automatically share every layer it draws.

On a phone the same layout stacks. Indicators that sat in one row
sit two across, and the map and charts each take the full width
and scroll. The desktop arrangement is what you edit; the phone
reflow is automatic.

Paper output from a web app is a **print template**. A dedicated
document report item is not built.

## See also

- **Web app**. The item you actually create.
- **Print template**. Paper layouts for the Print tool.
- **Report template**. The document-report item that is not built.

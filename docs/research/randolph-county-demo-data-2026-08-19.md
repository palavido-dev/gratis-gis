# Real Randolph County data for the demo dashboard

Prompted by: the facilities dashboard on the demo is 50 points with
three attributes, which shows the widgets work but not what they are
for. We want one or two real West Virginia datasets with enough
substance to make an illustrative dashboard.

Everything with a number in it below was queried live on 2026-08-19,
not read off a metadata page.

## The WVGISTC finding, stated plainly

The WV GIS Technical Center clearinghouse is largely an **archive of
base mapping, not a source of thematic data**. Its search API
(`wvgis.wvu.edu/searchEngine.php`, `searchStr=clearinghouse<:>search
<::>Location<:>54083`) returns **18 Randolph-tagged records**, and the
shape of that list is the story:

- Nine are 1995-2005 USGS DLG / USFS CFF base layers (contours, roads,
  railroads, hydrography, boundaries, misc transportation) in E00 or
  DLG-optional format. Historically valuable, not dashboardable, and
  in formats we would have to convert before anything could read them.
- Four are raster map products (single-edition topos, softcopy PBS,
  1914-1937 county geology scans).
- **Monongahela National Forest datasets (2020)** are the best
  clearinghouse entry: ownership, ranger districts, wilderness,
  management prescriptions, recreation, roads, as shapefiles with KML.
  Randolph is heavily MNF, so this is thematically apt, but the
  attribute richness is modest.
- **Flood at-risk floodplain structures (USACE, 2003)** has the right
  shape (80k points statewide classified residential / commercial /
  institutional) and the wrong vintage.
- **Timber removal volume (USFS TPO, 1996)** is county-level, so one
  polygon per county: a table, not a map.
- **National Forest boundaries (2024)** is current and useful as
  context, but it is boundaries.

What the Technical Center runs that IS current lives outside the
clearinghouse:

- `services.wvgis.wvu.edu/arcgis/rest/services` — 23 folders. Notable:
  **statewide building footprints** (2,121,130 polygons extracted from
  6"-3" county imagery, 2018-2023, ESRI deep-learning package,
  published 2024) and the trails service.
- `data.wvgis.wvu.edu` — **2026 parcels**, per-county splits. The
  Randolph zip is live (161 MB, modified 2026-08-03). 64,618 parcels
  in the county, but the only numeric is `CALC_ACRE` and the rest is
  identifiers and free text: too many rows and too few facets.
- The LiDAR/elevation download tool.

So: WVGISTC is the right place for **base and imagery**, and the wrong
place for **something to count**. The current thematic data for WV
lives in the agency REST services below.

## Recommendation: two datasets, for different reasons

### 1. WVDEP Oil and Gas Wells — the categorical richness

`https://tagis.dep.wv.gov/arcgis/rest/services/WVDEP_enterprise/oil_gas/MapServer/7`
filtered `where=county='083'`. **1,524 wells in Randolph County**
(154,035 statewide), one attribute filter, no spatial query, and the
whole county comes back in a single GeoJSON request (~1.2 MB).

Verified distributions, which is what makes this a dashboard rather
than a dot map:

| field | values |
|---|---|
| `wellstatus` | Active 649, Plugged 376, Never Drilled 334, Abandoned 162 |
| `welluse` | Gas Production 766, Not Available 436, Unknown 261, Storage 42, House Gas 12, Brine Disposal 5, Oil Production 2 |
| `respparty` (operator) | 82 distinct: Mountain V 169, Diversified 164, EQT 157, Interstate 135, Ross and Wharton 113, Operator Unknown 102 |
| `formation` | Marcellus Shale 40, Oriskany 14, Balltown 5, Elk 5 (NA 1,447) |
| `welltype` | Vertical 1,494, Horizontal 30 |

Plus `issuedate` on 1,234 of them spanning the 1950s to now, which is
a real decade axis.

**The catch, and it is worth knowing before building:** this layer has
**no true numeric field**. `welldepth` is a four-value category ("Deep",
"Shallow greater than 3,000 feet", "Not Available" on 1,277 of them).
Every indicator here is a count. If we want a summed quantity, the
WV Geological Survey's AASG wellheaders layer
(`atlas.wvgs.wvnet.edu/arcgis/rest/services/aasg/WVWellheaders/MapServer/0`,
`County='Randolph'`, 411 records) carries real `DrillerTotalDepth`
values from 1,708 to 13,121 feet.

### 2. WVDOT Bridges — the numbers and the condition story

`https://gis.transportation.wv.gov/arcgis/rest/services/Hosted/Bridge_Map/FeatureServer/0`
filtered `where=UPPER(county)='RANDOLPH'` (the `county` values are
case-inconsistent statewide, so the `UPPER()` is not optional).
**188 bridges**, 76 fields, verified in one query:

- total deck area **798,588 sq ft**, mean span length **127 ft**
- **36 of 188 flagged structurally deficient**, 148 not, 4 unrecorded
- oldest `yrblt` **1900**, 67 distinct years to 2020: a clean histogram
- NBI condition scales (`deck`, `super`, `sub`, `structeval`) as 0-9
  ordinals, which chart beautifully
- `brtype` 27 values, `span_mat` 8, `owner` 4, `signsys` (CR 133 /
  US 41 / APD 8 / WV 3)

This is the one that gives us indicators with a *reference value* (the
widget already supports a target and colors by it): "36 structurally
deficient" against a target of zero is exactly what that feature is
for.

`traffic` on this layer is a route-use category, not a volume. For
actual traffic numbers, **WVDOT Traffic Count Points 2025**
(`services2.arcgis.com/xLpB90lOmCXYDAWo/.../Traffic_Count_Points_2025/FeatureServer/0`,
`County='Randolph'`) has 179 stations with `AADT` summing to 385,267,
mean 2,152, max 20,175, plus truck counts.

## Runners-up worth knowing about

- **NOAA Storm Events** — 680 Randolph events 1955-2026, **$12.5M
  property damage**, event types split cleanly (Thunderstorm Wind 113,
  Heavy Snow 130, Hail 57, Flood 45, Tornado 4). Best narrative of
  anything found and a genuine 70-year axis. Three traps: zone-type
  events store an NWS zone number in `CZ_FIPS` rather than the county
  FIPS (Randolph splits into zones 525/526, and filtering on FIPS
  alone silently drops 418 of the 680, which is most of the winter
  weather); damage is a suffixed string (`"5.00K"`, `"3.75M"`) that
  must be parsed, not cast; and only ~225 of the 680 carry
  coordinates, so the map is thin.
- **National Bridge Inventory (FHWA)** — 189 Randolph bridges, same
  subject as WVDOT but public domain and with better numerics
  (`ADT_029` summing to 263,586, `DECK_AREA`, `YEAR_BUILT_027`
  1900-2023). Every categorical except `BRIDGE_CONDITION` is a numeric
  code, so it needs a lookup table shipped alongside or the charts
  read as integers.
- **WVDEP Mining Permits** — 248 in Randolph, `type` (Prospect 65,
  Coal Surface 61, Coal Underground 58, Quarry 22), `acres_now`
  summing to 6,388. Trap: `acres_dist` / `acres_recl` use `-1` as a
  no-data sentinel on 142 of 248 rows, so an unfiltered sum is
  garbage.
- **USFS Monongahela NF hazardous fuels treatments** — 305 polygons
  with `fiscal_year_completed` 2009-2026, acres and cost per unit: the
  best time series of any USFS layer, and Randolph is largely MNF.
- **USGS NWIS** — 377 sites, and 16 live instantaneous-value
  timeseries across 12 active gages (Tygart Valley, Shavers Fork, Dry
  Fork, Middle Fork). This is the one that would actually exercise the
  auto-refresh we just built, since the numbers change hourly.

## Licensing, which matters because the demo is public

**No WV state service asserts a license.** WVDOT's ArcGIS Online items
return an empty `licenseInfo`, no WVDEP service carries
`copyrightText`, and the closest thing to a grant is the MapWV terms
of use, which say anyone may "view, copy or distribute information
found here without obligation," strictly as-is. That is permissive in
practice and unstated in law.

The federal alternatives (NBI, NOAA Storm Events, USGS, USFS) are
public domain with no ambiguity.

For a public demo portal the honest posture is: attribute the
originating agency prominently on the item and in the dashboard, keep
a "source and as-of date" note in a text widget, and prefer the
federal dataset where the two overlap. That is why NBI is listed as a
runner-up to WVDOT bridges rather than dismissed: same subject,
cleaner rights story, worse labels.

## Suggested build

Load **WVDEP wells** and **WVDOT bridges** as two data layers, then
one dashboard per layer, because they demonstrate different halves of
the widget set:

- *Randolph County oil and gas*: count indicators (total, active,
  plugged), status pie, operator bar (top 8 plus Other, which the pie
  bucketing already handles), decade-of-permit bar, map. Entirely
  count-driven.
- *Randolph County bridges*: indicators for total deck area and mean
  span, a structurally-deficient indicator with a reference of 0 and
  `goodWhen: below`, a condition-rating bar, a year-built histogram,
  map. Entirely measure-driven.

Both fetch in one GeoJSON request each, well under the import
ceiling, and both would be baked into golden so they survive the
nightly reset.

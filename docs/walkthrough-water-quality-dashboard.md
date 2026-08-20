# Building the water quality dashboard, start to finish

A worked example: taking a 9 MB Esri file geodatabase off a university
web server and turning it into a public dashboard that answers real
questions, on a self-hosted portal, with no commercial licenses.

The finished thing is at
[gratisgis.org](https://gratisgis.org) under "See it running":
**Twenty-five years of West Virginia water quality**. 1,175 monitoring
sites, 285,788 measurements, 1995 to 2019.

Everything below is what actually happened, including the two places
it went wrong, because those are the parts a walkthrough usually
leaves out and the parts you will hit.

---

## 0. What we started with

`WQandWell_Data_042020.gdb.zip`, 9.3 MB, published by the West
Virginia GIS Technical Center at WVU. Inside:

| Layer | Rows | What it is |
|---|---|---|
| `WQ_Data_Full_Monthly_Summary` | 23,585 | One row per site per month, a column per parameter |
| `WQ_Data_Full_Monthly_Summary_latest_average` | 4,951 | Same, plus all-time means |
| `MarcellusWells_DeviatedOnly_...` | 2,536 | Permitted gas wells |
| `ParamDescriptionsLatest` | 43 | Parameter, plain-English alias, **contaminant limit** |
| `PoliticalBoundary_24K_wma84` | 55 | Counties |

The parameter table is the interesting one. It carries the published
drinking water limit for each measurement, and marks the aesthetic
ones with an asterisk (`Iron 0.3*`) to separate them from the
health-based ones (`Arsenic 0.01`).

## 1. Decide the shape before importing anything

The source is **wide**: one row per site-month, with 43 measurement
columns. That shape can answer "how many samples are over the iron
limit" but it cannot answer **"exceedance rate by parameter"**, which
is the headline chart, because in wide form each parameter is a column
and a column is not a category you can group by.

So the import reshapes to **long**: one row per site, per month, per
parameter that actually has a value. 285,788 rows.

Two more decisions made at the same time, both of which are about
honesty rather than convenience:

**The limit travels on every measurement row.** Denormalising it
(`limit_value`, `limit_kind`, `over_limit`) turns "over the limit"
into a plain predicate the aggregate endpoint can filter and count,
rather than a join the portal cannot express.

**Primary and secondary limits are never summed.** `limit_kind` is
`primary` (health) or `secondary` (taste, odour, staining). Reporting
"1,003 sites over a limit" and letting a reader assume that means
unsafe is the single easiest way to mislead with this dataset. It
mostly means iron staining laundry.

```
ogr2ogr -f GeoJSON -t_srs EPSG:4326 samples.geojson \
        /vsizip/wq.gdb.zip WQ_Data_Full_Monthly_Summary
```

then a ~150-line Python pass to pivot, attach limits, and roll up a
per-site summary. Full script: `build.py` in the session notes.

## 2. Create the layers

**One data layer item with two layers**, because they are one dataset:

- `sites` — points, 1,175, one per monitoring location, carrying the
  site's rollup (`first_year`, `last_year`, `worst_standard`,
  `primary_exceeded`, `secondary_exceeded`, …)
- `measurements` — the long table, related to `sites` by
  `location_name`

Create the item with `POST /api/items`, giving each layer its field
list, then upload with

```
POST /api/items/<id>/layers/sites/import?mode=replace
POST /api/items/<id>/layers/measurements/import?mode=replace
POST /api/items/<id>/layers/measurements/import?mode=append   (x5)
```

Chunk large uploads. 285,788 features went in six parts of 50,000, one
`replace` then five `append`s, so a single oversized request can never
be the thing that fails.

> **Trap 1.** `measurements` was modelled as an attribute-only table
> (`geometryType: null`), which is the right shape: a reading is not a
> place, it belongs to one. The importer silently skipped every row.
> It drops features with no geometry, reports `inserted: 0`, and says
> nothing. Until that is fixed, give related records their parent's
> point. Tracked as a bug.

## 3. Check the numbers before building anything on them

This step is not optional. A dashboard built on numbers nobody
verified is decorative.

Recompute the headline figures through the portal's **own public
aggregate endpoint** and compare them to what the import script
calculated offline:

```
GET /api/public/items/<id>/layers/measurements/aggregate
      ?agg=countDistinct:location_name
      &where={"combinator":"all","clauses":[
         {"field":"parameter","op":"==","value":"Iron"},
         {"field":"over_limit","op":"==","value":"Yes"}]}
```

| parameter | portal | offline |
|---|---|---|
| Iron | 862 | 862 |
| Aluminum | 692 | 692 |
| Manganese | 613 | 613 |
| pH | 578 | 578 |
| … | | |
| Radium 226 | 0 | 0 |

All seventeen matched. Note `countDistinct:location_name`, not
`count`: 9,600 iron readings over the limit could be one creek sampled
monthly for a decade. **862 sites** is a map.

## 4. Build the map

A dashboard's map should be a real map item, not layers bolted onto
the app. Make it once, style it properly, and every app that reads it
inherits that.

Three layers, deliberately unequal in weight:

- **Monitoring sites**, classed by `worst_standard` into three
  categories: muted brick for a health limit, ochre for an aesthetic
  one, sage for clean. Three classes, not a continuous ramp, because
  the underlying fact is categorical: a limit is either exceeded or it
  is not.
- **Marcellus wells** underneath in low-contrast slate, small and
  semi-transparent. They are context, not the subject. A reader should
  be able to judge whether wells and bad water coincide without the
  wells competing with the thing being measured.
- **Individual measurements**, present but switched off and floored at
  zoom 11. 285,788 points stacked on 1,175 locations is a smear until
  you are close in.

Open the camera on the **data's own extent**, not on the densest part
of it. Framed too tight, the first thing a reader saw was a
health-limit counter reading `0` with no way to know whether that
meant "clean" or "you are looking at the wrong place".

## 5. Build the dashboard

One page, four bands, following the map.

**Sources** are declared once and shared by every widget, so two
widgets reading the same source cannot disagree about what it means:

| source | layer | scope |
|---|---|---|
| `s_sites` | sites | follows the map |
| `s_meas` | measurements | **related** to `s_sites` |
| `s_health` | sites | follows the map, `primary_exceeded > 0` |
| `s_quiet` | sites | follows the map, `last_year < 2015` |
| `s_over` | measurements | related, `over_limit = Yes` |
| `s_iron` | measurements | related, `parameter = Iron` |

The relate is the point. Measurements have no meaningful extent of
their own; they are in view when their **site** is. Declaring
`via: {sourceId: 's_sites', parentField: 'location_name', myField:
'location_name'}` means panning the map re-scopes 285,788 rows through
a server-side semi-join, with a read check on the parent layer. No
widget declares a viewport and none can drift from another.

**Band 1, four counters.** Not an average. A mean of a right-skewed,
censored measurement column is close to meaningless and a scientist
will notice immediately. Sites in view; measurements taken there;
sites over a health limit; **sites not sampled since 2015**. The last
one is the one nobody else shows.

**Band 2, the map.**

**Band 3, exceedance by parameter**, horizontal so the parameter names
read left to right at full size. `countDistinct:location_name` grouped
by `parameter`.

**Band 4, two charts.** Distinct sites per year, which tells the
monitoring story on its own. And a **histogram** of every iron reading
with the limit drawn across it as a reference line, using explicit bin
edges (`0.05, 0.1, 0.3, 1, 3, 10, 30`) because the values span four
orders of magnitude and equal-width bars would put everything in one.

**A second page for the caveats.** The finding here is surprising
enough that it needs them, and a footnote nobody reads is not good
enough.

> **Trap 2.** A dashboard whose map widget points at a real map item
> should not also declare `targets`. It publishes a second, unstyled
> copy of each layer onto the map, which draws over the styled one and
> replaces every class break with a single flat colour. It also
> downloads the whole layer as GeoJSON where the map's own layer
> streams tiles. Fixed in v0.9.54; if you are on an older build,
> leave `targets` empty when you bind a real map.

> **Trap 3.** `readCustomAppData` keys on `data.config.template`, not
> `data.template`. Miss the inner one and the runtime renders its
> "Start building" empty state with all your widgets sitting intact in
> the database and nothing in the console to say why.

## 6. What the dashboard says

In counties chosen for study **because** of Marcellus gas development,
the water quality problem the data actually shows is iron, aluminium,
manganese and acidity. That is the signature of **acid mine drainage**
from a century of coal, not of gas brine.

- Iron over its limit at 862 of the 982 sites where it was measured
- Aluminium at 692 of 865, manganese at 613 of 792
- Barium at **1 site of 239**, chloride at 54 of 832, radium-226 and
  radium-228 at **none at all**

And the monitoring itself: 325 sites sampled in 2010, 53 by 2018.
**861 of 1,175 sites have not been sampled since 2015.**

Two caveats travel with that or it becomes propaganda: the gas
indicators were measured at a fraction of the sites, and these are
mostly streams, which dilute, rather than the private wells people
drink from.

---

## What this took

| | |
|---|---|
| Source data | 9.3 MB, one download |
| Portal features needed | data layers, relate, aggregate with `countDistinct` and numeric binning, chart reference lines, unique-value symbology, public sharing |
| Items created | 1 data layer (2 sublayers), 1 wells layer, 1 map, 1 dashboard |
| Commercial licenses | none |

Every number on the page is computed server-side against the caller's
own permissions, so a viewer with a restricted share sees counters
that match what they can actually see on the map.

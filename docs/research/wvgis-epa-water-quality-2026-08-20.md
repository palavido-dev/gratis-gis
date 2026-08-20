# WVGIS EPA water quality: what is in it, and what it would demo

Matt flagged `data.wvgis.wvu.edu/pub/project/epa_wq/` as interesting
for dashboards and analysis. This is the structural assessment, from
reading the geodatabase rather than the directory listing.

Source: `WQandWell_Data_042020.gdb.zip` (9.3 MB, dated 2020-04-09).
A second file, `WQ_Dtat_Full_w_Parameter_Descriptions.zip` (25 MB),
is not examined here; the `.gdb` carries the same tables in a form we
can read directly.

## What is actually in the geodatabase

| Layer | Geometry | Rows | What it is |
|---|---|---|---|
| (oil and gas wells) | Point | 2,536 | API number, permit, operator, dates, 77 fields |
| `PoliticalBoundary_24K_wma84` | MultiPolygon | 55 | WV counties with census attributes |
| `WQ_Data_Full_Monthly_Summary` | Point | 23,585 | Monthly water quality samples, 56 fields |
| `WQ_Data_Full_Monthly_Summary_latest_average` | Point | 4,951 | Latest average per location, 98 fields |
| `ParamDescriptionsLatest` | none | 43 | Parameter, Alias, **Maximum_Contaminant_Levels**, Description |
| `ParamDescriptions` / `...New` | none | 49 each | Older revisions of the same lookup |

Measured parameters include pH, specific conductance, turbidity, water
temperature, acidity, alkalinity, hardness, total dissolved and
suspended solids, organic carbon, oxidation-reduction potential, and a
radiological set (alpha, beta, gross uranium).

Span: **1995 to 2019**, monthly.

## Two things this is unusually good for

**It is the relate case, properly.** 23,585 monthly rows across
**1,175 distinct locations**, keyed by `Location_Name`: a genuine
20-to-1 parent/child. The demo has nothing that exercises `via`
today, and this is exactly the shape it was built for. Zoom the map
to a watershed, and the monthly time series narrows to the stations in
view without anyone declaring anything per widget.

**`Maximum_Contaminant_Levels` is a real threshold.** The indicator
widget already has a `reference` with `goodWhen: 'above' | 'below'`,
which currently has nothing honest to point at on the demo. A measured
value against a published contaminant limit is exactly what that field
was for, and "3 of 41 stations over the limit" is a sentence a
dashboard should be able to say.

It also carries the **WVDEP oil and gas wells** that could not be
loaded in the 2026-08-19 pass, because WVDEP blocks the demo box's IP
(HTTP 000, connection refused). WVGIS serves the same data and does
not block us.

## The catch: it is not Randolph County

Zero rows in Randolph. Sampling concentrates in the north-central gas
counties, and the wells sit in the same place:

- Water quality: Monongalia 3,931, Preston 3,868, Harrison 2,551,
  Ritchie 2,206, Marion next.
- Wells: Doddridge 526, Wetzel 369, Marshall 346.

That is coherent, it is a Marcellus-region study of water quality near
gas development, but the demo is currently branded around one county:
"Randolph County storm events", "bridges", "facilities". So this is a
decision rather than an import.

## Options

1. **Add it as a second geography and say so.** The demo becomes
   "Randolph County, plus a statewide water quality study", which is
   arguably a better showcase: it demonstrates that the portal is not
   a one-county toy, and the relate and threshold stories are the
   strongest content available. Costs a little narrative tidiness.
2. **Clip to the north-central counties** and present it as its own
   themed dashboard, leaving the Randolph set alone. Same content, no
   pretence that it is one coherent county story.
3. **Skip it** and find a Randolph-scoped water dataset instead. The
   relate stays undemonstrated for now.

Recommendation: option 2. It keeps the Randolph dashboards internally
consistent, gives the relate a real workload, and gives the indicator
threshold something true to compare against.

## Import notes if it goes ahead

- 23,585 rows is comparable to the parcels layer already on the demo
  (23,915), so the size is known-survivable on a 4-core box.
- Load the location layer as the parent and the monthly summary as
  the child, related on `Location_Name`. Do not flatten them: the
  whole point is the one-to-many.
- `ParamDescriptionsLatest` is a lookup, not a relate demo. Its value
  is the contaminant limits, which belong in the widget config or a
  pick list rather than as a third data layer.
- Field names are long and unit-suffixed
  (`Specific_conductance_Field_uS_per_cm`). They are honest but ugly
  in a picker; the source's own `Alias` column in
  `ParamDescriptionsLatest` is the better display name.
- Data ends in 2019. Any dashboard needs to say so, the way the storm
  and bridge dashboards carry their retrieval date, or a reader will
  assume it is current.

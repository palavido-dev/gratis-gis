# WV water quality: the story, the data, and what to build

Design study for a public dashboard on the WVU / EPA water quality
dataset. Written after profiling the actual geodatabase rather than
the column list, because the difference between the two turns out to
be most of the story.

Supersedes the sizing note in `wvgis-epa-water-quality-2026-08-20.md`.

## 1. Why this data exists

It is the **West Virginia Water Quality Impact Portal** (WVWQIP), at
`mapwv.gov/wvwqip/`. Funded by the US EPA, built at WVU, published
2020. The full portal holds over 1.3 million surface and groundwater
samples from the 14 counties where most Marcellus Shale gas
development in West Virginia has happened. What WVGIS publishes as a
geodatabase, and what we would use, is an aggregated monthly summary
of that.

It was led by **Professor Shikha Sharma** (Geology) with doctoral
student **Rachel Yesenchak**, and the WV GIS Technical Center's
Maneesh Sharma and Yibing Han. Data came from WVDEP, the USGS WV
Water Science Center, and local nonprofits.

Their own statement of purpose is the brief we should build to:

> "The map viewer allows for quick visualization of monthly average
> water quality trends that could potentially be used by environmental
> groups, community planners or even regulators to **identify
> locations that may benefit from remediation or increased monitoring
> activities**." — Sharma

And on framing, from Yesenchak, who compiled the data and did the
statistical analysis:

> "I appreciate a balanced approach that considers all sides of an
> issue."

That is not decoration. It is the constraint. This is a dataset about
energy development and water, in a state where that argument is live
and bitter, assembled by people who deliberately did not put a thumb
on the scale. A dashboard that reaches for the alarming number would
be both dishonest and a poor advertisement for us.

## 2. What is actually in it

`WQandWell_Data_042020.gdb.zip`, 9.3 MB.

| Layer | Geometry | Rows | Notes |
|---|---|---|---|
| oil & gas wells | Point | 2,536 | API number, operator, permit dates, 77 fields |
| `WQ_Data_Full_Monthly_Summary` | Point | 23,585 | monthly samples, 56 fields |
| `..._latest_average` | Point | 4,951 | one row per site |
| `PoliticalBoundary_24K_wma84` | Polygon | 55 | WV counties |
| `ParamDescriptionsLatest` | table | 43 | parameter, alias, **contaminant limit** |

**The relate is clean.** `Location` holds a `"lat,lon"` string with
4,951 distinct values, exactly matching the `latest_average` feature
count. So: 4,951 sites as the spatial parent, 23,585 monthly samples
as the child, joined on `Location`. That is the shape `via` was built
for and nothing on the demo currently exercises.

Coverage: 1995 to 2019. 91% surface water, streams. WVDEP collected
84% of it. Among the contributors is **Friends of Deckers Creek**, a
volunteer watershed group with 854 samples spanning 1995 to 2017.

### The trap: coverage is wildly uneven

A column existing is not a column you can chart.

| Parameter | Samples | Sites | % of rows |
|---|---|---|---|
| Specific conductance | 21,922 | 1,169 | 93% |
| pH | 21,771 | 1,161 | 92% |
| Iron | 18,148 | 982 | 77% |
| Sulfate | 15,652 | 954 | 66% |
| Aluminum | 14,680 | 865 | 62% |
| Manganese | 11,488 | 792 | 49% |
| Chloride | 10,844 | 832 | 46% |
| Barium | 3,665 | 239 | 16% |
| Bromide | 2,589 | 266 | 11% |
| **Arsenic** | 2,672 | **16** | 11% |
| **Methane** | 1,776 | **8** | 8% |
| **Ethane / propane** | ~1,700 | **1** | 7% |
| Radium-226 | 168 | 30 | 0.7% |

(Site counts by `Location_Name`. By coordinate the numbers are larger;
either way the ratios hold.)

Read that carefully. **Methane has 1,776 samples across eight
locations. Ethane and propane come from one.** Dissolved methane is
the single most cited number in the entire hydraulic-fracturing
contamination argument, and this dataset cannot speak to it
regionally. A "methane by county" chart here would be an average of
eight sites wearing the costume of a regional statistic. Same for
arsenic at sixteen sites and radium at thirty.

This is the most important thing I learned, and any dashboard we build
has to be built around it rather than in spite of it.

## 3. What the data does say

Exceedances against the limits in the dataset's own
`ParamDescriptionsLatest` table, counted by distinct site:

| Parameter | Limit | Sites measured | Sites over | Share |
|---|---|---|---|---|
| Iron | 0.3 mg/L (secondary) | 4,117 | **2,590** | 63% |
| Manganese | 0.05 (secondary) | 3,583 | **2,162** | 60% |
| Aluminum | 0.2 (secondary) | 3,735 | **1,808** | 48% |
| Sulfate | 250 (secondary) | 3,743 | 765 | 20% |
| Total dissolved solids | 500 (secondary) | 3,356 | 600 | 18% |
| **Arsenic** | 0.01 (**primary**) | 1,826 | **154** | **8.4%** |
| Chloride | 250 (secondary) | 3,602 | 79 | 2.2% |
| Barium | 2 (**primary**) | 2,268 | 9 | 0.4% |
| Selenium | 0.05 (**primary**) | 1,970 | 7 | 0.4% |
| Radium-226 | 5 pCi/L (**primary**) | 125 | **0** | 0% |

pH: 1,480 samples at 392 sites came in **below 5.0**, against a
drinking-water range of 6.5 to 8.5. Another 1,858 samples sit between
5.0 and 6.5.

**The finding, stated plainly:** in the counties chosen for study
*because* of Marcellus gas development, the water quality problem the
data actually shows is iron, manganese, aluminum and acidity. That is
the signature of acid mine drainage from a century of coal, not of gas
brine. The parameters that would indicate produced water — barium,
chloride, radium — are almost never over their limits.

Two honest caveats that must travel with that sentence, or it becomes
propaganda:

1. **The gas indicators were measured far less.** Barium at 2,268
   sites against iron's 4,117; radium at 125. You cannot conclude
   much from 125 sites, and the dashboard should say so rather than
   let a green "0%" imply an all-clear.
2. **These are mostly streams.** Surface water dilutes. The
   groundwater that people actually drink from wells is a small slice
   of this dataset.

Arsenic is the number that deserves attention: 8.4% of measured sites
over a **health-based** limit, not an aesthetic one.

## 4. Who is looking, and what pulls them in

**The concerned citizen** does not want a mean. They want: *is the
water near me all right, and has anyone even looked?* The answer they
can act on is a site, a date, and a comparison to a published limit.
The most useful thing we can tell many of them is "nobody has sampled
within ten miles of you since 2009", which is exactly what Sharma
named as a use for the portal.

**The journalist** wants a defensible sentence with a number in it.
"Two thirds of monitored sites in West Virginia's gas counties exceed
the iron standard, and the pollutant is coal, not gas" is a story.
So is "the state stopped looking: sampling sites fell from 908 in
2015 to 53 in 2019."

**The scientist** wants to see the distribution, not the average;
wants to distinguish signals rather than total them; and wants to
know the n behind every figure. Sharma and Yesenchak specifically
would look for whether we handled the confounding honestly.

## 5. The dashboard

Working title: **"Twenty-five years of water quality in West
Virginia's gas counties."** One page, four bands.

**Band 1, the honest headline.** Not "average pH". Four counters
scoped to the map view:

- Monitoring sites in view
- Samples, and the years they span
- Sites exceeding **any** health-based (primary) limit
- Sites where nobody has sampled since 2015

The fourth is the one nobody else shows and the one the portal's
authors asked for.

**Band 2, the map.** Detailed in §8.

**Band 3, what is wrong and where.** A horizontal bar of exceedance
*rate by parameter*, ordered, with primary and secondary standards
visually separated, because conflating a health limit with a
taste-and-staining limit is the single easiest way to mislead here.
Clicking a bar cross-filters the page, which we shipped yesterday.

**Band 4, has anyone looked.** Sites sampled per year, 1995 to 2019.
This chart tells the monitoring story on its own: a rise through the
2000s, a peak of 908 sites in 2015, and a collapse to 53 by 2019.

**On click of a site**, the relate does its job: that site's own
25-year series for the selected parameter, with the limit drawn as a
reference line.

Everything carries its n. A tile that says "0% over the radium limit"
also says "125 sites measured".

## 6. Statistics worth having beyond min / max / mean

Water quality data is strongly right-skewed and censored at detection
limits. The mean is close to meaningless and a scientist will notice
immediately if that is all we offer.

- **Median and IQR**, not mean. Standard practice in the field.
  Needs `percentile_cont` aggregates. **We do not have this.**
- **Exceedance rate** as a first-class aggregate: share of samples,
  or of sites, above a threshold. We can approximate it with two
  filtered counts; as one figure it would be a genuine primitive.
- **Count of distinct sites** versus count of samples. This is the
  difference between "1,480 acidic samples" (could be one creek
  measured monthly for a decade) and "392 acidic sites" (a map).
  **We cannot express `count(distinct)` at all today**, and on this
  dataset that gap is disqualifying.
- **Trend direction per site.** Mann-Kendall is the standard
  non-parametric trend test for exactly this kind of irregular
  series. Even a coarse improving / worsening / flat would carry
  real meaning. Well beyond current scope, but it is what the data is
  for.

## 7. Visuals we would want and do not have

Ranked by how much this dataset suffers without them.

1. **Histogram / distribution.** Our `groupBy` is categorical only,
   so we cannot bin a numeric field. For a scientific audience this
   is the single biggest gap: they want the shape, not the average.
   Needs numeric binning server-side, which the aggregate endpoint is
   well placed to do.
2. **`count(distinct)`.** See above. Small addition, large payoff.
3. **Threshold reference line on a chart.** Indicators have
   `reference` with `goodWhen`; charts have nothing. A limit line is
   how you read a water quality chart.
4. **Box plot by group.** The canonical way to compare a parameter
   across counties or years while showing spread. Follows naturally
   once percentiles exist.
5. **Scatter of two parameters.** Chloride against bromide is the
   textbook discriminator between oil-and-gas brine, road salt, and
   AMD. The dashboards spec already lists scatter as a follow-up.
6. **Graduated symbol size.** `point.radius` is a fixed number; the
   renderer can vary colour by class break but not size. Size-by-
   magnitude with colour-by-exceedance is the standard double
   encoding for this kind of map.
7. **Clustering or heatmap for dense points.** 4,951 sites at
   statewide zoom is a blob. WVU's own portal uses a kernel density
   raster for well hotspots, and they are right to.

Items 1, 2 and 3 are the ones I would build before attempting this
dashboard. Without them we would be dressing up a mean.

## 8. The map, which has to be good

Matt's constraint: not single-symbol points. Nor should it be, for
this data.

**Reference layers, live from WVU's own services.** They publish
`appservices.wvgis.wvu.edu/arcgis/rest/services/EPA/WaterQuality_MarcellusArea_WV/MapServer`,
which carries HUC8 watersheds, a Marcellus well heat map, NLCD land
cover, county boundaries, and the Marcellus deviated wells. Our
`service` item type consumes ArcGIS REST directly, so we can use these
as live context rather than importing copies. That is better
cartography, less duplication, and it credits them by construction.

Note `maxRecordCount: 2000` on that service, which is why their own
portal footer reads "Total number of records: 2000". Our copy of the
underlying data has no such cap, which is a fair thing to show.

**The site layer**, in order of what carries meaning:

- **Colour by exceedance status**, not by raw value. Three classes:
  within all limits, over a secondary (aesthetic) limit, over a
  primary (health) limit. Diverging ramp, colourblind-safe. This is
  the reader's actual question.
- **Size by sample count**, so a site with 200 readings is visibly
  more informative than one with a single grab sample. Needs the
  graduated-size gap above; until then, a class-break colour plus a
  fixed radius is the honest fallback.
- **Watersheds as the framing polygon**, subtle fill, labelled. Water
  quality is a watershed story and county lines are irrelevant to it.
- **Wells as a density surface underneath**, not 2,536 dots. The
  question is "where is development concentrated", which is a field,
  not points.
- **Muted terrain basemap.** The data is the figure; topography is
  ground, and in Appalachia topography genuinely explains drainage.

**Deliberately not**: a red-to-green ramp on raw concentration.
Different parameters have limits that differ by four orders of
magnitude, and a shared colour scale across them would be nonsense.

## 9. On sharing it with Prof. Sharma

Worth doing, and worth doing carefully. Two things make it a
reasonable approach rather than an imposition:

- We would be using their published services and crediting the
  project, not re-hosting their work as ours.
- The gaps we would be filling — exceedance framing, distributions,
  monitoring coverage over time, extent-driven statistics — are the
  things their own stated purpose asks for and their Web AppBuilder
  layout cannot easily do.

If we do reach out, the honest framing is: an open-source, self-hosted
portal built as an alternative to commercial GIS, using their dataset
as a real workload, with the analysis above and an invitation to tell
us where we got the science wrong. Not a pitch.

Do not send anything until the numbers in §3 have been reproduced
inside GratisGIS itself rather than by ogrinfo, because the first
thing a careful reader will do is check one.

## 10. Recommended order

1. `count(distinct)` on the aggregate endpoint. Nothing here is
   honest without it.
2. Numeric binning for histograms, and a reference line on charts.
3. Import: sites as the parent, monthly samples as the child, related
   on `Location`. Wells as a third layer.
4. Build the dashboard in §5, reproducing §3's numbers as the
   acceptance test.
5. Cartography pass with WVU's services as reference layers.
6. Only then, consider the outreach in §9.

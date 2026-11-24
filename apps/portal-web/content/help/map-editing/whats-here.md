---
id: map-editing-whats-here
title: What's Here
seoTitle: "What's Here: see what every layer has inside an area"
summary: "Pick an area on a map and see what every visible layer has inside it: counts, acres, lengths, totals and breakdowns. Export a spreadsheet or a PDF report."
category: map-editing
order: 45
complexity: basic
tags:
  - whats-here
  - screening
  - near-me
  - buffer
  - report
related:
  - widget-whats-here
  - map-editing-markup
  - widget-measure
  - items-map
---

**What's Here** answers one question: what is inside this area? Pick
an area, add a distance around it if you want one, and every visible
layer on the map reports what it has there. Polygon layers give the
acres inside the area, line layers give the length inside it, and
point layers give a count.

It covers what the Near Me and Screening widgets do in ArcGIS Web
AppBuilder, in one panel.

![What's Here panel with an address, a 1 mile distance and results for each layer](/help/map-editing/whats-here-results.png)

## Open it

Click **What's here** in the map toolbar. In an app, use the
[What's Here widget](/help/web-apps/widgets/whats-here). The panel
works the same in both.

## Pick an area

Choose one of four ways at the top of the panel:

- **Draw**. Pick a shape (polygon, box, circle or freehand) and draw
  it on the map. Once it is finished you can drag it or its corners.
  The results update as you go.
- **Point**. Tap the map. A point gets a starting distance of 500 ft
  (150 m in metric), since a point alone covers no ground.
- **Address**. Search for an address or place and pick it from the
  list. The map moves to it.
- **Pick shapes**. Tap shapes on the map, such as parcels, to add
  them. Tap one again to remove it. All the picked shapes count as
  one area, and overlaps count once.

You can also click **Upload a shape** and choose a file: GeoJSON,
KML, KMZ, a zipped shapefile or a GeoPackage. Every shape in the
file becomes part of the area. KMZ, shapefile and GeoPackage files
need you to be signed in.

## Add a distance

Under **Include everything within**, pick a distance to widen the
area by that much on every side: 100 ft, 500 ft, ¼ mi or 1 mi (25 m,
100 m, 500 m or 1 km in metric). **Other** takes any distance up to
100 km. **Only inside** uses the area exactly as drawn.

## Read the results

- **Area** at the top is the size of the area, distance included.
- Each layer card shows how many features touch the area. Polygon
  layers also show the acres inside the area and the share of the
  area they cover. Line layers show the length inside the area.
  Only the part inside counts: a 10 acre parcel half inside the
  area adds 5 acres.
- Layers with nothing in the area are listed on one line at the
  bottom, so the cards only show what is there.
- **Area in** and **Length in** set the units for the panel, the
  spreadsheet and the PDF. Your choice is remembered next time.
  Until you choose, units follow the metric or imperial setting in
  your profile.

## Break down by a field

Each layer card has **Break down by**. Pick a field, such as zoning
or land cover, to split that layer's results by its values, largest
first. Coded values show their labels. A breakdown shows up to 50
values.

## Add up number fields

Open **Add up number fields** on a layer card and tick the number
fields you want totals for, such as assessed value or housing units.
Each one shows as a total under the layer, and as a column in its
breakdown, the spreadsheet and the PDF. Up to 10 fields per layer.

Totals add the full value of every feature that touches the area,
including features only partly inside. A parcel half inside the area
adds its whole assessed value, while its acres count only the half
inside.

## Keep or share the results

- **Spreadsheet** downloads a CSV with every layer and breakdown.
- **PDF** makes a report: the area, the distance, a map picture, a
  summary table, the shapes you picked and each breakdown.
- **Link** copies an address that opens the same map with the same
  area, distance, breakdowns and totals. The area travels in the link, so it
  does not expire.
- The download icon next to **Area** saves the area itself as
  GeoJSON, to keep or to upload again later.
- The bookmark icon next to **Area** saves the area to the map's
  [markup](/help/map-editing/markup), with its size shown in the
  middle. You need to be signed in, on a saved map.
- The magnifier icon zooms the map to the area.
- **Start over** clears the area.

## Who sees what

Every number is worked out on the server with the reader's own
access. A layer shared with a geographic limit, or one where you see
only your own rows, reports only what you can see. Someone who opens
your link or your app sees results for their own access, not yours.
On a public app, signed-out visitors see public layers only.

## Limits

- What's Here checks visible data layers. Tables, which have no
  shapes, are skipped.
- An uploaded file can hold up to 2,000 shapes.
- A PDF covers up to 200 layers.
- A very detailed area may be too long for a link, or too detailed
  to save as markup. Download it instead.

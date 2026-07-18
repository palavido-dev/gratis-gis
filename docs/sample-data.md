# Sample data

A fresh portal can seed itself with a complete demonstration
workspace in one click. Admins and contributors landing on an empty
"My items" page get a welcome panel with three starting points;
"Load sample data" creates the Randolph County, West Virginia
workspace, the same content the public demo at gratisgis.org runs.

## What gets created

Sixteen items, organized under a "Sample: Randolph County" folder,
built from real, authoritative Randolph County data so the workspace
looks like a portal a county GIS office would actually run, not a
hand-drawn toy:

- Four reference layers with real features: County facilities (50
  points: schools, a college, libraries, fire and EMS, the hospital,
  and law enforcement, typed against a facility pick list), Trails (43
  Monongahela National Forest trail lines carrying USFS trail class and
  mileage), Parks and public lands (17 polygons: the Monongahela
  National Forest, Kumbrabow State Forest, wildlife management areas,
  Nature Conservancy preserves, and Elkins city parks), and Randolph
  County parcels (all 23,915 tax parcels, with owner, physical address,
  and acreage). Two pick lists back the coded-value fields.
- The authoritative WV 24K county boundary as a geo boundary.
- The "Randolph County explorer" map composing facilities, trails, and
  parks over the basemap, centered on Elkins, plus a dedicated
  "Randolph County parcels" map zoomed into Elkins with owner search.
- A derived layer ("Emergency services") filtering facilities to fire,
  EMS, and hospital, demonstrating the analysis pipeline.
- A "Road and trail issue report" form with four example submissions
  that mirror, with geometry, into the form's paired data layer.
- A field operations map and a "Trail conditions field survey"
  data collection deployment bound to the form, demonstrating the
  offline field app.
- A public facilities viewer app and a custom explorer app built
  from the sidebar-explorer starter.
- A "Find facilities near a location" tool built on the
  select-by-location recipe.

Access tiers are part of the demonstration: the facilities layer,
explorer map, and viewer app are public (so the viewer works for
anonymous visitors, dependencies included); the trails and parks
layers, the parcels layer, and the parcels map are organization-
visible; and the rest stay private. The parcels layer is org-tier on
purpose: a 24k-feature public layer on the OGC tiles endpoint is what
caused a prior crawler-driven incident, so public exposure waits on the
tiles cache and concurrency hardening.

## Data sources

The bundled datasets are real public data, not approximations:

- Facilities, county boundary, parks and public lands, and parcels:
  WV GIS Technical Center (wvgis.wvu.edu) and WV DNR, redistributed
  under the mapWV Terms of Use, which place this content in the public
  domain for reuse (per-dataset caveats checked for the layers used).
- Trails: USDA Forest Service, National Forest System Trails
  (Monongahela National Forest), a federal public-domain work.

Curation is limited to selection and cleanup: features are clipped to
the county boundary, deduplicated (the fire and EMS point sets overlap
heavily), and their names normalized. Geometry is never simplified, so
parcel edges stay crisp, with one exception: the county boundary is
generalized slightly for size. The parcel cadastre is ~38 MB of
GeoJSON, so it ships gzipped (~12 MB) and is gunzipped once at seed
time.

## Behavior

- The seeder is idempotent. Every sample item carries an internal
  seed marker; clicking the button again reports the existing items
  as skipped rather than duplicating them, including after a
  partially failed run.
- Sample items are ordinary items. Rename them, restyle them, share
  them, or delete them; a later re-seed only restores what is
  missing.
- The bundled datasets ship inside the portal image, so seeding
  works air-gapped with no external fetches. Feature inserts are
  chunked, so the 23,915-parcel layer loads without overrunning a
  single statement.
- The API surface is `POST /api/items/sample-data` (admin or
  contributor), returning the created and skipped item markers.

## Removing sample content

Move the "Sample: Randolph County" folder and its contents to the
recycle bin like any other items, or purge them from Recently
deleted. The welcome panel reappears only while the "My items"
scope is empty.

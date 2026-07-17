# Sample data

A fresh portal can seed itself with a complete demonstration
workspace in one click. Admins and contributors landing on an empty
"My items" page get a welcome panel with three starting points;
"Load sample data" creates the Randolph County, West Virginia
workspace, the same content the public demo at gratisgis.org runs.

## What gets created

Seventeen items, organized under a "Sample: Randolph County" folder,
chosen so every major capability appears playing a believable role:

- Three data layers with real features: County facilities (12 points
  with a pick-list-backed type field and searchable names), Trails
  (5 lines with difficulty domains), and Parks and public lands
  (5 polygons). Two pick lists back the coded-value fields.
- A simplified county geo boundary.
- The "Randolph County explorer" map composing the three layers with
  styling, centered on Elkins.
- A derived layer ("Emergency services") filtering facilities by
  attribute, demonstrating the analysis pipeline.
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
anonymous visitors, dependencies included), the trails and parks
layers are organization-visible, and the rest stay private.

## Behavior

- The seeder is idempotent. Every sample item carries an internal
  seed marker; clicking the button again reports the existing items
  as skipped rather than duplicating them, including after a
  partially failed run.
- Sample items are ordinary items. Rename them, restyle them, share
  them, or delete them; a later re-seed only restores what is
  missing.
- The bundled datasets ship inside the portal image, so seeding
  works air-gapped with no external fetches. Coordinates are
  representative approximations for demonstration, not survey data.
- The API surface is `POST /api/items/sample-data` (admin or
  contributor), returning the created and skipped item markers.

## Removing sample content

Move the "Sample: Randolph County" folder and its contents to the
recycle bin like any other items, or purge them from Recently
deleted. The welcome panel reappears only while the "My items"
scope is empty.

---
id: map-editing-markup
title: Markup and redlining
summary: Draw colored pins, lines, polygons, text, arrows, and circles on a shared map to flag issues or call out places for the team to discuss, then download a set as GeoJSON or promote it into a real data layer when you are ready.
category: map-editing
order: 40
complexity: basic
tags:
  - markup
  - collaboration
  - redline
related:
  - map-editing-comments
  - map-editing-presence
  - items-map
---
![Map builder Markup dialog with Add markup](/help/map-editing/markup-panel.png)

Markup is the fastest way to get team feedback on a map. Anyone who
can view the map can draw on it, group sketches into named markup
sets, and ship the link back to the team. No editor permission needed.

Signed-in viewers can always add their own markup. Map editors can
also turn on **Anonymous markup** in Map settings so signed-out
visitors on a public map can add and edit their own sets (off by
default, rate-limited). Guests cannot promote a set to a data
layer — that still needs a signed-in account.

The classic use case: a project manager opens a shared parcel map,
spots three parcels with wrong boundaries, sketches the correct
edges, and emails the map URL to the analyst who can fix the
underlying data. The analyst sees the manager's markup overlaid on
the map next to their own work and knows exactly which features to
look at.

## Opening the Markup panel

In the map editor toolbar, click the pencil icon. The Markup panel
slides in from the right.

## Adding markup

Click **Add markup**. A new markup set appears, named after you and
today's date, with an auto-assigned color so two reviewers' markups
don't clash. Each set is its own overlay of features.

Use the tools on a set, then click the map to draw:

- **Pin**: single click.
- **Line**: click vertices; double-click or press Enter to finish.
- **Polygon**: click vertices; double-click or Enter to close.
- **Text**: click to place, then type the label when prompted.
- **Arrow**: same as a line; the tip gets a chevron so direction
  is obvious.
- **Circle**: click the center, then drag to set the radius (stored
  as a polygon outline).

**Center** still drops a pin at the current map center when you just
need a quick marker without switching tools.

## Download as GeoJSON

Click **GeoJSON** on any markup set that has features. Your browser
downloads a FeatureCollection with every pin, line, polygon, text,
arrow, and circle in that set. Properties include kind, label, note,
color, and which markup set / author they came from. Opens directly
in QGIS, ArcGIS Pro, geojson.io, and similar tools. Anyone who can
see the set can download it — no edit permission required.

## Promote to a data layer

When a markup set is ready to become real GIS data, click
**Promote**. GratisGIS creates a private data layer you own, copies
every feature into it (splitting points, lines, and polygons into
separate sublayers when the set is mixed), and, if you can edit the
map, adds that layer to the map for you. The original markup stays
in place so the review trail is not lost.

## Multiple reviewers, distinct colors

When several people add markup to the same map, each person's set
gets its own color from a built-in palette. The colors are picked
so two adjacent ones never look the same, including for common
forms of color blindness.

You can rename your set (click the title), recolor it (click a
swatch), or hide it temporarily (eye icon). Hiding only affects
your own view; the set is still there for everyone else.

## Who can edit which markup

- The author of a markup set can edit or delete it at any time.
- A map editor (someone with edit permission on the map item) can
  edit or delete any markup set on that map. This is the cleanup
  path: an admin can remove abandoned markup from a long-running
  shared map without asking the author.
- Other viewers can see all markup sets but can only edit or
  delete their own.
- Anonymous guests (when the setting is on) edit only sets they
  created in the same browser; clearing site cookies loses that
  edit right, though the markup stays on the map.

## Tips

- Drawings persist on the map item. A new visitor sees every set
  that's been added so far.
- A markup set isn't a data layer until you promote it. Download
  GeoJSON when you just need the sketches offline; promote when you
  want styling, sharing, OGC access, or derived-layer pipelines on
  the result.
- Comments threaded against the map and against individual pins
  pair nicely with markup. See [Comments](map-editing-comments)
  for the conversation side.

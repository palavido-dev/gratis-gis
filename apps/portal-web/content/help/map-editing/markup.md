---
id: map-editing-markup
title: Markup and redlining
summary: Draw colored pins, lines, and polygons on a shared map to flag issues or call out places for the team to discuss, then promote a set into a real data layer when you are ready.
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

Markup is the fastest way to get team feedback on a map. Anyone who
can view the map can draw on it, group sketches into named markup
sets, and ship the link back to the team. No editor permission needed.

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

Use the pin, line, or polygon tools on a set, then click the map to
draw. Pins place with a single click. Lines and polygons take
vertices on each click; double-click or press Enter to finish.
**Center** still drops a pin at the current map center when you just
need a quick marker without switching tools.

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

## Tips

- Drawings persist on the map item. A new visitor sees every set
  that's been added so far.
- A markup set isn't a data layer until you promote it. Promote
  when you want styling, sharing, OGC access, or derived-layer
  pipelines on the result.
- Comments threaded against the map and against individual pins
  pair nicely with markup. See [Comments](map-editing-comments)
  for the conversation side.

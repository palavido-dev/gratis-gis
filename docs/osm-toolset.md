# OSM Toolset

GratisGIS treats OpenStreetMap as a first-class data source, not just
a tile background. Authors compose OSM queries into named tools they
share, embed in apps, and run from any custom web app the same way
they run an attribute filter against a hosted data layer. This
document is the durable map of where that toolset is going: which
tools we ship out of the box, the workflow they enable, and why
this particular set instead of an open-ended Overpass query box.

## Why a pack, not a query box

You can do almost any of these queries by hand-writing Overpass QL.
The pack exists because the use cases below repeat constantly, and
having them named, parameterized, and embeddable gives authors a
much faster path from "I have a question about a place" to "I have a
map that answers it." Five composable starter tools beat one
power-user query editor for the median user.

The pack is also where the project absorbs Overpass dialect upgrades
so the rest of the codebase doesn't need to. New Overpass operators
(`around:`, `nwr`, `is_in:`, set algebra) ship inside tools rather
than as parallel surfaces.

## The detective workflow that motivates this

A lot of OSM's underused power is in *composition*. The clearest
demonstration is the geolocation workflow popularized by
[Jose Monkey](https://josemonkey.com/) on YouTube: viewers submit
short videos and he pins the location. The technique is to extract
distinctive visible details (a watertower silhouette, a chain
restaurant brand, the angle of an intersection, a sign with a unique
name) and chain OSM queries to narrow candidates until one survives.
Each individual query is small; the power is in stacking them.

GratisGIS's tool surface is well-suited to this because every tool
is a first-class portal item: parameterizable, shareable, runnable
from a custom app, with results that land as real map layers. The
investigative workflow we want to enable is:

1. Run a relational query to narrow to a region.
2. Drop a pin and ask "what are the N closest features of type X?"
3. Search for a specific name in the area to verify.
4. Repeat with different constraints until the candidate set
   collapses.

Most of those steps map to one tool in the pack below.

## What ships today

These are running on the public preview (`demo.gratisgis.org`) today:

- **OSM Query** (`osm-query`): pick a preset (school, park,
  restaurant, etc.), draw an area, get every matching feature
  inside. Foundational; the existing `osm-features-overlay` recipe
  output. Issue #117, shipped.
- **OSM Relational Query** (`osm-relational-query`): find every
  feature of preset A inside an area such that AT LEAST ONE feature
  of preset B is within distance D_b AND at least one of preset C is
  within D_c. Single-Overpass-roundtrip via the `around:<set>:<d>`
  predicate. Issue #142, shipped.

## What ships next (v1 toolset)

In rough order of ship priority:

### OSM Name / Brand search

Given an AOI and a string, find features whose `name`, `operator`,
`brand`, or `ref` tag matches (exact / contains / fuzzy). The
killer use case is "the video shows a sign that says Roosevelt
Apartments -- what is that?" or "every Speedway in this county".

Implementation: extends the existing Overpass adapter with a name
filter clause (`["name"~"foo",i]`). Adds a runtime string parameter.
Small, mostly a UI lift.

### OSM Nearest N to a point

User drops a pin (runtime point parameter), picks a preset, gets
the N closest matching features. Useful both as exploration ("what's
near this address?") and as verification ("I think the video is
here; does the OSM nearby match what I see?").

Implementation: new point-input parameter kind. Overpass
`around:<distance>,<lat>,<lon>` plus N-nearest sort post-fetch
(Overpass doesn't natively limit to N closest).

### OSM Corridor along a line

User draws a line (or selects an existing road feature), buffers it
by X meters, finds features inside the buffer. "Every gas station
along I-95 from Boston to NYC" or "every farm stand along this
country road."

Implementation: extends the AOI parameter to accept LineStrings.
PostGIS ST_Buffer turns the line into a polygon AOI; the rest reuses
the existing query path.

### OSM Reverse geocode at point

Click anywhere, get a ranked list of what's there: the building,
the road, the named place, the admin boundaries. Useful for "where
am I?" exploration and for validating a guessed geolocation.

Implementation: Overpass `is_in:` and `around:0,lat,lon` patterns,
plus a ranking heuristic that prefers named features over unnamed
ones and smaller polygons over larger ones.

### OSM Relational v2: negation + bearing

Two extensions to `#142`:

- **Negation**: "school near park AND near liquor store AND NOT
  near a highway." Overpass supports this via the difference
  operator (`(.set1; - .set2;)`).
- **Bearing**: "watertower roughly NW of a railroad." The killer
  detective move: when two landmarks are visible in one shot, the
  angle between them dramatically narrows candidates. Bearing math
  runs server-side in PostGIS after Overpass returns candidates.

Implementation: extends the relational action schema (`negations[]`,
`bearings[]` arrays). Backend adds a post-Overpass PostGIS pass for
the bearing predicate.

## Deferred (track separately when a use case arrives)

These are real future tools but the v1 set above covers the dominant
workflows. We file them so they exist as cataloged ideas:

- **OSM Density / Coverage Gap**: grid the AOI, count features per
  cell, surface high/low areas. Service-gap analysis for planners.
- **OSM Unique-in-region finder**: features whose `name` appears
  nowhere else in OSM globally. Very specific to the detective case
  ("the video has a sign with this distinctive text").
- **OSM Tag distribution explorer**: for an AOI, enumerate the
  values existing on key X. Exploratory; useful when the author
  doesn't know which preset to pick.
- **OSM Intersection finder**: pairs of roads of types T1 and T2
  that cross. Detective angle for "I see two roads meet at this
  unusual angle in the shot."
- **OSM Along-route POIs**: feed a routing engine's output back in
  as the corridor input. Needs OSRM/Valhalla.
- **OSM Change tracker**: features modified since date X. Stretch
  goal, hits Overpass's `(newer:"YYYY-MM-DD")` filter.

## Composition is the actual win

The reason this is a *pack* rather than a single super-tool: each
tool produces results that another tool can consume. Run the
relational query to narrow to a region, then nearest-N to verify
candidate matches, then by-name to check for a specific sign.
GratisGIS's tool widget + custom app surface lets the author wire
these into an investigative web app where each step is one click
and the results overlay on the same map.

A "GratisGIS OSM Toolset" set of starter tools, seeded per org,
gives every new portal an immediately useful OSM workspace without
any author setup. Tracked under #TODO (parent issue link).

## Attribution and policy

Every OSM-derived output carries the ODbL attribution string
`© OpenStreetMap contributors` in the result chip and on every
feature popup. Self-hosters running their own Overpass endpoint via
the per-org `osmOverpassEndpoint` setting should still preserve the
attribution; the credit is on the data, not the server. See
`#103` for the per-org Overpass endpoint setting.

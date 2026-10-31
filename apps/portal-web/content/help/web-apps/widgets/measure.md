---
id: widget-measure
title: Measure
summary: Draw a line or polygon on a map to read geodesic distance or area. Ships as a Viewer, Editor, and map-builder tool, not a Custom Web App widget.
category: web-apps/widgets
order: 70
complexity: basic
tags:
  - measure
  - map
  - viewer
  - editor
related:
  - items-map
  - items-web-app
---

**Measure** is a map toolbar tool for temporary distance and area
sketches. It ships on:

- **Web map builder** (map item configure view)
- **Viewer** apps (when the author enables the Measure tool)
- **Feature Editor** apps (when the author enables Measure)

It is **not** a Custom Web App page widget. `CustomWidgetKind` has
no `measure` kind, and the Custom Web App builder does not offer a
Measure tile. Use a Viewer or the map builder when you need
measure on a published map experience.

## Modes

- **Distance**. Click to start a line; add vertices; finish the
  sketch. Readout shows geodesic length.
- **Area**. Click to draw a polygon; finish to close. Readout
  shows geodesic area and perimeter. When the map has an active
  elevation / DEM layer, the primary area number is **ground**
  (slope / surface) area; **horizontal** (planimetric / deed)
  area stays available as a secondary line.

There is no separate "coordinate lookup" mode and no MGRS / UTM
format picker on this tool.

## Units

Authors and viewers pick units on the tool itself:

- Distance: meters, feet, miles, kilometers, and related length
  units exposed in the control.
- Area: square meters, square feet, acres, hectares, and related
  area units.

Measurements are **geodesic** (on the ellipsoid / spheroid path
the map math uses). There is no planar / pixel-distance mode
toggle.

## Camera while measuring

If the map is pitched into 3D when Measure opens, the tool
**flattens pitch** immediately and locks max pitch at 0 for the
life of the tool so the sketch matches the scale bar and ground
/ deed acres. Closing Measure restores the previous pitch.

## Snapping

Measure sketches do **not** snap to feature vertices. Editor
snapping (when enabled) is a separate Feature Editor setting and
does not drive the Measure overlay.

## Notes

- **Measurements aren't saved.** They are ephemeral overlays;
  closing the tool clears them. For a permanent measured polygon,
  draw it as a feature in a data layer instead.
- **Not Experience Builder parity.** Do not expect a Custom Web
  App Measure widget, secondary dual-unit config panel, or
  coordinate / MGRS / UTM modes that some other builders advertise.
- **Elevation optional.** Ground (surface) area appears only when
  terrain elevation is available on the map; otherwise you get
  horizontal area alone.

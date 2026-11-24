---
id: widget-whats-here
title: What's Here widget
seoTitle: "What's Here widget: screen an area in a web app"
summary: "Adds What's Here to a custom web app, so visitors can pick an area and see what every layer has inside it."
category: web-apps/widgets
order: 75
complexity: basic
controls:
  - id: widget-whats-here-toggle
    label: "What's Here tile in the widget palette"
tags:
  - widget
  - whats-here
  - screening
  - near-me
related:
  - map-editing-whats-here
  - items-web-app
---

The **What's Here** widget puts the [What's Here](/help/map-editing/whats-here)
panel in a custom web app as a button. Clicking it opens the panel
over the map it is bound to, and everything in the
panel works the same as in the map viewer, apart from saving to
markup, which apps don't have.

![What's Here panel with results for each layer](/help/map-editing/whats-here-results.png)

## Add it

1. In the app builder, add the **What's Here** tile from the widget
   palette.
2. Pick the map widget it works with.
3. Set the options below, then save the app.

## Options

- **Show label next to the icon**. Shows "What's here" with the
  button's icon. Turn it off for an icon-only button.
- **Area unit** and **Length unit**. The units the panel starts with.
  **Viewer's metric or imperial setting** follows each visitor's
  profile. Visitors can still change units in the panel, and their
  own choice wins next time.

## Notes

- The panel checks the layers that are visible on the bound map.
- On a public app, signed-out visitors see results for public layers
  only. See [Who sees what](/help/map-editing/whats-here#who-sees-what).
- A What's Here link copied in the app opens the app on the same area.

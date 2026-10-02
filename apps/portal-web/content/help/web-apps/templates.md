---
id: web-apps-templates
title: Templates
summary: The four built-in web app templates and which is the right fit for each use case.
category: web-apps
order: 20
complexity: basic
tags:
  - web-app
  - templates
related:
  - items-web-app
  - web-apps-custom-app
---

A web app's **template** sets its runtime. Each template is a
separate runtime designed for one shape of app. Templates are
picked at creation and can't be switched on an existing item;
to change template, create a new web app item with the right
template and update share targets.

## Viewer

A read-only map with a curated widget set. The runtime is
minimal and fast to load. Pick when:

- You're publishing a map for a public audience to look at.
- You want a clean, no-edits, no-clutter view.
- You're embedding the map into another page via an iframe.

Default widgets: search, layer list, legend, basemap gallery,
print. Editing is hard-disabled at the runtime layer.

## Editor

Same as Viewer plus editing tools, scoped to whatever layers
the signed-in user has edit access on. Pick when:

- The audience is signed-in users (or org members) who maintain
 specific layers.
- You want a focused editor surface rather than the full map
 builder.
- You're rolling out a field-collection workflow that needs
 desktop fallback.

The editor template still respects per-layer access. A user
opens the same URL; what they can edit depends on their share
permissions, not the template.

## Survey response

A single form, no surrounding map. The runtime is essentially
the form designer's runtime preview, wrapped as a standalone
page. Pick when:

- You're publishing a form for public submission.
- The form is the entire purpose; no maps or extra widgets
 around it.
- You want a clean URL (often shared as a QR code or short
 link).

Submissions land in the form's bound item (data layer or form
submission collection), with the standard submission flow.

## Custom

The drag-and-drop builder (see **Custom Web App**). Pick when:

- The other three templates don't quite fit and you want to
 compose widgets.
- You need a specific dashboard-style layout that the Custom
 template's layouts cover but the Viewer / Editor don't.
- You want a widget layout in the neighborhood of a Web
 AppBuilder app. This is not an Experience Builder drop-in.

Most flexibility, slightly heavier runtime.

## Decision tree

- Public, read-only map → **Viewer**.
- Public form → **Survey response**.
- Signed-in editing surface → **Editor**.
- Anything else / multiple widgets composed visually →
 **Custom**.

## Notes

- **Sharing tiers apply regardless of template.** A Custom app
 set to Owner only isn't reachable to anyone but you, even
 though it could carry a public-friendly layout.
- **Templates are versioned with the portal.** Updates to a
 template runtime ship as portal updates. Existing apps adopt
 the new runtime on next load; you don't have to re-save them.

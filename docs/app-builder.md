# App builder (web_app items)

A web_app is a configurable page that presents items (web_maps,
feature_services, dashboards, forms) in a layout the builder chose. It
is the user-facing surface for sharing a curated view of portal content
without writing code.

## Target UX

Three-pane layout:

- **Canvas**: the app as the end user will see it.
- **Palette**: drag-droppable widgets (map, layer list, chart, legend,
  header, markdown, link, image).
- **Inspector**: props of the selected widget.

Editor state is a normalized tree (root → widgets → config) stored in
the item's `dataJson`. Save is explicit; the canvas always renders the
current edit state, not the last-saved state.

## Data shape (proposed, subject to iteration)

```ts
{
  version: 1,
  theme: 'default',
  layout: 'single-column' | 'sidebar-left' | 'sidebar-right' | 'grid',
  root: {
    type: 'container',
    children: Widget[],
  },
}

type Widget =
  | { id, type: 'map', itemId }
  | { id, type: 'markdown', text }
  | { id, type: 'chart', itemId, columns }
  | { id, type: 'image', url }
  | { id, type: 'layer-list', mapWidgetId }
  // ...
```

## Shared widgets

Widgets are React components. Many of them will also be reusable
*inside* dashboards and report templates, so they should live in a
shared package, `packages/widgets`, consumed by portal-web, the
field-app, and the reporting renderer.

## Rendering modes

- **Edit**: the builder UI, with drag handles and inspector.
- **View**: the published app, rendered for sharing, no editing chrome.
- **Embed**: a stripped viewer meant to be iframed into third-party
  pages. Locks navigation to the app itself.

## Not yet decided

- Scripting escape hatch. Plain JSON config covers 80% of cases but
  some users will want to compute values. Candidates: a sandboxed JS
  expression language, or a visual rules engine (fits with the
  tool-builder pillar).
- Multi-page apps. Single-page is the v1; multi-page needs navigation,
  per-page permissions, and a different URL scheme.

## Status

Not implemented. See `apps/portal-web/src/app/items/[id]/coming-soon.tsx`
for the current placeholder that renders on web_app detail pages.

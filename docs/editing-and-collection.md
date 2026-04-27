# Editing and Data Collection

This document captures the design for how users edit existing data and
capture new data through the GratisGIS portal. The shape is set
deliberately to avoid the "editing is everywhere and nowhere" sprawl
that makes the Esri stack confusing (Map Viewer editing tools, Field
Maps, Survey123, Workforce, ArcGIS Pro, all overlapping with subtly
different rules and UIs).

The core thesis: **every workflow has a home, and items reference each
other rather than embed each other.** Map authoring is one thing.
Editing existing data through a web app is another thing. Capturing new
data with a form (in the field or on the web) is a third thing. Each
gets its own item type, its own configuration surface, its own URL,
its own share, and its own runtime client. They can all reference the
same underlying `data_layer` items, but the policy that governs
"in this app, what can you do" lives on the app item, not on the layer.

## Goals

- One concise item type per workflow. No overlap, no "you can also
  edit data over here" surprises.
- Editing capability is layered, never escalating. The data_layer
  declares editability in principle. The app item narrows that. The
  share narrows it further. Their intersection is what the user gets.
- Offline-first for field data collection. Biological surveys,
  remote-area inspections, and similar workflows are the primary
  audience for Data Collection and they live without connectivity.
- Schema evolution that does not orphan data or break in-flight
  field captures. This is the single biggest pain point with
  Survey123 and we design around it deliberately.
- Open standards for desktop integration. QGIS-first, standards-based,
  with a first-class plugin. ArcGIS Pro reachable via OGC API
  Features without us writing Esri-specific code.

## Non-goals (v1)

- **Asset management.** We are not building Cityworks, Cartegraph, or
  Lucity. Native assignment / dispatch / work-order workflows are
  reserved for Phase 2 with a deliberately minimal scope (see below).
- **Editor offline mode.** Online-only in v1. Web editing of existing
  records typically happens at a desk; the offline pressure is on
  Data Collection, not Editor.
- **ArcGIS Pro portal-mode.** Pro users get OGC API Features in v1.
  Full Esri portal-mode (faking `/sharing/rest`, OAuth in Pro's
  expected shape, FeatureServer with applyEdits) is Phase 3 and
  demand-driven.
- **Cross-data_layer parent / child relationships.** A Data
  Collection that needs parent + child rows must target a single
  data_layer item with multiple internal layers. Cross-item
  relationships are a Phase 2 schema addition.

## Three item types in scope

| Item type | Purpose | What it does NOT do |
| --- | --- | --- |
| `map` (existing, unchanged) | Read-only composition: layers, basemap, viewport, symbology. | No editing UI of any kind. The map is the looking surface. |
| `editor` (new) | Online, tool-driven workspace for adding, editing, deleting features in one or more data_layers. Feature templates, drawing tools, attribute panel from layer schema. | Not form-driven. Not offline. Not for "capture 40 inspections this week" workflows. |
| `data_collection` (new, wraps existing `form` + `form_submission_collection`) | Form-driven capture, online or offline, of new features (and optionally edits to your own previous submissions). Map-centric or form-centric. | Not for free-form GIS analyst work on existing layers. Not for bulk attribute fixes. |

The mental test for "which item type do I make?" is:

- Free-form drawing on a desktop, with templates and snap tools,
  against existing data? **Editor.**
- Field crew capturing structured records, possibly without service?
  **Data Collection.**
- Both? Two items pointing at the same layer, each shared to the
  right audience.

## Authorization layering

Editing capability is conjunctive. A user can only do something if
all of the following allow it:

1. **`data_layer.editing.policy`** is the gate. Already shipped.
   Values: `none`, `all-rows`, `own-rows-only`. If a layer is
   `none`, no Editor or Data Collection can ever expose an edit
   tool against it. This is the layer owner saying "this is editable
   in principle".
2. **The Editor or Data Collection item config** narrows from there.
   It can drop fields from editability, lock geometry, restrict row
   scope further, disable delete, etc. It can never expand beyond
   what the data_layer allows.
3. **The share grant** on the Editor / Data Collection item narrows
   per recipient. `rowScope` on a share works the same as it does for
   raw data_layer shares: the share's scope is a ceiling within the
   item's ceiling within the layer's ceiling.
4. **Geo limits** on shares clip rows to a polygon, same as today.

This is the same conjunctive pattern we already use for sharing.
Nothing new to learn.

## The Editor item

An online, tool-driven workspace that exposes one or more data_layers
to a configured audience for create / edit / delete operations.

### Item shape (proposed)

```jsonc
{
  // Standard item fields: id, orgId, ownerId, title, description,
  // access, thumbnailUrl, etc. (see data-model.md)
  "type": "editor",
  "data": {
    "version": 1,
    "mapId": "uuid",        // optional: editor renders inside this map's viewport
    "targets": [
      {
        "dataLayerId": "uuid",
        "layerKey": "string",     // for v3 multi-layer data_layers
        "canCreate": true,
        "canEditGeometry": true,
        "canEditAttributes": true,
        "canDelete": false,
        "editableFields": ["name", "status", "notes"],   // null = all
        "rowScope": "all" | "own" | { "filter": "<safe-expr>" },
        "templates": [
          {
            "id": "residential",
            "label": "Residential Building",
            "geometryTool": "polygon",
            "presetAttributes": { "type": "residential", "stories": 1 }
          }
        ]
      }
    ],
    "tools": ["select","add","edit","delete","snap","measure"],
    "snapping": { "enabled": true, "selfSnap": true, "tolerancePx": 10 }
  }
}
```

### Runtime

The Editor's runtime is a desktop-shaped editing canvas. Layout:

- A map canvas (basemap + the configured target layers, optionally
  inheriting a referenced map's symbology and viewport).
- A tool palette: select, add, edit vertex, delete, snap toggle,
  measure, undo / redo.
- A feature template tray (if templates are configured): click a
  template, draw, attribute panel auto-populates the preset
  attributes.
- An attribute panel that pops on create or click. Fields are
  generated from the layer schema, with non-editable fields shown
  read-only.

Online-only in v1. URL: `/editor/<id>`.

### Why feature templates

Templates are a real productivity feature in classic ArcGIS Pro
editing. "Click the Residential Building template, draw a polygon, the
type and default stories are pre-filled." We mirror this pattern as
optional config on each target. Without templates, users still get a
plain "Add" button that creates a feature with empty / default
attributes.

## The Data Collection item

A form-driven, offline-capable deployment that targets one or more
layers (or a non-spatial submission collection) and captures new
records (and optionally edits to the submitter's own previous
records).

### Wraps existing item types

Today we have:

- `form` (item type): the reusable form schema.
- `form_submission_collection` (item type): a queryable view of
  submissions, useful for non-spatial surveys.

A Data Collection sits **on top of** these. Its purpose is the
*deployment*: who can submit, how the form is presented, how offline
behaves, where submissions land. The form schema is referenced by id
and stays reusable across multiple Data Collection deployments. A
form_submission_collection remains useful as a non-feature-layer
target for surveys that produce flat submission tables (e.g., an
anonymous public feedback form with no geometry).

### Item shape (proposed)

```jsonc
{
  "type": "data_collection",
  "data": {
    "version": 1,
    "mode": "map" | "form",
    "mapId": "uuid",            // required when mode = "map"
    "targets": [
      {
        "kind": "feature_layer",
        "dataLayerId": "uuid",
        "layerKey": "string",
        "formId": "uuid",
        "geometryMode": "capture-gps" | "draw-on-map" | "pick-existing" | "any",
        "rowScope": "all" | "own"
      },
      {
        "kind": "submission_collection",
        "collectionId": "uuid",
        "formId": "uuid"
      }
    ],
    "ownEditWindow": "P30D",     // ISO 8601 duration, optional; null = no own-edit
    "offline": {
      "enabled": true,
      "workAreaPolygon": "<geometry>",   // optional bounding clip for offline pull
      "tilePackage": "auto" | { "minZoom": 10, "maxZoom": 18 }
    },
    "assignmentMode": "none"     // reserved; v1 always "none". Phase 2: "feature" | "spatial".
  }
}
```

### Two modes, one item type

- **Map mode (Field Maps style):** the runtime renders a map. Editable
  layers show in the legend. Tap-to-add picks a layer and opens the
  form for that layer. Used for "walk the map and drop points / lines
  / polygons against various layers" workflows.
- **Form mode (Survey123 style):** the runtime renders a primary
  form. The form schema can have multi-section / repeating-section
  structure that fans out across multiple targets at submit time
  (parent feature in layer A, child rows in layer B / table C, all
  within one data_layer item).

The mode picks the runtime presentation. Both modes share the same
underlying `targets` list and the same offline plumbing.

### Runtime: PWA-first

The Data Collection client is a PWA. Same web origin as the portal.
Installable on phones via "Add to Home Screen". Same auth as the web
portal. URL: `/collect/<id>`.

When opened online, the client downloads:

- The form schema (latest published version).
- The list of editable target layers and their schemas.
- A snapshot of features in scope (if `rowScope` is `own` or there's
  an active `workAreaPolygon` clip).
- A vector tile package for the basemap inside the work area.

When opened offline, the client serves all of the above from
IndexedDB. Submissions go into a local queue with a client-generated
UUID per record, plus the form version they were captured against.

### Sync

When the client reaches the network, the queue drains. For each
queued submission:

1. Authenticate with the stored token (refreshing if expired and
   refresh succeeds).
2. POST the submission against the appropriate Data Collection
   endpoint, including the captured form version.
3. Server resolves the submission against the current data_layer
   schema. Additive form changes since capture default unknown
   fields to null. Structural changes prompt a client-side review
   before submission.
4. Attachments (photos, audio, etc.) upload separately so a 50 MB
   photo does not block the parent feature row from syncing.
5. On success, the queue item is cleared.
6. On failure (network blip, auth refresh expired), the item stays
   in the queue and an "Outbox" surface shows it to the user.
   Nothing is silently lost.

### Conflict policy v1

Last-write-wins for attribute edits, additive for new features. New
features almost never conflict (each capture has a client-generated
UUID). Edits to existing rows in `own` scope are forgiving because
typically only one user edits their own submissions. Multi-user
real-time conflict resolution is Phase 2.

### Editing your own submissions

A Data Collection optionally allows a submitter to edit a feature
they previously captured. Gated by `rowScope: "own"` plus an
`ownEditWindow` (ISO 8601 duration). After the window expires,
edits are no longer allowed and the user has to ask an Editor item's
audience for the fix. This keeps the conflict story bounded.

If you actually need open editing of arbitrary records, that is what
the Editor item is for.

## Layer creation paths

When configuring a Data Collection (or an Editor), targets can come
from existing data_layers or from layers that the form will create.
Both paths are first-class.

### Path A: existing layer

User picks an existing data_layer from the portal. Form fields are
mapped to existing columns. New columns can optionally be added to
the layer if the form has fields the layer does not, but the existing
schema is the source of truth and any add is a normal additive
schema mutation (see Schema evolution below).

### Path B: form-defines-layer

User designs the form first. At the point the Data Collection is
**deployed** (state transition from `draft` to `deployed`), the
system materializes a new `data_layer` item whose schema is generated
from the form schema. Mapping rules:

| Form field type | Generated column |
| --- | --- |
| text | `varchar` (default 4000) |
| longtext | `text` |
| number (int) | `integer` |
| number (float) | `double precision` |
| date | `date` |
| datetime | `timestamptz` |
| boolean | `boolean` |
| choice | `varchar`, optional FK to a `pick_list` item |
| multi-choice | `text[]` or `jsonb` (configurable) |
| photo / attachment | child attachments table per layer |
| geometry | `geometry(<type>, 4326)` matching the form's geometry binding |
| repeating section | child layer (related table) within the same data_layer |

The user gets a review screen before publish: "This form will create
a data_layer named X with these columns. Want to rename or adjust
before publishing?" That is the equivalent step Survey123 hides from
users; we surface it deliberately.

### Draft / deployed states

Data Collections have two states. While `draft`, the form can be
edited freely; in Path B no data_layer exists yet; no submissions are
accepted. On `deploy`, Path B materializes the data_layer and the
collection becomes submittable. After deploy, schema changes follow
the rules in the next section.

## Schema evolution and form versioning

The single biggest frustration with Survey123 is that any meaningful
form change forces creation of a new hosted feature layer. Existing
data is orphaned. Unsubmitted captures fail to sync. We design
around this explicitly.

### Principle

The data_layer is durable. The form schema is a versioned overlay.
Data always lands in the same data_layer. The data_layer schema only
ever evolves in ways that preserve existing data. The form can
publish v1, v2, v3 indefinitely. Each submission records its
`formVersionId`.

### Schema change taxonomy

| Class | Examples | Behavior |
| --- | --- | --- |
| Always safe | Add an optional column, widen `varchar`, lower numeric precision, drop `required`, add a pick list value, reorder fields, change display labels, add a related child layer | Auto-applied as in-place ALTER. New form version published. All older form versions remain valid for submission. |
| Constrained | Tighten a constraint where existing data may violate it (e.g., reduce max length on a column whose longest value exceeds the new limit), make an optional field required | Pre-check surfaces conflicting rows. User chooses: cancel, force, or fix data first. |
| Breaking | Rename column, change column type, remove column, change geometry type | User must choose: (a) migrate in place with a transformation (rename + remap, type cast where safe), (b) fork to a new data_layer (Survey123 default, but as opt-in not a forced path), (c) cancel. |

### Offline queue is schema-version-aware

Each queued submission carries its `formVersionId`. On sync, the
server accepts the submission against that form version, then maps
fields into the current data_layer schema:

- Additive changes since capture: unknown new fields default to null.
  Submission goes through silently.
- Structural changes since capture: queue item is surfaced to the
  client first with a "review and submit" dialog. Automatic mapping
  is applied where unambiguous (rename remap), surfaced for review
  where not.

The contract: as long as the data_layer schema is forward-compatible
with a captured form version, that capture remains submittable
indefinitely. Authors who only ever do additive changes never invalidate
in-flight queues.

### Server-side mutation API

The data_layer schema mutation API is structured, not raw SQL. Each
operation is a typed verb (`addColumn`, `widenColumn`, `addPickListValue`,
`renameColumn`, `removeColumn`, `changeColumnType`) with a known
compatibility class. The UI exposes only the operations whose class
the user is authorized for, and pre-checks feasibility before
applying.

### Form-to-column mapping

Each form field declares its target column name (and target layer if
multi-layer) explicitly. Form-side label changes do not trigger
column renames. Column-side renames have a clear path to update the
mapping in all form versions.

## Offline architecture (Data Collection only, v1)

Detailed because this is in-scope for v1 and because retrofitting
offline onto an online-first client is brutal.

### Storage

- IndexedDB for: form schema, target layer schemas, feature snapshots
  in scope, queued submissions, attachment metadata.
- Cache Storage (service worker) for: vector tile package, app shell,
  static assets.
- File-system access (where supported) or IndexedDB blobs for
  attachment payloads.

### Work area

A Data Collection optionally configures a `workAreaPolygon`. When
the client goes offline-prep, it pulls features whose geometry
intersects the polygon. A "Download for offline" action prompts the
user to confirm size before pulling. Without a polygon, the client
pulls features whose `rowScope` is `own` (typically a small set).

### Tile package

For map-mode collection, the basemap has to work offline. The client
pre-caches MVT tiles for the configured zoom range covering the work
area polygon. Default zoom range is 10-18 unless configured. Tile
package size is shown to the user before download.

### Auth refresh during long offline sessions

Tokens stored via NextAuth refresh-rotation against Keycloak (already
shipped, see #57). Plus a longer-lived offline-grant refresh token
that survives the typical 8-12 hour field session. If both expire,
the user re-authenticates on next online session and the queue drains
afterward.

### Attachments

Photos and other binary captures queue separately from feature rows.
Sync flow per attachment: upload to MinIO via a presigned URL, get
back the object key, attach to the parent feature record. Big photos
do not block parent submissions; the parent goes through with an
attachment placeholder, and the placeholder resolves when the
attachment finishes uploading.

## Desktop GIS integration

Open standards first, QGIS plugin for the activation-cost win.
ArcGIS Pro reachable via OGC API Features. Full Esri portal-mode
deferred to Phase 3.

### Protocol surface (per Editor item)

Each Editor item exposes its targets via two protocol endpoints:

- `WFS-T 2.0` at `/api/editor/<id>/wfs`. Old, XML, but every desktop
  GIS supports both read and write. Primary path for v1.
- `OGC API Features` (Part 1 read + Part 4 write) at
  `/api/editor/<id>/features`. Modern REST/JSON. Part 4 (transactions)
  is in spec finalization; client support is uneven, so it ships
  alongside WFS-T rather than replacing it.

Authentication: OAuth2 against the portal's Keycloak. QGIS's
Authentication Manager handles the token lifecycle. Bearer token
for OGC API Features; Basic-or-Bearer for WFS-T.

ACL: the same conjunctive layering as the web Editor. The endpoint
service is a thin protocol translation over the same internal
"edit a feature" service the web runtime uses.

### QGIS Portal Plugin (`apps/qgis-plugin/`)

A first-class plugin that mirrors the AGO-style portal-browser UX
inside QGIS. The activation cost of "paste this URL into Add WFS
Layer" is real and limits adoption to power users.

Scope v1:

- Sign-in: user enters portal URL. Plugin runs OAuth2 PKCE against
  the portal's Keycloak via a localhost loopback redirect. User
  logs in via the familiar Keycloak SSO page in their browser, gets
  redirected back to QGIS, token lands in the Authentication Manager.
- Browse panel: tabs for **Items**, **Groups**, **Folders**,
  **Search**. Same scope rules as the web portal (their shares,
  groups, org-visible items). Search and filter by item type.
- Right-click on an item -> "Add to map". Plugin picks the right
  protocol per item type:
    - `data_layer` -> WFS-T or OGC API Features via the corresponding
      Editor endpoint if one exists, else read-only.
    - `map` -> the map's full layer composition as a QGIS group,
      each composed layer becoming a child layer.
    - `arcgis_service`, `wms_service`, `wfs_service` -> QGIS native
      protocol pointed at the portal proxy.
    - `basemap` -> basemap layer.
    - `geo_boundary`, `pick_list` -> auxiliary read-only sources.
- Visual indicators per item: edit-capable badge if an Editor item
  grants the user edit access; collection badge if a Data Collection
  exists; "shared with me" indicator. Pro's catalog does not
  telegraph editability cleanly; we can.
- Item details panel with title / description / owner / last
  updated / share summary / "Open in browser" link.

Distribution: the official QGIS Plugin Repository. Self-hostable
plugin metadata XML for air-gapped deployments. Versioned in lockstep
with the portal API contract via the monorepo.

### ArcGIS Pro

Pro users in v1 connect via Pro's native "Add Data > OGC Web Service"
path against the OGC API Features endpoint. They paste the URL,
configure the auth (Bearer token), and they are in. No portal
browser, no portal sign-in. Documented in the user guide.

A Pro Add-In with full portal-mode (faking `/sharing/rest`, OAuth in
Pro's expected shape, FeatureServer with applyEdits) is feasible
and is Phase 3, demand-driven.

## What stays unchanged

- **Map items.** No editing UI, no change. The map is the read
  surface.
- **data_layer detail page raw table edit.** Stays as an
  owner / org-admin escape hatch, gated behind an explicit "Edit
  table directly" toggle, with a banner that this bypasses any
  Editor app rules. It is the path for "fix the data when something
  is wrong and you do not want to spin up an Editor item".
- **Existing form / form_submission_collection item types.** Stay
  as the schema and submission-store primitives. Data Collection
  references them.

## Phase split

### Phase 1 (v1, alongside Editor and Data Collection ship)

- `editor` item type, full create / edit / delete, feature templates,
  online-only.
- `data_collection` item type, both modes, offline-capable, schema-
  versioned form publishing.
- Data Collection layer creation: Path A (existing layer) and
  Path B (form-defines-layer with explicit deploy step).
- Schema evolution policy with the safe / constrained / breaking
  taxonomy and the structured mutation API.
- Authorization layering across data_layer + item config + share +
  geo-limit.
- Desktop integration protocols: WFS-T 2.0 and OGC API Features
  Part 4, exposed per Editor item, ACL via Keycloak token.
- QGIS Portal Plugin v1.
- Attachment model on data_layers if not already present.

### Phase 2

- **Assignments.** Minimal scope only: `(featureId, assigneeId,
  status, dueAt, notes)`, supervisor view (filterable table over
  assignments), assignee view (their open work). Status:
  `open / in-progress / done / blocked`. No routing, time tracking,
  billing, SLAs. Optional `assignmentMode: "feature" | "spatial"` on
  Data Collection items.
- **Editor offline mode.** Conflict resolution story for editing
  existing rows. Probably last-write-wins with a "review conflicts"
  UI for the residual case.
- **Cross-data_layer parent / child relationships.** Formal
  relationship modeling so a parent feature in layer A can have
  child rows in layer B in a different data_layer item.
- **Form schema migration tooling.** Authoring UX for rename / retype
  with explicit migration scripts. Today the breaking-change path
  forces a fork; Phase 2 lets authors migrate in place with
  confidence.
- **Webhook on submission.** Vendor-system integration path. For
  customers who run Cityworks / Cartegraph / Lucity, the OGC API
  Features endpoint plus a webhook on Data Collection submission is
  the bridge.

### Phase 3 (demand-driven)

- ArcGIS Pro full portal-mode (`/sharing/rest`, FeatureServer with
  applyEdits, Esri OAuth shape).
- Real-time collaborative editing (CRDT-based).
- Native mobile apps (MapLibre Native + React Native), if PWA-only
  proves insufficient.

## Implementation slicing (proposed)

Phase 1 is large; here is a reasonable slicing for delivery.

1. **Editor item type, scaffolding.** New `editor` enum on item type,
   create wizard, detail page placeholder, share UI, item card icon,
   basic targets editor. No runtime yet.
2. **Editor runtime, online-only.** Map canvas, target layers,
   attribute panel, add / edit / delete tools, snap toggle. Wire
   into the existing data_layer write APIs. Honor authorization
   layering. No templates.
3. **Editor feature templates.** Add template config + template tray
   in the runtime + preset attribute fill on create.
4. **Data Collection item type, scaffolding.** New `data_collection`
   enum, create wizard with mode selector, draft state, targets
   editor for Path A. No runtime yet.
5. **Data Collection runtime, online + Path A.** Form-mode and
   map-mode runtimes. Wire to existing form schemas. Hit the same
   write APIs the Editor uses. Online-only first slice.
6. **Form versioning.** `form_version` records, submission carries
   `formVersionId`, structured schema mutation API on data_layer.
7. **Path B (form-defines-layer).** Deploy step that materializes
   a data_layer from the form schema. Review screen before publish.
8. **Offline mode.** Service worker, IndexedDB stores, work-area
   pull, tile package, submission queue, attachment queue, sync
   logic. This is the biggest single slice.
9. **WFS-T endpoint per Editor item.**
10. **OGC API Features Part 4 write extension on the existing read
    endpoint, scoped per Editor item.**
11. **QGIS Portal Plugin v1.** OAuth PKCE sign-in, Items / Groups /
    Folders browsers, add-to-map for all item types, edit indicator
    badges.
12. **Polish, docs, plugin-repository submission.**

Each slice should land as its own PR / commit cluster on `main` per
project convention.

## Glossary additions

- **editor**: an item type. Online tool-driven workspace for
  creating, editing, and deleting features against one or more
  data_layers. Replaces the editing-in-the-map-viewer pattern.
- **data_collection**: an item type. Form-driven, offline-capable
  deployment that wraps form + form_submission_collection. Captures
  new features (and optionally edits to own previous submissions),
  in map mode (Field Maps style) or form mode (Survey123 style),
  against one or more layers.
- **feature template** (Editor): a preset of attribute values plus a
  drawing tool, to speed up repeated feature creation.
- **work area** (Data Collection): an optional polygon that scopes
  what features get pulled for offline use.
- **form version**: an immutable revision of a form schema.
  Submissions record which version captured them. Offline queues are
  schema-version-aware so additive form changes never break in-flight
  captures.

## Cross-references

- `data-model.md`: item type enum, layer schema model.
- `auth-model.md`: Keycloak, JWT, AuthUser shape.
- `sharing-granularity.md`: per-principal sharing, row + field
  policies, geo-limit clipping.
- `feature-services.md`: data_layer storage, ingest, PostGIS path.
- `field-app.md`: superseded by this document for the field /
  collection portion.
- `app-builder.md`: separate concern; covers `web_app` items
  (curated dashboards / pages), not editing or capture.

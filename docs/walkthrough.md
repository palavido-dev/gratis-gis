# Quick start

A short orientation for new users: how sharing works, how to
create items, what items currently exist, and how they relate to
one another. Aimed at someone coming from ArcGIS Online who
wants to get oriented in 15 minutes without reading the deeper
design docs first.

If the dev environment isn't running yet, see [SETUP.md](./SETUP.md).


## Sign in

Open <http://localhost:3000>. Three seeded accounts on a fresh
install (passwords match the username, dev-only):

- **`admin` / `admin`**: admin in org Acme, sees every item
  in the org and can manage users, branding, housekeeping
- **`contributor` / `contributor`**: contributor in org Acme,
  can create items and only sees items shared with them
- **`viewer` / `viewer`**: viewer in org Acme, read-only

Sign in as `admin` first to see the full surface, then re-test
as `contributor` or `viewer` to feel the sharing model.


## Vocabulary (AGO ↔ GratisGIS)

The terms are different but the mental model maps cleanly:

| Coming from ArcGIS Online | In GratisGIS |
| --- | --- |
| Organization | Organization |
| Publisher | Contributor |
| Administrator | Admin |
| My Content | Items page |
| Group | Group |
| Folder (in My Content) | Folder (a first-class item) |
| Hosted Feature Layer | Data layer (`data_layer` item). The ArcGIS Online importer can copy a hosted feature service into one. A WebMap JSON import alone leaves the FeatureServer URL as a live reference. |
| Web Map | Map (`map` item) |
| ArcGIS REST / WMS / WFS / WMTS | Connected service (`service` item). Older rows may still be `arcgis_service`, `wms_service`, or `wfs_service`. |
| Tile / vector tile service | Basemap (`basemap`) or tile layer (`tile_layer`, a PMTiles / MBTiles / XYZ upload) |
| Domain (coded value list) | Pick list (`pick_list` item) |
| Boundary used as filter or extent | Boundary (`geo_boundary` item) |
| Field Maps | Field PWA and data collection (`data_collection`). Offline install, capture, and sync. Not a Field Maps drop-in. |
| Survey123 | Form (`form`). Submissions land in a paired data layer. Not a Survey123 drop-in. |
| Experience Builder | Web app (`web_app`). Widget layout builder, including editor and viewer starters. Not an Experience Builder drop-in. |
| Dashboard | Web app started from the KPI Dashboard or Operations Board template. There is no dashboard item type to create. |
| Print layout | Print template (`print_template`), used by the Print tool in a web app. This is not a document report. |


## Sharing and permissions

Every item has a **visibility tier** plus optional **explicit
shares**. The two stack: visibility sets the floor, explicit
shares add specific people on top.

**Three visibility tiers**:

- **Private** — only the owner and org admins can see it
- **Organization** — every member of Acme
- **Public** — anyone, including signed-out visitors

**Explicit shares** grant access to specific users or groups.
Each share carries a permission, an optional expiry, and (for
data layers) an optional geographic clip.

| Permission | What the recipient can do |
| --- | --- |
| `view` | Read the item, query its features |
| `edit` | View + write features (data layers) |
| `admin` | View + edit + reshare + change settings |

**Roles** layer on top:

- **Admin** sees every item in their own org regardless of
  shares (admin override)
- **Contributor** can create items and share their own; can't
  see other people's private items unless explicitly shared

**Per-layer access matrix (maps only)**: on a map item, the
**Layer access** button lets you narrow what each sharee sees
per layer (View, Query, Edit toggles per layer per principal).
This is finer-grained than AGO's model.

**Editor dependency-access prompt**: when you share an editor
item with someone who can't see one of its underlying items
(the referenced map, target data layers, basemaps, etc.), a
dialog forces a binary choice: either cancel the share or grant
view on every missing dependency in one click. No way to ship a
broken share.


## Creating an item

Click **+ Create** on the items page. The picker groups item
types into five categories:

- **Data**: data layer, connected service, live PostgreSQL /
  PostGIS, file, basemap, boundary, geocoding service, pick
  list, tile layer, point cloud
- **Maps**: map
- **Apps**: form, data collection, web app, theme, print
  template, tool
- **Analysis**: derived layer, and script when the portal has
  scripts switched on
- **Organize**: folder

The picker does not offer a dashboard item or a report
template. A dashboard is a web app: on the template gallery,
pick KPI Dashboard or Operations Board. Document report
templates are not built.

Pick a type, then a wizard collects the minimum required
input, then you land on the item's detail page where
everything else is edited. Saves are autosaved on most
surfaces; the detail page header shows a dirty / saved
indicator.


## Items currently available

Implemented and usable today:

| Item type | What it is | Created from |
| --- | --- | --- |
| **`data_layer`** | A native PostGIS-backed dataset. One item can hold multiple sublayers (parcels and parcel lines as one schema). | Create → Data layer. Upload GeoJSON, shapefile, GeoPackage, and other OGR formats. |
| **`map`** | A web map composed of layer references, a basemap, and a viewport. | Create → Map. Add layer picks from data layers, connected services, and URLs. |
| **`service`** | Live pointer at an external service. The wizard recognizes ArcGIS REST, WMS, WFS, and WMTS. Credentialed services are proxied server-side. | Create → Connected service. Paste a URL. |
| **`basemap`** | A reusable background (style URL, tile template, or WMS). | Create → Basemap. Admins can also manage org basemaps from branding. |
| **`folder`** | Bucket for grouping items. Has its own shares, description, and optional smart-folder query. | Create → Folder. |
| **`pick_list`** | Reusable list of code and label values. Data-layer fields can reference one as a domain. | Create → Pick list. |
| **`geo_boundary`** | Reusable polygon. Used as a default extent on a map, a filter on a layer, or a clip on a share. | Create → Boundary. |
| **`form`** | A collection form. Submissions land in a paired data layer. The field PWA can run it offline. | Create → Form. |
| **`data_collection`** | A field deployment: tap features on a map to add or edit them. | Create → Data collection. |
| **`web_app`** | A widget layout (map, chart, indicator, table, and the rest of the built-in set). Editor, viewer, KPI Dashboard, and Operations Board are starter templates. | Create → Web app, then pick a template or start blank. |
| **`print_template`** | Paper layout for the Print tool: map frame, legend, title block, scale bar. | Create → Print template. |
| **`tool`** | A named action or an analysis recipe, reusable from a web-app button. OSM can be a source. The node-graph canvas is not part of this editor. | Create → Tool. |
| **`derived_layer`** | A layer computed from another, with tools such as buffer. | Create → Derived layer. |
| **`file`** | Generic uploaded asset (CSV, PDF, image, and so on). | Create → File. |

Not offered in the create picker, and not usable as their own
product:

- **`dashboard`**: leftover rows only. Dashboards are web apps.
  The item page says so and links to Create → Web app.
- **`report_template`**: document reports (PDF, Word, HTML from
  a template item) are not built. Use a print template for
  paper output from a web app.
- **`widget_package`**, **`layer_package`**,
  **`form_submission_collection`**: the item page is a
  coming-soon notice. Form responses already live on the
  form's Responses tab.


## How items relate

Items reference each other to compose the bigger surfaces:

```
basemap ─────────────┐
                     │
data_layer ──┐       ├──> map ──> web app (viewer, editor,
             │       │              dashboard layout, …)
service ─────┘       │
                     │
form ──> paired data_layer, and the field PWA
data_collection ──> map + editable layers
                     ↑
                     └── boundary (default extent / filter)
                     └── pick_list (referenced by data_layer fields)

folder ──> contains any items as members (multi-membership allowed)
```

In words:

- A **map** layers data sources together (data layers and
  connected services) on top of a **basemap**, optionally
  fitting to a **boundary**.
- A **web app** composes widgets over a map and its layers.
  KPI Dashboard and Operations Board are starting layouts of
  that same app, not a separate item.
- A **form** writes submissions into a paired **data layer**.
  The field PWA runs forms and data collection offline and
  syncs later.
- **Data collection** is a field-mode deployment over a map.
- **Pick lists** are referenced by data-layer fields as
  domains; popups, attribute tables, and forms resolve labels
  through them.
- **Boundaries** can be a map's default extent, a layer's
  visibility clip, or a share's audience clip.
- **Folders** organise items; an item can live in zero, one,
  or many folders (ArcGIS Online keeps an item in one folder).

When you delete an item, the system warns you about its
**dependents** (e.g. "this data layer is used by 3 maps"). You
can still delete; the dependent items will fail gracefully on
the missing reference.


## Admin features (admin only)

`/admin` surfaces, in roughly the order of usefulness:

- **Users** — list, disable, re-enable, set per-user capability
  overrides; auto-disable inactive users
- **Branding** — org name, logo, hero image, custom basemaps
- **Housekeeping** — stale-items dashboard, expiring shares,
  quiet users, bulk recompute extents, bulk revoke
- **Per-user view** — pick a user, see exactly what they can
  see; useful for offboarding audits


## What's not yet implemented

So you don't go hunting for them:

- A full ArcGIS Online replacement, including drop-in ports of
  Experience Builder, Survey123, Field Maps, and enterprise
  identity depth. The web app builder, forms, and field PWA
  cover the nearby jobs. They are their own surfaces.
- Dedicated document report templates (`report_template`)
- A `dashboard` item type. Use a web app and the KPI Dashboard
  or Operations Board template.
- The node-graph tool builder. Tool recipes exist. Saving a
  recipe result as a new data layer or derived layer is still
  disabled in the recipe editor.
- Widget packages and layer packages
- Using one map item as another map's basemap. Basemaps are
  style URLs, tile templates, or tile-layer uploads.


## Where to dig deeper

- [SETUP.md](./SETUP.md) — local dev environment setup
- [data-model.md](./data-model.md) — the items / orgs / sharing
  model in detail
- [sharing-granularity.md](./sharing-granularity.md) — how
  per-row, per-column, per-share-geo-limit sharing works
- [editing-and-collection.md](./editing-and-collection.md) —
  the Editor item type design
- [folders.md](./folders.md) — folders + smart folders
- [auth-model.md](./auth-model.md) — Keycloak / JWT / RBAC
- [web-maps.md](./web-maps.md) — map composition + layer access
  matrix

# Quick start

A short orientation for new users: how sharing works, how to
create items, what items currently exist, and how they relate to
one another. Aimed at someone coming from ArcGIS Online who
wants to get oriented in 15 minutes without reading the deeper
design docs first.

If the dev environment isn't running yet, see [SETUP.md](./SETUP.md).


## Sign in

Open <http://localhost:3000>. Two seeded accounts on a fresh
install:

- **`bob` / `devpassword`** — admin in org Acme, sees every
  item in the org
- **`mateo` / `devpassword`** — contributor in org Acme, only
  sees items shared with him

Sign in as Bob first to see the full surface, then re-test as
Mateo to feel the sharing model.


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
| Hosted Feature Layer / Service | Data layer (`data_layer` item) |
| Web Map | Map (`map` item) |
| Federated ArcGIS service | ArcGIS service (`arcgis_service` item) |
| Tile / vector tile service | Basemap (`basemap` item) |
| Domain (coded value list) | Pick list (`pick_list` item) |
| Boundary used as filter or extent | Geo boundary (`geo_boundary` item) |
| Field Maps + Survey123 | Editor (`editor` item) |


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

- **Data** — data layer, ArcGIS service, WMS / WFS, file
- **Maps** — map, basemap, geo boundary
- **Apps** — editor (and forms / web apps when those land)
- **Analysis** — pick list (and dashboards / reports / notebooks
  when those land)
- **Organize** — folder

Pick a type → a wizard collects the minimum required input →
you land on the item's detail page where everything else is
edited. Saves are autosaved on most surfaces; the detail page
header shows a dirty / saved indicator.


## Items currently available

Implemented and usable today:

| Item type | What it is | Created from |
| --- | --- | --- |
| **`data_layer`** | A native PostGIS-backed dataset. One item can hold multiple sublayers (e.g. parcels + parcel-lines as one schema). | Upload GeoJSON, paste GeoJSON URL, or convert via `ogr2ogr` first. |
| **`map`** | A web map composed of layer references, a basemap, and a viewport. | Map editor; **Add layer** picks from data layers, ArcGIS services, raw URLs, or grouped headers. |
| **`arcgis_service`** | Reference to an external ArcGIS REST feature or map service we don't own. Credentialed services are proxied server-side; the browser never sees the secret. | Paste a service URL; the wizard walks credentials. |
| **`basemap`** | A tile or vector basemap that maps render against. Five built-ins seeded; admins add more from MapTiler / Stadia / custom style JSON. | Admin → Branding → Basemaps. |
| **`folder`** | Bucket for grouping items. Has its own shares, description, and optional smart-folder query. | Create → Folder. |
| **`pick_list`** | Reusable list of code → label values. Data-layer fields can reference one as a domain. | Create → Pick list. |
| **`geo_boundary`** | Reusable polygon. Used as a default extent on a map, a filter on a layer, or a clip on a share. | Draw on map, upload GeoJSON, or pick from admin presets. |
| **`editor`** | A field-collection / data-editing app. References a base map and one or more data-layer targets, with per-target edit capabilities. The closest analogue to Field Maps + Survey123 in one. | Create → Editor; pick a reference map and add target layers. |
| **`file`** | Generic uploaded asset (CSV, PDF, image, etc.). | Create → File. |
| **`wms_service`**, **`wfs_service`** | OGC service references, similar shape to `arcgis_service`. | Create → WMS / WFS. |

Scaffolded but not yet usable (the type exists, the create flow
might land on a stub):

- **`form`** — survey-style form authoring. Use `editor`
  instead for now.
- **`web_app`** — Experience Builder analogue
- **`dashboard`** — dashboards
- **`notebook`** — JupyterHub integration
- **`report_template`** — print / report generation
- **`tool`**, **`widget_package`**, **`layer_package`** — tool
  builder + reusable bundles
- **`form_submission_collection`** — form responses bucket


## How items relate

Items reference each other to compose the bigger surfaces:

```
basemap ─────────────┐
                     │
data_layer ──┐       │
             ├──> map ──> editor
arcgis_service ┘       
                     ↑
                     └── geo_boundary (default extent / filter)
                     └── pick_list (referenced by data_layer fields)

folder ──> contains any items as members (multi-membership allowed)
```

In words:

- A **map** layers data sources together (data layers, ArcGIS
  services, WMS / WFS) on top of a **basemap**, optionally
  fitting to a **geo boundary**.
- An **editor** references a single **map** as its base view
  and one or more **data layers** as edit targets.
- **Pick lists** are referenced by data-layer fields as
  domains; popups, attribute tables, and editor forms all
  resolve labels through them.
- **Geo boundaries** can be a map's default extent, a layer's
  visibility clip, or a share's audience clip.
- **Folders** organise items; an item can live in zero, one,
  or many folders (unlike AGO's one-folder constraint).

When you delete an item, the system warns you about its
**dependents** (e.g. "this data layer is used by 3 maps"). You
can still delete; the dependent items will fail gracefully on
the missing reference.


## Admin features (Bob only)

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

- Survey form authoring (use `editor` for data collection)
- Experience Builder / web-app builder
- Dashboards and printable reports
- Hosted Jupyter notebooks
- Tool / widget builder
- Offline mobile field app (the editor is web-only today)
- Map-as-basemap composition (one map can't yet act as a
  basemap for another; basemap items are tile / style only)
- Append mode on data-layer updates (full replace works;
  appending rows is on the roadmap)


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

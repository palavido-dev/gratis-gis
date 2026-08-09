---
id: reference-python-client
title: Python client
summary: Read, filter, create, and export layers from Python, with the same code on your laptop and on the server.
category: reference
order: 46
complexity: intermediate
tags:
  - api
  - python
  - automation
  - integration
  - export
related:
  - reference-api-keys
  - reference-scripts
  - reference-api
---

`gratisgis` is a small Python client for a GratisGIS portal. It talks
to the same HTTP API a browser does, with an API key instead of a login,
so a script that works on your laptop works unchanged as a scheduled
job on the server.

```bash
pip install gratisgis
```

Python 3.9 or newer, and one dependency (`httpx`).

You need an API key. Create one at **Profile → API keys**; see
[API keys](/help/reference/api-keys).

## Connect

```python
from gratisgis import GratisGIS

gg = GratisGIS("https://your-portal.example", api_key="ggk_...")
print(gg.whoami()["username"])
```

Better, for anything you will run more than once: keep the key out of
the file.

```python
gg = GratisGIS.from_env()   # reads GRATISGIS_URL and GRATISGIS_API_KEY
```

Inside a [script item](/help/reference/scripts) those two variables are
already set for you, which is why the same file runs in both places.

A key acts as the person who created it. Same sharing, same geographic
limits, same permissions. It cannot do anything you could not do
yourself in the browser.

## Find a layer

```python
layers = gg.find_items(type="data_layer", query="parcels")
for item in layers:
    print(item["id"], item["title"])
```

A data layer holds one or more **layers**, each with its own id. That
id is what every call below wants, and it is not the same as the
layer's display name.

```python
item = gg.item(layers[0]["id"])
for sub in item["data"]["layers"]:
    print(sub["id"], "-", sub["label"], sub["geometryType"])
```

## Read features

For anything but a small layer, iterate. `iter_features` pages behind
the scenes with a keyset cursor pinned to a single snapshot, so memory
stays flat and a concurrent edit cannot make a feature appear twice or
vanish mid-walk.

```python
count = 0
for feature in gg.iter_features(item_id, "parcels"):
    count += 1
print(count, "parcels")
```

`read_features` gets you one page, or the whole thing at once if you
ask for no limit. Reach for it when you know the layer is small.

```python
fc = gg.read_features(item_id, "parcels", limit=100)
print(fc["features"][0]["properties"])
```

## Filter

Be aware of what the portal can and cannot do here. There is **no
general query language**: no `where=`, no SQL, no CQL. There are three
specific filters, and everything else is done in Python.

**By area.** A bounding box in longitude and latitude:

```python
for feature in gg.iter_features(
    item_id, "parcels", bbox=(-79.95, 38.85, -79.80, 38.95)
):
    ...
```

**By one field, exact match:**

```python
fc = gg.read_features(item_id, "parcels", parent_fk="owner", parent_id="Smith")
```

**By date range:**

```python
fc = gg.read_features(
    item_id, "inspections",
    time_field="inspected_on", time_from="2026-01-01", time_to="2026-06-30",
)
```

**By text, anywhere in the attributes:**

```python
for hit in gg.search_features(item_id, "parcels", "elkins", fields=["owner"]):
    print(hit["properties"])
```

**Anything else** is a Python filter over the iterator. This is not a
workaround to be embarrassed about; it is the honest shape of the API
today, and on a layer of any normal size it is fast enough:

```python
big = [
    f for f in gg.iter_features(item_id, "parcels")
    if (f["properties"].get("acres") or 0) > 50
]
```

If you filter on a field the layer does not have, the client raises
straight away rather than sending it. The portal would otherwise ignore
the unknown field and hand back the entire layer, which looks like a
successful query with a surprising number of rows.

## Buffer, and other geometry

Two ways, and the first is usually the right one.

### On the server, without downloading anything

A **derived layer** is a saved pipeline that PostGIS evaluates when the
layer is read. The data never leaves the server, and the result is not a
copy: buffer a parcels layer and the buffer follows every later edit to
the parcels.

```python
from gratisgis import buffer, step

# Look before you commit: runs the pipeline, returns a small sample,
# saves nothing.
preview = gg.preview_pipeline(item_id, "parcels", [buffer(100)])

derived = gg.create_derived_layer(
    "Parcels buffered 100m",
    item_id, "parcels",
    [buffer(100), step("dissolve", fields=["county"])],
)
```

`buffer()` runs as `ST_Buffer` on the geography type, so 100 metres is
100 metres anywhere on Earth and you do not have to choose a projection.
Buffer each feature by its own field with `buffer("setback_ft", "feet")`.

Available steps: `buffer`, `dissolve`, `centroid`, `convex-hull`,
`bbox`, `simplify`, `vertices`, `densify`, `top-n`, `random-sample`,
`nearest-neighbor`, `fishnet`, `calculate-geometry`, `filter`,
`calculate-field`, `aggregate`, `spatial-join`, `spatial-filter`,
`clip`, `erase`, `contour`. Note `clip` and `erase` rather than
`intersect` and `difference`.

The result reads like any other layer, so `iter_features`,
`export_layer` and the rest work on it unchanged.

### In your own process

When the pipeline cannot express what you need, pull the features and
use [Shapely](https://shapely.readthedocs.io), which is already
installed in the script runner. You are then responsible for the
projection, and that is the part people get wrong:

```bash
pip install shapely pyproj    # on your own machine
```

Buffering needs a projected coordinate system. Doing it in degrees is
the classic mistake: a 100 unit buffer in EPSG:4326 is a hundred
degrees, most of the planet.

```python
from shapely.geometry import shape, mapping
from shapely.ops import transform
from pyproj import Transformer

# WGS84 -> UTM 17N, which covers West Virginia. Pick the zone or the
# state plane CRS for your own area.
to_m = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
to_deg = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform

buffered = []
for f in gg.iter_features(item_id, "parcels"):
    geom_m = transform(to_m, shape(f["geometry"]))
    ring = transform(to_deg, geom_m.buffer(100))      # 100 metres
    buffered.append({
        "type": "Feature",
        "geometry": mapping(ring),
        "properties": {"parcel_id": f["properties"].get("parcel_id")},
    })
```

## Write the result to a new layer

Create the layer, then append. One call each: layers are metadata, so
there is nothing to provision and the new item accepts features
immediately.

```python
from gratisgis import field, layer

new = gg.create_data_layer(
    "Parcels buffered 100m",
    layers=[
        layer("buffered", "Buffered parcels", "polygon", [
            field("parcel_id", "string", "Parcel ID"),
        ])
    ],
)
gg.add_features(new["id"], "buffered", buffered)
print("created", new["id"])
```

Geometry types are `point`, `line`, `polygon`, or `None` for a table
with no geometry. Note `line`, not GeoJSON's `LineString`. Field types
are `string`, `number`, `boolean`, `date`, and `multi_select`. Pass
something else and you get an error naming the valid options rather
than a confusing failure later.

Appending batches automatically, so handing it a million features is
fine.

## Refresh a layer from a file

The reason most people end up here. One call, and it handles shapefiles
(zip them), GeoPackage, file geodatabases, GeoJSON, KML, GPX, CSV with
coordinates, and GeoParquet.

```python
result = gg.import_file(
    item_id, "parcels", "parcels-2026-08.gpkg",
    mode="replace",
    progress=lambda done, total, inserted: print(f"{done}/{total}"),
)
print(result["inserted"], "features")
```

`mode="replace"` empties the layer first, which is what a refresh
usually means. **It truncates before it inserts**, so a failure part way
through leaves the layer empty rather than rolling back to yesterday's
data. If the source is something you cannot fetch again, export first.

`mode="append"` is the default and adds without removing.

For a multi-layer archive like a `.gdb`, name the one you want with
`source_layer=`. Files are capped at 1 GB.

## Compute a field for every feature

Instead of reading, editing, and writing every feature back:

```python
gg.calculate_field(
    item_id, "parcels",
    "{{acres}} * 4046.86", "area_m2", output_type="number",
)
```

The expression language is the portal's own, not Python. Fields are
`{{name}}`, string joining is `~~`, and there are a handful of
functions: `upper`, `lower`, `length`, `concat`, `coalesce`, `abs`,
`round`, `floor`, `ceil`, `if`.

Always try it with `dry_run=True` first. You get the same summary plus a
five-row sample of before-and-after values, and nothing is written:

```python
preview = gg.calculate_field(..., dry_run=True)
for row in preview["sample"]:
    print(row["oldValue"], "->", row["newValue"])
```

Rows whose expression fails become `null` and are counted in `errors`
rather than failing the whole run. Capped at 10,000 rows per call.

## Managing items

```python
gg.add_layer(item_id, layer("roads", "Roads", "line", [
    field("surface", "string"),
]))

gg.set_access(item_id, "org")                       # private | org | public
gg.share_item(item_id, user_id=uid, permission="edit")
gg.unshare_item(item_id, user_id=uid)
print(gg.shares(item_id))
print(gg.permissions(item_id))                      # what THIS key can do

gg.delete_item(item_id)                             # to the trash
gg.restore_item(item_id)                            # and back
gg.purge_item(item_id)                              # gone, for good
```

`permission` is one of `view`, `download`, `edit`, `admin`, and is
required rather than defaulting. Re-sharing without it would quietly
downgrade an existing share to view.

Deleting is a soft delete. Nothing is destroyed until `purge_item`, and
purge only works on something already in the trash. Deleting needs to be
the **owner or an org admin** — an `admin` share is not enough, on
purpose.

`add_layer` is worth using rather than patching `data` yourself: a
layer's schema lives in one JSON column that is replaced wholesale, so a
hand-written patch that omits an existing layer makes its features
unreachable. This reads, appends, refuses to drop anything, and uses
optimistic concurrency so two people adding layers at once get an error
instead of one silently losing.

## Attachments

Photos and documents attach to individual features. All four operations
work from Python.

```python
# what is already attached
for att in gg.attachments(item_id, "inspections", feature_id):
    print(att["fileName"], att["sizeBytes"], att["mime"])

# add one
gg.attach_file(item_id, "inspections", feature_id, "site-photo.jpg")

# fetch them all into a folder
import pathlib
out = pathlib.Path("photos"); out.mkdir(exist_ok=True)
for att in gg.attachments(item_id, "inspections", feature_id):
    gg.download_attachment(att, path=out)   # keeps the original name

# remove one
gg.delete_attachment(item_id, "inspections", feature_id, att["id"])
```

Uploading takes three calls under the hood: the client asks the portal
for a presigned URL, sends the bytes straight to object storage, then
registers the metadata. The API never handles the file, which is why a
25 MB photo from a field crew does not go through it. You do not have to
think about any of that, but it explains two things you might otherwise
trip over.

**Uploading needs a key without the read-only option.** Read-only keys
are refused on every write, so listing and downloading work but
attaching and deleting return a permission error.

**Self-hosted portals sometimes cannot accept uploads from outside.**
Object storage has its own address, and some deployments point it at an
internal hostname that only resolves inside the server. Listing and
downloading still work, because those go through the portal. If an
upload fails, the error names the host it tried, which is the thing to
give your administrator.

Downloading only needs read access to the layer. Worth knowing: that is
a lower bar than exporting the layer's data, which needs download
permission. A view-only share can still fetch the attached files.

## Export

```python
gg.export_layer(item_id, "parcels", path="parcels.parquet")
gg.export_layer(item_id, "parcels", format="geojson", path="parcels.geojson")
gg.export_layer(item_id, "parcels", format="csv", path="parcels.csv",
                geometry="wkt")
```

Without `path` you get the bytes back instead.

One thing to know when the layer is large: **`geoparquet` exports
everything, `csv` stops at 100,000 rows.** GeoParquet streams through
the paging iterator; CSV goes through the read path, which has a
ceiling, and it does not warn you when it hits it. If the row count
matters, use GeoParquet.

Exporting bulk data needs **download** permission, a step above being
able to see the layer on a map. A view-only share gets a clear error.

## Errors

Everything raises a subclass of `PortalError`, so one `except` catches
the lot and the specific ones let you react.

```python
from gratisgis import GratisGIS, PortalError, AuthError, NotFoundError

try:
    gg.read_features(item_id, "parcels", limit=1)
except AuthError:
    print("The key is wrong, revoked, or lacks permission.")
except NotFoundError:
    print("No such item or layer.")
except PortalError as e:
    print(f"{e.status}: {e}")
```

Every error carries `.status`, `.method`, `.path`, and the portal's own
`.body`, which is usually a sentence written for a person.

## The whole thing, as a scheduled job

Paste this into a [script item](/help/reference/scripts) and give it a
schedule. It reads a layer, buffers it, and replaces the contents of a
second layer with the result.

```python
import sys
from gratisgis import GratisGIS, PortalError
from shapely.geometry import shape, mapping
from shapely.ops import transform
from pyproj import Transformer

SOURCE = "your-source-item-id"
TARGET = "your-target-item-id"

def main() -> int:
    gg = GratisGIS.from_env()
    to_m = Transformer.from_crs("EPSG:4326", "EPSG:32617", always_xy=True).transform
    to_deg = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True).transform

    out = []
    for f in gg.iter_features(SOURCE, "parcels"):
        if not f.get("geometry"):
            continue
        ring = transform(to_deg, transform(to_m, shape(f["geometry"])).buffer(100))
        out.append({
            "type": "Feature",
            "geometry": mapping(ring),
            "properties": {"parcel_id": f["properties"].get("parcel_id")},
        })

    result = gg.add_features(TARGET, "buffered", out)
    print(f"wrote {result['inserted']} features")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except PortalError as err:
        # A non-zero exit marks the run failed in the portal's run
        # history, so a job that quietly stopped working is visible
        # rather than a green row with an empty result.
        print(f"failed: {err}", file=sys.stderr)
        sys.exit(1)
```

## Geocoding

There is no single portal-wide geocoder. Each one is an item somebody
configured, either over one of the org's own address layers or pointing
at an external locator, so you pick which to use:

```python
for g in gg.find_geocoders():
    print(g["id"], g["title"])

hits = gg.geocode(geocoder_id, "12 Main St", limit=5)
print(hits[0]["label"], hits[0]["geom"]["coordinates"])
```

Candidates come back best first, each with a `score` and a Point
`geom`, which is the centroid when the match was a line or polygon. Pass
`bbox=(west, south, east, north)` to restrict the search area.

If nothing shows up in `find_geocoders()`, nobody has set one up on
this portal. There is no reverse geocoding and no batch call.

## What the client does not do

- **No raster or point cloud access.** Hillshade, viewshed, contours,
  and the rest of the elevation tools run as jobs from the portal UI,
  and need the analysis worker deployed.
- **No local geometry.** Vector geoprocessing is a derived layer, which
  runs on the server; anything beyond those steps is Shapely's job in
  your own process.
- **No admin.** Creating users, editing org settings, and managing
  other people's keys are refused for API keys entirely, by design.
- **No async.** It is a synchronous client, which is what a cron job
  wants. Wrap it in a thread if you need otherwise.

## See also

- [API keys](/help/reference/api-keys) — creating and revoking them
- [Scripts](/help/reference/scripts) — running Python on the server
- [The HTTP API](/help/reference/api) — what the client calls

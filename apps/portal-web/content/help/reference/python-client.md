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

The client does no geometry. Use [Shapely](https://shapely.readthedocs.io),
which is already installed in the script runner:

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

## What the client does not do

- **No geometry operations.** Buffer, intersect, and dissolve are
  Shapely's job, or the portal's analysis tools for anything large.
- **No raster or point cloud access.** Those go through the portal UI
  and the analysis queue.
- **No admin.** Creating users, editing org settings, and managing
  other people's keys are refused for API keys entirely, by design.
- **No async.** It is a synchronous client, which is what a cron job
  wants. Wrap it in a thread if you need otherwise.

## See also

- [API keys](/help/reference/api-keys) — creating and revoking them
- [Scripts](/help/reference/scripts) — running Python on the server
- [The HTTP API](/help/reference/api) — what the client calls

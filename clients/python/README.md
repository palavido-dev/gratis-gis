# gratisgis (Python client)

Talk to a [GratisGIS](https://github.com/palavido-dev/gratis-gis) portal
from Python: notebooks, scheduled scripts, CI, or an editor on your own
machine.

```bash
pip install gratisgis
```

Until the first PyPI release, install from source:

```bash
pip install "gratisgis @ git+https://github.com/palavido-dev/gratis-gis#subdirectory=clients/python"
```

The full guide, with worked examples for filtering, buffering, writing
a new layer, and exporting, is in the portal at
`/help/reference/python-client`.

## Get a key

In the portal: **Profile -> API keys -> Create key**. The token is shown
once. A key acts as the user who created it, so it sees exactly what
you see, with the same sharing and geographic limits. Tick **Read only**
unless the script needs to write.

## Use it

```python
from gratisgis import GratisGIS

gg = GratisGIS("https://your-portal.org", api_key="ggk_...")

# Which account is this key?
print(gg.whoami()["username"])

# Find a layer and read it as GeoJSON
layer = gg.find_items(type="data_layer", query="parcels")[0]
fc = gg.read_features(layer["id"], "parcels", limit=500)
print(len(fc["features"]), "features")
```

Prefer environment variables so the secret stays out of your source,
which also means the same script runs unchanged anywhere:

```python
# GRATISGIS_URL=https://your-portal.org
# GRATISGIS_API_KEY=ggk_...
gg = GratisGIS.from_env()
```

## Writing

```python
features = [
    {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [-79.85, 38.93]},
        "properties": {"name": "New hydrant", "status": "active"},
    }
]
gg.add_features(layer_id, "hydrants", features)
```

`add_features` batches for you. The portal refuses more than 5000
features in one request, so hand it a list or a generator of any size
and it splits the work.

Edits are recorded as new observations rather than overwriting rows, so
a feature's history stays intact and remains queryable:

```python
gg.update_feature(layer_id, "hydrants", feature_id,
                  properties={"status": "needs service"})
```

## A monthly refresh, end to end

The shape most people want. Point it at a source, replace what changed,
and let cron run it:

```python
import os
from gratisgis import GratisGIS, PortalError

def main() -> int:
    gg = GratisGIS.from_env()
    layer_id = os.environ["PARCEL_LAYER_ID"]
    try:
        incoming = fetch_from_county()          # your code
        result = gg.add_features(layer_id, "parcels", incoming)
        print(f"appended {result['appended']} features")
        return 0
    except PortalError as exc:
        # Non-zero so cron / systemd notices, and the portal's own
        # message reaches your logs verbatim.
        print(f"refresh failed: {exc}")
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
```

## Errors

Every failure raises a subclass of `PortalError` carrying the portal's
own message, plus the status and route:

| Class | When |
| --- | --- |
| `AuthError` | 401 / 403. Bad, expired, or revoked key; read-only key attempting a write; a key used on an admin route |
| `NotFoundError` | 404. Missing, or not visible to this key |
| `ValidationError` | 400 / 422. Understood and refused |
| `ConflictError` | 409. Something moved under you |
| `RateLimitError` | 429. Carries `retry_after` when the portal sends it |
| `PortalError` | Anything else, including a network failure |

## What this does not do

It wraps the item API and the feature endpoints, which is what
automation needs. It is not a mirror of every portal route.

It also has exactly one dependency, `httpx`. GeoPandas, Shapely and
friends belong to your environment, not to a portal client: bring the
stack you already use and hand this GeoJSON.

There is no hosted execution environment. Scripts run wherever you run
them. Server-side scheduled execution is
[tracked separately](https://github.com/palavido-dev/gratis-gis/issues/221).

## Development

```bash
pip install -e ".[dev]"
pytest
```

The tests run against `httpx.MockTransport`, so no portal is needed.

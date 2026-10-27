# meta.ui presentation contract

Server-computed presentation block attached to **item detail**
responses (`GET /api/items/:id` and `GET /api/public/items/:id`).
It is not stored in the database.

Goal: portal-web, the QGIS plugin (`gratis-gis-qgis`), MCP, and the
Python client consume one answer for "how do I open / download this
item" instead of each re-deriving endpoints from `item.data`.

## Shape

```json
{
  "meta": {
    "ui": {
      "version": 1,
      "layers": [
        {
          "title": "Parcels",
          "source": {
            "kind": "data-layer",
            "itemId": "<uuid>",
            "layerKey": "parcels"
          },
          "geometryType": "Polygon"
        }
      ],
      "downloads": [
        {
          "label": "GeoJSON",
          "url": "/api/items/<uuid>/geojson",
          "format": "GeoJSON"
        }
      ],
      "thumbnailUrl": "/api/portal/items/<uuid>/thumbnail.svg?v=…",
      "landingPath": "/items/<uuid>"
    }
  }
}
```

- `layers[].source` uses the same `MapLayerSource` discriminated union
  as web maps (`data-layer`, `tile`, `point-cloud`, `arcgis-rest`, …).
- URLs are portal-relative. QGIS / MCP prefix with the configured
  portal origin.
- Downloads prefer auth-gated item routes (`/api/items/...`,
  `/api/portal/tile-layer/...`, `/api/portal/point-cloud/...`).
  Public items also get the anonymous OGC Features URL.
- Empty `layers` means "not map-stamped here"; open `landingPath`
  instead (maps, web apps, forms).
- List endpoints do **not** include `meta.ui` (payload size).

## Consumers

| Client | Status |
| --- | --- |
| portal-web `layersForPortalItem` | Prefers `meta.ui` when present; falls back to local builders for lite list rows |
| QGIS plugin | Follow-up: switch open/add-layer off `meta.ui.layers` / `downloads` |
| Python / MCP | Prefer `meta.ui` when reading a single item |

## Out of scope for v1

- Absolute URLs (callers already know the portal base)
- Persisting `meta.ui` on the item row
- Rewriting the Add Layer dialog's interactive sublayer picker
- WMS/WFS connected-service viewer hints (still dialog-only)

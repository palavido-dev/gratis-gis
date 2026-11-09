# Vector tiles for hosted layers

Every spatial layer of a hosted (v3) data layer is served as Mapbox
Vector Tiles. The web map draws from them, and outside clients
(QGIS, MapLibre apps, tile proxies) can use them too.

## Tile routes

| Route | Who | Cache-Control default |
| --- | --- | --- |
| `/api/items/{id}/layers/{layer}/tile/{z}/{x}/{y}.mvt` | Anyone who can read the layer (bearer token, or the portal session through `/api/portal/...`). Share geo limits and row scope apply. | `private, max-age=60` |
| `/api/public/items/{id}/layers/{layer}/tile/{z}/{x}/{y}.mvt` | Anonymous, public items only. The public tier boundary applies. | `public, max-age=300` |
| `/api/public/ogc/collections/{collectionId}/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}` | Anonymous OGC API Tiles, public items only. | `public, max-age=300` |

Each tile has an MVT layer named `features` (and `labels` when label
points are on, see below). Every feature carries
`_global_id` plus the layer's attribute fields (see "Fields in tiles"
below). An empty tile is a `200` with an empty body.

## Tile settings (owners)

Open the layer in the item's **Structure** tab (or while creating the
layer) and expand **Vector tiles**. Every box starts empty, which
means the server default, so a layer nobody touches behaves exactly
as before.

- **Fields in tiles.** All fields (default), or only the fields you
  tick. Fields a web map uses for its style, labels, filter or hover
  popup are always added back: the map names them in the tile URL
  (`include=`), and the server adds any that are declared on the
  layer. Other unticked fields are not in the tiles, so an app widget
  that filters the map by such a field in the browser will not see
  it. This only makes tiles smaller. It is not access control: every
  field is still readable through the layer's features API, click
  popups and exports.
- **Min zoom / Max zoom** (0 to 24). Max zoom is the deepest zoom
  tiles are built for. The web map reads the range from the layer's
  TileJSON and sets it on its vector source, so past max zoom MapLibre
  keeps showing the deepest tiles, enlarged (overzoom), and below min
  zoom it requests nothing. TileJSON clients do the same. A request
  outside the range still gets an empty tile, without a database
  query. A map that is already open picks up a changed range on
  reload.
- **Max features per tile** (1 to 5000). Lowers the server's per-tile
  cap. It cannot raise it.
- **Browser cache (seconds)** (0 to 3600). Changes the `max-age` on
  tile responses. It never changes `private` or `public`: the
  authenticated route is always `private`, because its tiles depend
  on who is asking, and only the anonymous routes, which serve public
  items, say `public`. Keep in mind that after you make a public
  layer private, a shared cache may keep serving its tiles for up to
  this many seconds.

- **Label each line and polygon once** (line and polygon layers,
  off by default). MapLibre labels a line or polygon once per tile
  it crosses, so a parcel on a tile edge gets two labels and a long
  road gets one per tile. With this on, each tile gets a second MVT
  layer, `labels`: one point per line or polygon (a point inside the
  polygon from `ST_PointOnSurface`, or the middle of a line's longest
  part), computed from the whole stored geometry and sent only in the
  one tile that contains it. Label points carry `_global_id` and the
  same fields as the tile. Line and polygon features in `features`
  carry `_label_point: true`. The web map then labels marked features
  from their point and everything else from the geometry; labels set
  to follow lines keep labelling the line. The points come from the
  same capped, access-filtered feature set as the tile, so the extra
  cost is one point per feature already in the tile.

The API validates the settings when the layer is saved and refuses a
value outside these ranges. Field names that are no longer on the
layer are dropped on save.

Changing a setting that changes tile content (fields, feature cap)
changes the server's tile cache key, so no stale tile is served from
the server cache. Browsers may keep a tile for its `max-age`.

## TileJSON

Each tile route has a [TileJSON 3.0.0](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0)
document next to it:

- `/api/items/{id}/layers/{layer}/tilejson.json` (same access check as
  the authenticated tile route)
- `/api/public/items/{id}/layers/{layer}/tilejson.json` (public items
  only, like the anonymous tile route)
- `/api/public/ogc/collections/{collectionId}/tiles/WebMercatorQuad/tilejson.json`
  (linked from the OGC tileset documents as `rel: describedby`)

The document lists the tile URL template, `minzoom` / `maxzoom` from
the layer's settings (0 and 22 by default), `vector_layers` with the
fields the tiles actually carry and their types (`Number` for number
fields, `String` for the rest, plus `_global_id`; with label points on,
also the `labels` layer and `_label_point`), `attribution` when
the layer or item has one, and `bounds` from the stored layer extent.
`bounds` is left out when a share geo limit, row scope or public tier
boundary narrows what the caller can see.

URLs in TileJSON are built from `PORTAL_BASE_URL`, never from the
request's `Host` header. Set `PORTAL_BASE_URL` to the portal's public
address (the production compose files already do).

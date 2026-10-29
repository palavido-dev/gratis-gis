# What's new

User-visible changes shipped to GratisGIS. Plain-English summaries
only; one entry per notable feature. Add new entries at the top.

Format:

- Optional release banner (Keep a Changelog style), once per tagged
  release: `## [0.9.120] - 2026-10-28`. Entries below inherit that
  version until the next banner or `## [earlier]` (clears the stamp
  for pre-version history). The landing card and `/whats-new`
  history page group by these banners.
- Each feature: `## YYYY-MM-DD - Short feature name` on one line,
  then one short paragraph of plain-English description.

This file is loaded by the public landing page (five newest) and
the full `/whats-new` history at runtime, so keep entries short and
accessible. Anything that reads like a developer release note
("Refactored the X service") doesn't belong here. Prefer starting a
new release banner when cutting a version tag.

<!-- entries below this line are surfaced on the public landing page -->

## 2026-10-29 - Measure ground area on 3D terrain
With elevation terrain on, Measure → Area shows ground (slope) surface acres as the main number, and still lists horizontal planimetric area underneath (the same basis as parcel acre fields). Pitched 3D makes sketches look larger than their map footprint — flatten the pitch and check the scale bar when comparing.

## [0.9.122] - 2026-10-29

## 2026-10-29 - Measure scale bar, more chrome languages, honest data-layer help
The Measure pane no longer covers the map scale bar, so pitched 3D area sketches have ground truth next to the readout. Folder, item, and print-template chrome join the language catalogs. Data layer help drops the “native Esri feature service” claim. Public catalog, CSW, and zoom-to-filter endpoints tighten anonymous rate limits further.

## [0.9.121] - 2026-10-28

## 2026-10-28 - Measure, print preview, and elevation profile
Maps gain a Measure tool for distances and areas, Print this map shows a layout preview before PDF download (with hover thumbnails), and the elevation Profile works again on Web Mercator DEMs — Profile and View From only appear when the map has terrain. Builder and sharing chrome keep expanding through Spanish, French, German, and Brazilian Portuguese. Public layer and catalogue endpoints tighten anonymous rate limits further.

## 2026-10-28 - Full What's new history
The landing What's new card now links to a scrollable `/whats-new` page that lists every past update, grouped by release when a version banner is present.

## [0.9.120] - 2026-10-28

## 2026-10-28 - Analyze shortcuts, field chrome languages, and tighter public API limits
Analyze can now create private PostGIS layers for Group by, Contour, Random sample, Top N, Fishnet, Nearest neighbor, and more from the layer tab. Field and map editor chrome keep growing into Spanish, French, German, and Brazilian Portuguese. Public list and search endpoints that used to share a loose global budget now rate-limit anonymous scans more tightly.

## 2026-10-28 - Group by for this layer from Analyze
On a data layer's Analyze tab, **Group by for this layer** opens one optional group key (or whole layer), one aggregate (count / sum / avg), and an output name, then creates a private PostGIS derived layer. Geometry is always the union of each group (`ST_Union`). Multi-key and multi-agg stay in Create → Derived layer. Expect a server job, not an instant browser result.

## 2026-10-28 - Contour for this layer from Analyze
On a point data layer's Analyze tab, **Contour for this layer** opens numeric field, auto interval, and optional min/max controls and creates a private PostGIS derived layer of TIN iso-lines (each line carries a `level` property). Not iso-polygons; dense point sets can be slow. Same path as Create → Derived layer → Contour. Expect a server job, not an instant browser result.

## 2026-10-28 - Honest Print template help
Help now has a **Print template** item page, and the Print widget / print-templates section describe the shipped paper layouts (page size, map/legend/scale/north-arrow, parameters, browser print) instead of promising DOCX report merges that are not built.

## 2026-10-28 - Random sample for this layer from Analyze
On a data layer's Analyze tab, **Random sample for this layer** opens percentage-or-count, value, and seed controls (with reshuffle) and creates a private PostGIS derived layer. The sample is deterministic for a given seed — not Postgres `random()`. Same path as Create → Derived layer → Random sample. Expect a short server job, not an instant browser result.

## 2026-10-28 - Honest OSM truncated flag on recipe tools
When a recipe tool’s OSM overlay (or nearest-N / relational) result hits a feature cap, the response now sets truncated honestly instead of always claiming the list is complete. Zoom in or tighten the query if you need a full census of the area.

## 2026-10-28 - Top N for this layer from Analyze
On a data layer's Analyze tab, **Top N for this layer** opens numeric field, N, and highest/lowest controls and creates a private PostGIS derived layer with those rows (NULLs last). Same path as Create → Derived layer → Top N. Expect a short server job, not an instant browser result.

## 2026-10-28 - Fishnet for this layer from Analyze
On a polygon data layer's Analyze tab, **Fishnet for this layer** opens cell size, unit, and polygons vs lines controls and creates a private PostGIS derived layer (`ST_SquareGrid`, clipped to the source). Point/line layers do not show the chip. Very fine grids on large extents may hit a ~1 million cell save-time cap. Same path as Create → Derived layer → Fishnet. Expect a short server job, not an instant browser result.

## 2026-10-28 - Nearest neighbor for this layer from Analyze
On a data layer's Analyze tab, **Nearest neighbor for this layer** creates a private PostGIS derived layer that adds `nearest_distance_m` (meters to the closest other feature in the same layer). Same-layer only; large layers can be slow (O(N²)); a single-row layer yields NULL. Same path as Create → Derived layer → Nearest neighbor. Expect a short server job, not an instant browser result.

## 2026-10-28 - Data collection help for field deployments
Help now has a **Data collection** page: what a field deployment includes (map, editable layers, forms), how QR / link share works, Download for offline and Refresh, sync queue and where to review conflicts, and an honest note that this is not Field Maps or Survey123.

## 2026-10-28 - Field offline and GPS chrome follow your language
On a field deployment, Download for offline / Refresh offline cache, Show my location and GPS status, Save feature / Save changes, Layer visibility, related-record sync hints, and the edits-waiting-to-sync badge follow the portal language (English, Spanish, French, German, Brazilian Portuguese).

## 2026-10-28 - Calculate geometry for this layer from Analyze
On a data layer's Analyze tab, **Calculate geometry for this layer** opens length / perimeter / area, unit, and field-name controls and creates a private PostGIS derived layer with that measure (geography, honest units). This is not Calculate field expressions. Same path as Create → Derived layer → Calculate geometry. Expect a short server job, not an instant browser result.

## 2026-10-28 - Vertices for this layer from Analyze
On a data layer's Analyze tab, **Vertices for this layer** creates a private PostGIS derived layer that explodes each geometry into one point per vertex (`ST_DumpPoints`, with `vertex_index`). Dense shapes can produce many rows; multi-part geometries dump all parts together. Same path as Create → Derived layer → Vertices. Expect a short server job, not an instant browser result.

## 2026-10-28 - Bounding boxes for this layer from Analyze
On a data layer's Analyze tab, **Bounding boxes for this layer** creates a private PostGIS derived layer that replaces each feature with its axis-aligned envelope (attributes kept; not one box for the whole layer). Same path as Create → Derived layer → Bbox. Expect a short server job, not an instant browser result.

## 2026-10-28 - Field collect buttons follow your language
On a field deployment, Add at GPS / Add at center (and Vertex at … for lines and polygons), Remove from device, and the map tool labels follow the portal language (English, Spanish, French, German, Brazilian Portuguese).

## [earlier]

## 2026-10-27 - Honest streaming note on large point clouds
On a point cloud item, clouds over about 20 million points show a short note under the 3D viewer: lower in-view density and delayed rebuilds while you pan (stricter again over 100 million). This is a responsiveness tradeoff, not Potree-style LOD or 3D Tiles yet — see Point cloud help.

## 2026-10-27 - Densify this layer from Analyze
On a data layer's Analyze tab, **Densify this layer** opens a max segment length and unit form and creates a private PostGIS derived layer that adds vertices so no segment exceeds that length (`ST_Segmentize` on geography; min 1 m, soft max 100 km). Same path as Create → Derived layer → Densify. Expect a short server job, not an instant browser result.

## 2026-10-27 - Convex hulls for this layer from Analyze
On a data layer's Analyze tab, **Convex hulls for this layer** creates a private PostGIS derived layer that replaces each feature with its convex hull (attributes kept; not one hull for the whole layer). Same path as Create → Derived layer → Convex hull. Expect a short server job, not an instant browser result.

## 2026-10-27 - Simplify this layer from Analyze
On a data layer's Analyze tab, **Simplify this layer** opens a tolerance and unit form and creates a private PostGIS derived layer that drops vertices within that tolerance (`ST_Simplify`; not topology-preserving). Same path as Create → Derived layer → Simplify. Expect a short server job, not an instant browser result.

## 2026-10-27 - Dissolve this layer from Analyze
On a data layer's Analyze tab, **Dissolve this layer** creates a private PostGIS derived layer that unions every feature into one shape (attributes dropped; same path as Create → Derived layer → Dissolve). For one polygon per attribute value with counts or sums, use Group by with dissolve geometry instead. Expect a short server job, not an instant browser result.

## 2026-10-27 - Centroids for this layer from Analyze
On a data layer's Analyze tab, **Centroids for this layer** creates a private PostGIS derived layer that replaces each feature with its geometric center point (same path as Create → Derived layer → Centroid). Expect a short server job, not an instant browser result.

## 2026-10-27 - Erase this layer from Analyze
On a data layer's Analyze tab, **Erase this layer** creates a private PostGIS derived layer that keeps features outside a mask data layer you pick (same path as Create → Derived layer → Erase). Expect a short server job, not an instant browser result.

## 2026-10-27 - Dismiss a sync conflict after you review it
On a layer's data panel, each sync conflict now offers **Dismiss** next to Re-apply. Clear a card you have already recovered (or decided to drop) without changing the live features; after a successful re-apply you can clear it in one step.

## 2026-10-27 - Copy ArcGIS FeatureServer layers into a data layer
On an ArcGIS service item, **Copy selected layers to data layer** pulls the checked FeatureServer layers into a new portal data layer (WGS84). The live pointer stays; copies stop at 50,000 features. MapServer-only URLs are refused unless a FeatureServer twin exists.

## 2026-10-27 - Import File Geodatabase into an existing layer
On a data layer's Import features control, drop a `.gdb.zip` (or `.gdb`) and the portal stages it with server GDAL the same way the create wizard does. If the archive has more than one layer, pick which source layer to load; a background import job fills the sublayer.

## 2026-10-27 - Re-apply sync conflicts on the Android field app
When an offline edit on Android loses to someone else's change, the rejected queue row now offers **Re-apply** next to Discard. Confirm compares your queued edit to what the server has now; updates overwrite, deletes remove, and a missing feature can be recreated.

## 2026-10-27 - Service connection editors follow your language
When you edit a connected service, ArcGIS service, or OGC (WMS/WFS) service, the Probe, layer selection, and Save chrome now follow the language you pick in the user menu (Spanish, French, German, or Brazilian Portuguese).

## 2026-10-27 - Clip a layer from Analyze without leaving the tab
On a data layer's Analyze tab, **Clip this layer** lets you pick another data layer as the cookie-cutter and creates a derived layer that runs the clip on PostGIS. Same honest server path as Buffer; not an instant in-browser result.

## 2026-10-27 - Open public rasters from QGIS with STAC
In QGIS 3.42 or newer, open Data Source Manager, pick STAC, and connect to your portal's `/api/public/stac` URL to browse published rasters without installing the GratisGIS plugin. Private rasters stay off that public catalog.

## 2026-10-27 - Form response-sharing reminder follows your language
The notice above the form designer that explains how form sharing differs from who can see submitted responses now follows the language you pick in the user menu (Spanish, French, German, or Brazilian Portuguese).

## 2026-10-27 - Faster offline refresh on the Android field app
Taking a collection offline again on Android now downloads only what changed on each layer when a previous download left a sync cursor, instead of pulling the whole layer every time. The first download is unchanged.

## 2026-10-27 - Buffer a layer from Analyze without faking meters
On a data layer's Analyze tab, **Buffer this layer** opens a short distance and unit form and creates a derived layer that runs the buffer on PostGIS. The in-browser SQL builder still refuses meter buffers (no PROJ in that engine), so this is the honest path instead of a degree-unit trap.

## 2026-10-27 - See PostGIS tables before you save a connection
When you connect a live PostgreSQL + PostGIS database, Test connection now lists the geometry tables it found (with SRID and a rough row count) so you can confirm the schema before Save.

## 2026-10-27 - Offline edits check for conflicts before they upload
When the field app syncs edits you made offline, it asks the portal whether an update or delete would still be accepted before it applies the change. If someone else already changed that feature, or the values break the layer's rules, the edit stays on the device with the reason instead of partially uploading.

## 2026-10-27 - Download markup as GeoJSON
Open the Markup panel and click **GeoJSON** on a set to download its sketches as a FeatureCollection. Works for any set you can see — handy for dropping redlines into QGIS or emailing a file without promoting to a data layer.

## 2026-10-27 - Re-apply a sync conflict from the layer panel
When a sync conflict shows on a layer's data panel, editors can re-apply the losing edit after a confirm that compares losing vs current. Updates overwrite the live feature, deletes remove it, and a missing feature is recreated from the losing side.

## 2026-10-27 - Anonymous markup on public maps
Map editors can allow signed-out visitors to add their own markup on a public map (off by default). Guests edit only the sets they created in that browser; promoting a set to a data layer still requires signing in.

## 2026-10-27 - Faster offline refresh in the field
Refreshing a cached field deployment now downloads only what changed on each layer, instead of pulling the whole layer again. The first download is unchanged; later refreshes are quicker on big layers and weaker connections.

## 2026-10-27 - Reorder form questions on a phone
The form designer now has up and down arrows on every question row, so you can reorder on a phone or tablet where drag-and-drop does not work. Desktop still has the grip handle for drag reorder.

## 2026-10-27 - More of the chrome follows your language
Error screens, form submission receipts, and the "3D ground ready" chip on maps now follow the language you pick in the user menu (Spanish, French, German, or Brazilian Portuguese), alongside the chrome that already translated.

## 2026-10-27 - Cite a public item in BibTeX, RIS, or JSON-LD
Open a public item's Metadata tab and download a citation for your bibliography. BibTeX, RIS, and Schema.org JSON-LD are available from the same Cite menu, and the same files are at the public API for scripts and harvesters.

## 2026-10-27 - Markup that draws, prints, and promotes
Shared maps now take lines, polygons, text labels, arrows, and circles in addition to pins. Promote a markup set into a private data layer when the redline is ready to become real GIS data. Visible markup also lands on the printed PDF, so the sheet matches what reviewers saw on screen.

## 2026-10-27 - Comments pinned to a place
Open a comment thread on a selected feature or markup sketch. Open threads show as pins on the map; click one to jump straight into that conversation.

## 2026-10-27 - Summarize elevation inside your zones
On an elevation layer, pick a polygon data layer and run zonal statistics. GratisGIS writes a new layer with mean, min, max, sum, and count for the raster cells inside each zone (when server-heavy analysis is enabled on the portal).

## 2026-10-27 - Catch edits that lost a sync race
When two people change the same feature and one save loses the optimistic check, the losing edit is kept as a sync conflict on the layer. Open the layer's data panel to review those conflicts after a field or QGIS sync instead of wondering what disappeared.

## 2026-10-27 - Find the portal from QGIS MetaSearch
Point MetaSearch at the public OGC Records catalog and searchable catalogue collections show up with a GeoJSON enclosure for Add Data. Public themes also use curated DCAT / Aardvark theme values so harvest tools get a clean theme facet alongside free-form keywords.

## 2026-10-27 - Demo database stays on the proven Postgres line
A release that tried to jump the demo host to Postgres 18 without migrating the existing data volume was rolled back. The portal keeps running on Postgres 17 until a planned dump-and-restore upgrade is ready.

## 2026-10-27 - Smarter CSV uploads, and a quieter point-cloud pan
Upload a spreadsheet and the portal looks for coordinate columns, US place names, and addresses it can geocode on your own Nominatim. Huge point clouds keep streaming while you pan, and only redraw when the camera settles, so a 200-million-point cloud no longer freezes the map mid-drag. Much of the portal chrome is also ready for Spanish, French, German, and Brazilian Portuguese when you switch locale.

## 2026-10-03 - Sign-in settings load again
Organization admins can open Sign-in and see work-account methods and the authenticator switch. A map that uses a built-in basemap such as Positron no longer stops the Housekeeping page from loading.

## 2026-10-03 - Phone layouts, and building from a description
Dashboards, maps, and the item filter now fit a phone: indicators sit two across, maps and charts stack, and the filter opens as a sheet instead of running off the screen. You can also describe a layer, map, form, or app, by typing or by voice, and the portal builds it from layers you can already read. Ask a question about a layer you can open, download a PDF receipt of a form response, and import a spreadsheet that only has an address column.

## 2026-10-03 - A quieter frame, and an optional writing assistant
The portal chrome is now a cool chart sheet, so the map stays the loudest thing on the page. Organization admins can also turn on a writing assistant (ChatGPT, Claude, Grok, or a model you host) that drafts item text from the title, description, and field names. It stays off until an admin saves a key, and the key never comes back to the browser.

## 2026-09-08 - The field app works where the signal does not
Take a photo with no connection, and take it while you are still filling in the record: it stays on the device with the record and uploads once the record itself has landed, and nothing is reported as sent while its photo is still on the phone. Edits the server refuses, because a value breaks the layer's rules or you have lost access to the layer, no longer retry forever or vanish. A red "edits need attention" chip lists them with the reason; fix the value and retry, or discard the edit. Correcting a record you added offline no longer loses the original. And if your data lives in a spreadsheet, the New Data Layer wizard now takes a CSV and finds the coordinate columns itself, whether they are called latitude and longitude, LAT and LNG, or x and y.

## 2026-09-03 - Edit a layer straight from the map
Open a map you can edit and an Edit toolbar appears next to the selection tools, on any layer you have permission to change. Click a feature to drag its vertices, draw a new one and fill in its attributes, or delete one, all without building an editing app first. The attribute table edits inline too, and a Calculate Field option fills a column from an expression. Every save is checked against the layer's rules, so a value the layer would not accept is refused with a plain-English reason. Field edits the server refuses now wait for you with that reason instead of retrying forever.

## 2026-08-19 - Dashboards, without a separate dashboard app
You can now build a dashboard: big-number indicators, charts, tables,
and maps, refreshing on their own once a minute. Start from the KPI
Dashboard or Operations Board layout when you create a web app. The
part worth knowing: these are the same widgets as everything else, so
a dashboard can grow a map, an editing tool, or another page later,
and an indicator can sit in the corner of a map app. There is no
separate dashboard product to get stuck inside. Charts also got a
proper settings panel and now do their counting on the server, so
they stay quick on big layers and show totals for whatever each
viewer is allowed to see.

## 2026-08-19 - Browse your rasters from QGIS, no plugin needed
Newer QGIS (3.42 and up) has a built-in catalog browser, and this
portal now speaks its language. Point it at the portal and your
imagery, elevation, and other raster layers appear with their
footprints on the map, filterable by area and date, ready to load.
Public layers work without signing in; an API key shows everything
you can see, with the usual sharing rules applied.

## 2026-08-18 - Search can find your rasters now
Imagery, terrain, and lidar layers never recorded where on the map
they are, so searching by area quietly skipped them, and zooming to
one from desktop GIS software went to the whole world. Every raster
and point cloud now records its map extent, including ones uploaded
long ago, so area search matches them and zoom-to lands on the data.

## 2026-08-17 - The QGIS plugin reaches 1.0
The official GratisGIS plugin for QGIS is at 1.0, with every flow
tested by hand on a real install, and it is now in the official QGIS
plugin repository: open Plugins, search for GratisGIS, and install.
From inside QGIS you can search the portal, inspect items, publish
vector and raster layers, publish an open project as a portal map,
clone a layer to take into the field, and sync your edits back.
Private layers work throughout: create a read-only API key under
Profile and QGIS sees exactly what you see.

## 2026-08-17 - Private layers open in any desktop GIS
A new signed-in data feed serves every layer you can see, not just
public ones, in the standard format desktop GIS software reads. That
means private and organization layers open as real feature layers
with working attribute tables, using the same API key that already
draws them. Sharing limits still apply to every read. Layers also
report how many features they hold, so client software can pick real
features for small layers and fast tiles for county-scale ones.

## 2026-08-15 - Raster layers draw in desktop GIS too
Layers stored as tile packages or single image files could only be
viewed in the portal itself. The portal now serves plain map tiles
for all of them, so QGIS and similar tools draw them like any other
tile service, with no special support needed. Private layers still
require sign-in. Elevation layers draw as a picture of the terrain;
download the file itself if you need the elevation values.

## 2026-08-10 - Backups you can actually trust
For self-hosted portals: backups now stream straight into the archive
instead of needing twice their own size in free disk, old archives
are cleaned up before every run rather than only after a successful
one, and a backup that cannot fit refuses to start and says how much
space it needs. A running backup can be cancelled. And a new health
check reports the age of the newest archive actually on disk, so a
backup that has been failing quietly shows up immediately instead of
looking fine for weeks.

## 2026-08-08 - Run Python and notebooks on a schedule
The portal can now run your Python for you, on its own, hourly or
daily or monthly. Paste a script or upload a Jupyter notebook, give it
a schedule, and a layer that should be refreshed every month actually
is. Notebooks keep their charts and their explanations alongside the
results, so a job somebody else set up is readable rather than a wall
of print statements. Your administrator has to turn this on.

## 2026-08-08 - A much bigger Python toolkit
The `gratisgis` Python package went from reading and writing features
to most of what you can do in the browser: load a shapefile or
GeoPackage into a layer, export to GeoParquet or CSV, attach and
download photos, create and share layers, compute a field across a
whole layer at once, and run buffers and other geoprocessing on the
server so the data never has to come down to your machine. There is
now proper documentation with worked examples under Help.

## 2026-08-05 - Reading a big layer from a script
Pulling a large layer into a script used to fetch the whole thing at
once, and past a certain size it quietly stopped short, so you could
end up working with only part of your data without being told. Reads
now come back a page at a time, and the Python package handles the
paging for you. Editing the layer while a script reads it no longer
risks skipping or repeating a feature.

## 2026-08-05 - Use your portal from Python
You can now reach the portal from outside a browser. Create an API key
under Profile, then read and write your layers from a notebook, a
script, or a scheduled job on your own machine. A key acts as you, so
it sees exactly what you see, and you can make it read-only in one
click. There is a small Python package to go with it, so pulling a
layer into your own analysis is a couple of lines.

## 2026-08-03 - Terrain at full detail, however big the area
Elevation, hillshade, and height maps used to cap out on large
areas, forcing a coarser resolution. The portal now builds them in
pieces behind the scenes and joins them seamlessly, so a whole
county renders at full detail. And 3D is now a proper on/off
switch: flip to a flat view to check something, flip back, and
your elevation setup is exactly as you left it.

## 2026-08-03 - Many images in, one imagery layer out
Aerial imagery usually arrives as a pile of tiles. Pick them all
in one upload and GratisGIS stitches them into a single seamless
layer, with a time estimate up front and the ability to add more
images later without re-uploading what's already there. Where
images overlap, the newest one wins.

## 2026-08-02 - One map, many elevation surfaces
3D terrain used to mean picking exactly one elevation layer, so a
map spanning two lidar surveys could only extrude one of them.
Terrain is now a stack: add every elevation layer the map needs,
move the best one to the top, and the ground composes itself, even
for areas covered by different surveys. Layers made from a survey also
remember their elevation layer and offer to bring it along when
they join a map.

## 2026-08-02 - Big lidar uploads got dependable
Uploading hundreds of lidar tiles no longer rides on every single
round-trip succeeding: tiles go up a few at a time, transient
failures retry themselves, and if a tile still fails you can retry
just that one or start the merge with what made it. Merges also
tell you up front roughly how long they'll take, and a batch too
big to finish is refused immediately with advice, not hours later
at a timeout.

## 2026-07-26 - The portal tells you what build it's running
The version now shows in the landing page footer and at the bottom
of the user menu, linking to that release's notes. Handy when
reporting a bug: quote the version and we know exactly what you
were looking at.

## 2026-07-23 - Combine lidar tiles into one point cloud
Lidar usually arrives as a grid of tiles. Upload several .laz files
together and GratisGIS merges them into a single seamless point
cloud, with progress as it works. Got more tiles later? Add them to
the existing point cloud from its page and it re-merges, so county
scale coverage can grow as you collect it.

## 2026-07-21 - How tall is everything?
Point clouds can now produce a height-above-ground map: the height
of trees, buildings, and anything else standing on the bare earth,
colored from transparent (open ground) to deep green (tall). One
click on the point cloud's page, and the result is a normal layer
for any map.

## 2026-07-21 - Measure the ground: elevation profiles
Every map now has an elevation profile tool in the toolbar. Draw a
line across the landscape and get an instant chart of the ground
height along it, with the distance, the low and high points, and
the total climb, in feet or meters. Hover the chart and a marker
follows along the line on the map. It works in web apps too: app
builders can drop an Elevation Profile button next to any map.

## 2026-07-21 - See what's visible from a spot
Pick a spot on a map, set a height and how far to look, and
GratisGIS works out exactly which ground can be seen from there,
using your lidar-derived terrain. The answer appears right on the
open map as a green overlay, and it's saved as a normal layer you
can style, share, and reuse. Handy for siting towers and cameras,
checking view protection, or planning an event.

## 2026-07-21 - Contour lines and steepness maps
Elevation layers can now produce two classic map layers on their
own page: contour lines drawn at whatever spacing you choose (with
elevations in both feet and meters, ready for labeling and popups)
and a steepness map that colors the ground from green (flat) to red
(very steep). Both land as regular items you can add to maps,
style, and share like anything else.

## 2026-07-21 - Make the hills stand out
3D maps have a new "height boost" slider under the basemap button.
True scale is honest but gentle terrain can be hard to read; a
little boost makes the shape of the land pop for presentations and
review meetings.

## 2026-07-20 - Just open a map
You no longer need to create a map item before you can look at
something. "Open a map" on the content page starts a blank working
map, and every layer, imagery, and lidar item now has an "Add to
map" button that drops it onto a new working map or any map you
already have. Like what you see? Save it with a name and it becomes
a regular map. Close it without saving and nothing is left behind.

## 2026-07-20 - See your maps in 3D
Maps can now show real terrain. Create an elevation layer from any
lidar point cloud with one click, pick it under the map's basemap
button, and the whole map lifts into 3D: the basemap, imagery,
boundary lines, and labels all follow the actual hills and valleys.
Hold right-click and drag to tilt and look across the landscape.

## 2026-07-20 - Turn lidar into hillshade and elevation layers
Point cloud pages now have an analysis section that runs on your
server in the background. Build a shaded-relief picture of the bare
ground (even under tree cover) or save the ground surface itself as
an elevation layer, watch the progress as it works, and get a
finished layer you can share and drop into any map. The results
also download as standard GeoTIFF files for QGIS and other desktop
GIS software.

## 2026-07-20 - Lidar point clouds inside your maps
Point clouds are no longer viewer-only. Add one to any map like any
other layer, style it per layer (color by elevation or intensity,
pick a color ramp, point size, and see-through level), and combine
it with parcels, imagery, and everything else. Large clouds stream
in as you pan, with a status message while they load.

## 2026-07-20 - Imagery layers in maps
Uploaded imagery and analysis results now go straight into maps as
layers, not just as basemaps. Pick them from the Add layer list,
stack them with your other layers, and fade them with the opacity
slider to compare against what's underneath.

## 2026-07-19 - Build analysis queries without writing SQL
The Analyze workbench now opens with a guided builder: pick fields,
add filters with plain-language operators, group and aggregate,
sort, and apply spatial options like centroids, convex hulls, and
real-meter area or length columns. The SQL it generates stays
visible below and one click away from editing, so you can learn the
language as you go or drop into raw SQL whenever you want.

## 2026-07-19 - Spatial SQL in the browser
The Analyze workbench now loads the DuckDB spatial extension, served
from your own portal. Buffers, intersections, areas, distances, and
spatial joins all run as SQL right in your browser, and saved
results keep real geometry. A new Geometry summary starter shows
each layer's geometry types and extent in one click. Nothing is
sent to the server and nothing is fetched from third-party services.

## 2026-07-17 - Analyze layers with SQL, right in your browser
Every data layer now has an Analyze button that opens a SQL
workbench powered by an in-browser database engine. Preview rows,
profile every column in one click, group and count, or write any
query you like. Queries run entirely on your machine: nothing is
sent to the server, results appear in milliseconds, and it works on
layers of any size your browser can hold. Any result can be saved
as a new private layer with one click, ready to share, map, and
export like anything else in your portal. Spatial functions are
coming next.

## 2026-07-17 - Download permission now covers every export
Layer exports (CSV and GeoParquet) now respect the download
permission consistently: if a layer is shared with you as view
only, the export options are hidden and the server declines bulk
downloads. Viewing maps and browsing attributes work exactly as
before. Owners, org members on org-shared items, and shares that
include download are unaffected.

## 2026-07-17 - GeoParquet import and export
Data layers now speak GeoParquet in both directions. Drop a
.parquet or .geoparquet file into the import wizard to load it as a
layer, and export any portal-hosted layer back out as GeoParquet
from the layer page's Export menu. Exports cover every feature in
the layer (no table cap), keep typed columns and geometry, and open
directly in QGIS, DuckDB, pandas, and other modern data tools.
Exporting requires download permission on layers shared with you.

## 2026-07-17 - A guided sample workspace
New portals no longer start empty. An admin or contributor with a
fresh workspace gets a welcome panel with three starting points,
including one-click sample data: a complete Randolph County, West
Virginia workspace with styled map layers, a derived analysis
layer, an issue-report form with mapped responses, a field survey,
public viewer and explorer apps, and a search tool. The public demo
at gratisgis.org now runs this same workspace, so what you explore
there is exactly what you get at home.

## 2026-07-16 - Dark mode
The portal now follows your system's light or dark preference, and
an appearance picker in the user menu (next to the language picker)
lets you pin light, dark, or system. Every surface, from the items
list to the map editor chrome to toasts and dialogs, renders in
both themes.

## 2026-07-16 - A new look
GratisGIS has a real identity now: the Contour mark (a "G" drawn as
nested elevation contours), a warm paper-and-sage palette across
the whole portal, a matching sign-in page, and a refreshed type
scale that makes small labels easier to read. Dialogs gained
consistent keyboard and focus behavior, and quick actions now
confirm with unobtrusive toast notices instead of blocking popups.

## 2026-07-15 - More of the portal in your language
The items area and every sharing surface (share dialogs, access
tiers, expiry, the trash) now translate into Spanish, Portuguese,
French, and German, roughly 270 new strings per language on top of
the app chrome that already translated. The seed is still machine
translated and tagged "(MT)" in the language picker; native-speaker
fixes are welcome.

## 2026-06-19 - Search finds features by their attributes
The search bar on maps and apps now searches the features inside
portal-hosted data layers, not just layer names. Type an owner,
road name, or facility and matching features appear with a
fly-to-and-highlight on pick. Works for signed-in users and on
public maps for anonymous visitors, wherever a layer's fields are
marked searchable.

## 2026-06-01 - Spanish, Portuguese, French, German seed translations
The four non-English catalogs are now seeded across every
already-wired UI key, so the menu items, dialogs, and other
strings the portal currently translates render in your chosen
language. The seed is a machine-translated pass and the locale
picker tags it "(MT)" so you know to expect rough edges; native
speakers, please open a pull request fixing anything that
sounds wrong (the picker now links to the contributor guide).

## 2026-06-01 - Pick your portal language
A language picker now lives in the user menu in the top-right.
Five languages are available: English, Spanish, Portuguese
(Brazil), French, and German. Your pick is remembered across
sessions. The translation coverage is still small (the picker
shows each language's completeness), so most of the UI still
renders in English for now; the navigation menu and Print this
map dialog are translated as a start, and contributions extend
the rest as the catalogs fill in.

## 2026-06-01 - Live PostgreSQL: any projection, no raw SQL filtering
Two upgrades to live PostgreSQL + PostGIS layers. First, tables in
any spatial reference system PostGIS knows about now render
without needing to be in WGS84: the portal reprojects on the
server with the GiST index still in play. Second, the layer
filter you already use on any other map layer (column / operator
/ value rows) is now translated to safe parameterized SQL on the
PostgreSQL side, so the database only sends back the rows that
match. The raw SQL escape hatch is still there for power users.

## 2026-06-01 - Clip and erase by another layer
Two new analysis steps. Clip cookie-cutters your features by
another layer so only the parts inside survive (handy for "this
dataset, but only inside this district"). Erase is the inverse,
so you get only the parts outside (handy for "everything except
this exclusion zone"). Attributes pass through unchanged on
both. Add either from the toolbox in the derived-layer
builder under "Compare with another layer."

## 2026-06-01 - Print PDFs match the map you're looking at
The printed PDF now paints layers with the same colors and labels
as the on-screen map: unique-value renderers, class-breaks, time-
bins, and text labels all carry through, not just the simple
fill / outline colors. The bound map's own basemap renders in the
PDF too (raster, PMTiles, and Cloud-Optimized GeoTIFF), instead
of vanilla OpenStreetMap. When the print Map element has a fixed
scale set, the PDF honors that scale.

## 2026-05-31 - Print scalebar + north arrow read the actual map
The scalebar on a print layout now computes its bar length from
the bound map's center latitude and zoom and labels itself with
a real distance (m / km / ft / mi) rather than a placeholder.
The north arrow rotates to keep north up regardless of how the
map is oriented. ArcGIS REST and live PostGIS data layers now
paint into the print PDF too, alongside data-layer sources.

## 2026-05-31 - Sharper print maps + real layer-bound legend
The print pipeline now renders maps inline rather than via an
embedded frame, so vector layer data paints as path primitives
in the PDF instead of an embedded raster. Layer-bound legend
elements show the bound map's actual visible layers, with a
swatch per layer that matches the layer's style. Private maps
and private templates render too (previously the preview only
worked for publicly-shared items).

## 2026-05-31 - Print PDFs render the real layout
The server-side print path now reads the print template's actual
layout: title text and parameter bindings, image elements, lines
and rectangles, scalebars and north arrows all render at the
right paper size, with the right fonts and colors, in the right
positions. Map frames embed the calling map; the layer-bound
legend lands next.

## 2026-05-31 - Better-quality print PDFs
The print pipeline now has a server-side render path. Instead of
relying on the browser's print dialog, the portal renders the
layout in a headless browser running on the server and returns a
vector-fidelity PDF. Text stays selectable, lines stay vector,
multi-page layouts come out clean. Phase 2.1 finishes wiring the
existing print designer's layout elements into the new pipeline.

## 2026-05-31 - Multi-language foundation in place
The plumbing for translating the portal into other languages
just landed. Five locales are on the supported list (English,
Spanish, Portuguese for Brazil, French, German); for now the
non-English catalogs are empty and fall back to English, but
the runtime, the Accept-Language negotiator, and the
contributor guide are ready. Help us translate at
CONTRIBUTING-TRANSLATIONS.md.

## 2026-05-31 - Point a map at a live PostgreSQL + PostGIS database
A new connection type lets you register a live PostGIS database
and render its tables on maps without copying the rows in. Every
viewport move issues a bounding-box SELECT directly against your
database; the GiST index does the spatial work. The password is
stored encrypted and never reaches the browser. Bring your own
warehouse, no data migration needed.

## 2026-05-31 - Print this map, one click away
A Print button in the map editor opens a chooser: create a new
print layout pre-bound to this map, or pick an existing layout
to print with. The Map, Legend, Scalebar, and North arrow auto-
bind to the calling map so you skip the manual wiring. Higher-
fidelity PDF rendering lands next.

## 2026-05-31 - Workflows: analysis as a connected graph
The analysis engine now understands a workflow as a graph of
connected steps, not just a straight line. One result can flow
into multiple downstream steps, and multiple results can
converge. Existing tools keep running unchanged; new node
kinds and the visual graph editor land in the next phase.

## 2026-05-30 - Plug your portal into AI assistants
A small MCP server ships with the project so MCP-compatible
desktop AI tools can read your items and layer features
directly. List items, fetch metadata, read features as
GeoJSON, all gated by your normal portal permissions.

## 2026-05-30 - Smart CSV uploads
Drop a CSV with latitude and longitude columns and get a
mapped layer in one step. Sloppy column names like "LAT" or
"x_coord" are auto-detected. Tab and semicolon delimiters,
UTF-8 BOM, and European decimal commas all just work.

## 2026-05-30 - See who else is on the map
Avatar chips at the top of the map canvas show every viewer
who currently has the map open. Each person's cursor renders
as a colored arrow with their name so a teammate over a video
call can point at something without giving you coordinates.

## 2026-05-30 - Conversations on a map
Threaded comments scoped to a map. Open a thread, reply,
resolve when answered. Anyone who can view the map can join
the conversation. Comment authors can edit their own posts
for 15 minutes; map editors can clean up at any time.

## 2026-05-30 - Map markup and redlining
Anyone who can view a shared map can drop colored pins on it
to flag issues, without needing edit permission. Each
reviewer's markup gets its own distinct color so multiple
people's notes don't blur together. The classic "manager
opens the map, flags three parcels, ships the URL back to
the team" workflow.

## 2026-05-24 - Query OpenStreetMap from your tools
Build tools that ask OpenStreetMap for things in the real world.
Pick "Gas stations" or "Restaurants" (or any of ~1,600 other
categories), draw an area on the map, optionally add a filter
like "brand = Citgo", and matching features show up on top of
your map with proper attribution. No coding required.

## 2026-05-24 - Custom tools for web apps
Build your own buttons inside a web app that run on-demand actions on
the map. A "Select By Location" starter is ready to drop in: click it,
draw an area, pick a relationship, and the matching features light up.

## 2026-05-24 - Better map symbols
Choose from 150+ professional point symbols (or upload your own SVG).
Line and outline styles now support dashes, dots, and rounded corners
to match the look of paid GIS tools.

## 2026-05-22 - Smoother imports from ArcGIS Online
Pull layers, maps, and files over from AGO with live progress
feedback and a cancel button. Large org migrations no longer time
out silently.

## 2026-05-13 - Designer-driven thumbnails
Item thumbnails are built from a small visual designer you can
re-open and tweak any time. Renaming or changing colors regenerates
the thumbnail automatically.

## 2026-05-08 - Save and load Web Map JSON
Export a map's full setup (layers, styling, viewport) as a standard
JSON file. Import the same file later or share it with someone else
to reproduce the map exactly.

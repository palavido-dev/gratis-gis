# Changelog

All notable changes to GratisGIS are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The
versioning policy, including what counts as a breaking change before
v1.0.0, is in [docs/VERSIONING.md](./docs/VERSIONING.md).

## [0.9.90] - 2026-08-25

### Fixed

- **The attribute table's new relate actually narrows.** v0.9.89's
  endpoint validated the relate, authorized it, and then dropped it
  in a forwarding wrapper, answering with the whole layer. Caught
  by a negative control minutes after deploy; the forwarding
  contract test now covers the new keys.

## [0.9.89] - 2026-08-25

### Added

- **A dedicated Filter widget for dashboards.** A dropdown or chip
  row of one field's values (with live counts); picking one narrows
  every widget on the page, exactly as clicking a chart bar does.
  The option list comes from the same server aggregate the charts
  use, so it respects the viewer's sharing scope.
- **Starting a Custom Web App now offers a map.** Create an empty
  map named after the app, or pick an existing one; an existing
  map's data layers become the app's data sources immediately, so
  the first chart has something to read.

### Fixed

- **The attribute table now honors the full source scope.** A
  layer's authored filter, the "follow this map" viewport, the
  relate to a parent layer, the page's cross-filter selection and
  the time slider all reach the table's rows now; before, the one
  widget that lists rows was the one that ignored most of what
  narrowed them. Anonymous viewers get the table too: the endpoint
  behind it gained a public mirror.
- **Picking a map for an app promotes its layers to data sources
  automatically.** No more re-adding each layer by hand in the
  Layers panel before anything is chartable.

## [0.9.88] - 2026-08-24

### Added

- **A group's page now shows what is shared with it.** A new
  "Shared with this group" section lists every shared item the
  viewer can see, with the item's type, owner and the permission
  the group holds, a link to the item's detail page, and (for the
  item's owner or an org admin) a one-click remove that revokes
  the group's access without touching the item.

## [0.9.87] - 2026-08-24

### Changed

- **A dataset's Data and Structure are now separate tabs.** The Data
  tab holds importing, browsing and analyzing rows; the new
  Structure tab holds the layer and field builder, the event-layer
  wizard and the schema save. Both share one unsaved draft, so a
  layer added in the builder is immediately available in the Data
  tab's import picker, and switching tabs never discards an edit.
- **The Housekeeping page now uses tabs too.** Review (stale and
  expiring things, storage, maintenance actions), Cleanup (broken
  references, orphaned uploads), Starters (app templates and
  themes) and Schedule, instead of six cards in one long scroll.
  Selections and dialogs survive switching tabs.

## [0.9.86] - 2026-08-24

### Fixed

- **Deleting an offline area, or the whole deployment, now cleans up
  its prepared map files.** Previously the built archives stayed in
  storage forever, and rebuilding an area stacked a new archive next
  to the old ones. The database now enforces the link between
  packages and their item, superseded builds are pruned, and the
  nightly refresh sweep checks all deployments in one query instead
  of one query per area.

### Changed

- The item page tabs, the metadata panel and all of the offline map
  surfaces now go through the translation catalog instead of
  hardcoded English, so the four non-English locales can pick them
  up.
- The stats strip on a dataset's item page refreshes when a layer's
  fields change, not only when the item itself is saved.

### Docs

- `PORTAL_BASEMAP_PMTILES_URL`, the optional mirror for the vector
  basemap the offline builder clips from, is now documented in both
  env examples. The URL must not carry credentials; it appears in
  worker logs.

## [0.9.85] - 2026-08-24

### Fixed

- **The Layers panel in the field now actually shows the layers.**
  The list had been squeezed out of view by the sections above it
  (basemap, detail pickers, download, prepared maps) as those grew;
  on a phone the panel could show everything except the thing it is
  named after. The layer list now comes first and the whole panel
  scrolls as one.

## [0.9.84] - 2026-08-24

### Fixed

- **The downloaded offline map could go blank on maps that also carry
  an imagery or tile overlay.** Toggling a layer was enough to
  disconnect the map from the downloaded file. Found in the weekly
  code review before it was ever hit in the field.
- **Every prepared area now downloads, not just the first.** A
  deployment split into areas for different crews previously claimed
  all areas were included while only fetching one.
- **The offline panel no longer warns that the basemap will not work
  offline when a prepared map is about to make it work offline.**
- **Server error messages from a failed map build no longer include
  the address the server fetched from**, which for self-hosted
  installs can contain access credentials. Only the hostname is kept.

## [0.9.83] - 2026-08-24

### Fixed

- **The "Download for offline" button in the top menu could still
  fetch map tiles one at a time**, while the same button in the
  layers panel used the prepared map. Which one you got depended on
  what you had tapped earlier in the session. Both now use the
  prepared map.
- **Changing the detail level before downloading is no longer
  ignored.** The download used the range you had set previously, not
  the one on screen.

## [0.9.82] - 2026-08-24

### Fixed

- **The prepared map is now part of "Download for offline", not a
  separate control.** It was added only to the layers panel, so the
  download button most people use kept fetching map tiles one at a
  time. There is one download again, and when your team lead has
  prepared an area it uses that instead.
- **A download in progress can be cancelled.** The only button was a
  disabled "Working...", which left no way to stop a large download
  short of closing the tab. Anything already saved stays on the
  device.
- **The offline panel could show nothing at all**, on devices that
  support it, with no error to explain why.

## [0.9.81] - 2026-08-24

### Added

- **Offline maps for field deployments are now prepared once, on the
  server.** Taking a deployment offline used to mean each collector's
  device fetching map tiles one at a time. For a county-sized area
  that is over a million requests and tens of gigabytes, and it is
  aimed at map servers whose terms do not allow it. The portal now
  prepares a single map file per area, typically under ten megabytes
  for the same ground, and everyone on the crew downloads that.

  Set areas up on a field deployment under **Offline areas**. The
  extent comes from the deployed map, so the only choice is how much
  detail to keep, with the download size shown before you commit.
  Areas can rebuild themselves weekly, monthly, or not at all.

  In the field, the layers panel lists the prepared areas with their
  size and a Download button. Once downloaded the map draws with no
  signal at all, including street names, and nothing is fetched from
  the internet to render it.

## [0.9.80] - 2026-08-24

### Fixed

- **A small scrollbar appeared over the last item tab.** The tab row
  can scroll sideways when there is not enough width for every tab,
  and a one pixel detail of the underline was enough to make it think
  it could scroll downward too. The row no longer scrolls vertically.

## [0.9.79] - 2026-08-24

### Changed

- **Item pages are now organised into tabs.** Every item has Overview,
  Metadata and Access; a dataset also gets Data and Source. Sharing
  used to sit at the bottom of a single long column, which on a
  dataset meant scrolling past a map, a statistics strip, a source
  panel, a field list, a version history and a schema builder to reach
  it. Links that pointed at the sharing section still work and now
  open the Access tab.

### Added

- **A Metadata tab that shows what an item actually records.** The
  description and tags used to hide inside a collapsed strip, and the
  license, creation date, source file, source format and original
  projection were not shown anywhere. They now sit in a details column
  alongside the item's identifier and, for a dataset, the storage
  reference for each layer, both copyable in one click. Anything the
  item has not recorded says so rather than showing a guess.

## [0.9.78] - 2026-08-24

### Fixed

- **A basemap that failed to load could stay blank permanently.** If a
  basemap provider refused a request, for instance after rate
  limiting a large offline download, the refusal was stored as though
  it were a map tile and served from then on, leaving a blank map with
  nothing to indicate why. Failed responses are no longer stored, and
  this update clears any that were already saved on your device.

## [0.9.77] - 2026-08-23

### Fixed

- **The Add button in the field no longer appears when there is
  nothing to add.** In a deployment whose layers are all view-only,
  the round + button still appeared and did nothing when tapped. It
  now only appears when something can actually be collected, and when
  nothing can, the map says so and points at the setting that
  controls it.

## [0.9.76] - 2026-08-23

### Fixed

- **Offline downloads no longer pre-fetch basemaps that forbid it.**
  Downloading an area used to pull every basemap tile in view at
  every zoom, and most basemap providers, including OpenStreetMap and
  Carto, explicitly prohibit that and block deployments that do it.
  Your data, forms and any basemap you host yourself still download
  as before; when a basemap cannot come along, the download panel now
  says which provider and why instead of leaving you with a blank map
  in the field. Tiles you have actually looked at are still cached,
  which is both allowed and expected.

## [0.9.75] - 2026-08-23

### Added

- **Field deployments are now findable.** There is a "Field" entry in
  the sidebar, opening the list of everything set up for field
  collection, with what each one has cached offline and how many edits
  are waiting to sync. The page already existed; nothing linked to it,
  so you had to know the address.
- **Point your phone at the screen to open a deployment on it.** A
  deployment's page now shows a QR code alongside its link, because
  field collection is the one thing you set up at a desk and need in
  your hand outdoors. The link is also there to copy if you would
  rather send it.

## [0.9.74] - 2026-08-22

### Fixed

- **The back arrow now leaves the builder.** In the viewer, app
  designer, editor, form designer, map editor and print template, the
  arrow at the top left pointed at the page you were already on, so
  clicking it did nothing. It goes back to your items.

## [0.9.73] - 2026-08-22

### Fixed

- **Long item titles are no longer cut off.** The title shared a line
  with the labels beside it and lost its ending to an ellipsis, so the
  one thing that tells you which item you are looking at was the part
  that got shortened. It now has the line to itself and wraps.

## [0.9.72] - 2026-08-22

### Fixed

- **The new dataset preview no longer resets while an import is
  running.** The page reloads itself every few seconds to update the
  import progress, and each reload was rebuilding the map from
  scratch, throwing away wherever you had panned or zoomed to. It also
  now follows its container when the surrounding panels change width
  instead of waiting for the whole window to be resized.

## [0.9.71] - 2026-08-22

### Added

- **A dataset page now opens with a live map of the data instead of
  nothing.** Multi-layer datasets, which are what the importer has
  produced for months, had no map and no numbers anywhere on the page:
  the preview and the feature count only ever existed on the older
  single-layer path, so the newer datasets were the poorer ones. The
  preview is pannable and draws the same tiles the map editor draws,
  which means it shows exactly the rows you are allowed to see.
- **Six figures under the preview**: features, shape, coordinate
  system, fields, layers, and when it last changed. The feature count
  is counted at the moment you look, not read from a number stamped at
  import time, so it stays right after edits and is correct for
  viewers limited to part of the data. If the count cannot be reached
  it says so rather than showing a number that might be wrong.
- **The pills under a title now say what the dataset is made of**,
  adding shape and license next to the type and who can reach it, and
  spelling out access in words rather than showing the stored value.

## [0.9.70] - 2026-08-22

### Fixed

- **Visitor stats had recorded nothing since 19 August**, bot traffic
  included, and the three missing days are now recovered rather than
  lost. The collector bookmarked each access log by inode. Log
  rotation hands the same inode straight back out to the next file, so
  a new log arrived carrying the previous one's bookmark: usually a
  read position past its own end, which made it look permanently
  caught up. Logs are now identified by their contents, so a reused
  inode is recognised as a different file.
- **Traffic totals before that date were roughly a fifth too high.**
  The same bookmark confusion, in the other direction, re-read a log
  the collector had already stored and counted every line in it twice.
  35,849 duplicated requests have been removed, and a request already
  recorded can no longer be recorded a second time, so re-reading a
  log is now free.

## [0.9.69] - 2026-08-22

### Fixed

- **Counters and charts on related records now answer in under a
  second**, down from twelve. Together with v0.9.68 that takes the
  water quality dashboard's "Measurements taken there" from a request
  that timed out to one that lands before you notice. A filter that
  matches only a handful of records is a couple of hundred
  milliseconds slower, which is the trade: a predictable ceiling
  instead of a fast best case and no ceiling at all.

## [0.9.68] - 2026-08-22

### Fixed

- **Counters and charts built on related records answer in about a
  second.** They took forty, which is past the server's limit, so
  clicking a chart left them showing their previous number with
  nothing to say the request had failed. On the water quality
  dashboard that is "Measurements taken there", which sat unchanged
  while everything around it filtered.

## [0.9.67] - 2026-08-21

### Changed

- **The labels zoom range moved to the Labels tab**, where you would
  look for it. It was sitting under Style with the layer's own zoom
  range, because the two are stored together.

## [0.9.66] - 2026-08-21

### Changed

- **A layer's actions get their own tab.** Whether people can select
  a layer, highlight it on hover, search it, or edit it in the field
  were all sitting at the bottom of the Popup tab, below a list of
  popup fields long enough to hide them. They are their own tab now.
  Popup keeps its two on/off switches, moved above the field list so
  you can answer "does a popup appear" without scrolling past what it
  would say.

### Fixed

- **The settings column lines up with the layer list.** It started a
  header's height too low, so the two columns stepped down beside
  each other instead of sharing a top edge.

## [0.9.65] - 2026-08-21

### Changed

- **Layer settings open in a column beside the list.** Click a layer
  and its settings appear to the right, with the layer's name and
  what kind of layer it is at the top. They used to expand underneath
  the row, which pushed every layer below it down the page and put
  the list and the thing you were editing in different places.

## [0.9.64] - 2026-08-21

### Fixed

- **Reverted the aggregate change from v0.9.63**, which made counters
  on related records slower rather than faster. Anyone on v0.9.63
  should take this one. The speedup from v0.9.62 is unaffected.

## [0.9.63] - 2026-08-21

### Fixed

- **Counters and charts built on related records answer in about a
  second.** They took eight to fourteen, and clicking a chart pushed
  them past the server's limit, at which point the widget quietly
  kept its previous number. On the water quality dashboard that is
  "Measurements taken there", which used to sit unchanged while
  everything around it filtered. A filter that matches only a handful
  of records is now marginally slower, which is the trade: a
  predictable ceiling instead of a fast best case and no ceiling at
  all.

## [0.9.62] - 2026-08-21

### Fixed

- **Counters built on related records are fast now, and correct.**
  A widget that counts one layer through its relationship to another
  took twenty-three seconds on every map move, and clicking a chart
  pushed it past the server's limit, at which point it quietly kept
  showing its previous number. The same reading now takes under a
  second. On the water quality dashboard that is "Measurements taken
  there", which used to sit unchanged while everything around it
  filtered.

## [0.9.61] - 2026-08-21

### Changed

- **Layer settings are tabs.** Style, Labels, Filter and Popup,
  instead of six collapsible sections stacked in one column where
  reaching the last one meant scrolling past all of the first. Zoom
  range moved under Style, and the popup on/off switches moved back
  beside the popup content they belong to.
- **A legend can carry a title.** Give it one and it says what the
  colours are showing before the reader gets to a single swatch.
  Leave it blank and the panel is headed "Legend" as before.

### Fixed

- **The app designer shows your widgets instead of errors.** Counters
  read "No layer bound" in red and charts read "No target" on apps
  that were correctly set up and ran fine, because the canvas gave
  each widget only half of what it needs to find its data. Legends
  and layer lists drew grey boxes rather than their real contents.
  All of them now render on the canvas the way they will on the page,
  which is the whole point of laying a dashboard out visually.

## [0.9.60] - 2026-08-21

### Fixed

- **The map really does narrow on related records now.** v0.9.59 said
  it did. The filter was read, checked and then dropped one layer
  short of the database, so the map drew every feature and reported
  success. Anyone on v0.9.59 should take this one.

## [0.9.59] - 2026-08-21

### Fixed

- **The attribute table shows what the map is showing.** It listed
  every row regardless of the filter on the layer, so a filtered map
  sat next to a table that disagreed with it, and the table's own "Use
  selection as filter" button narrowed the map while leaving the table
  alone. Filtering now reaches the table on every kind of layer.
- **A table on a dashboard narrows when you click a chart.** It was
  reading the map's unfiltered layers, so it kept listing rows the map
  beside it had just hidden.
- **The map narrows on related records too.** Click a chart built from
  related records and the map layer drawn from those records now
  narrows with everything else. It used to keep every feature while
  the counters and charts moved, with nothing on screen to say the two
  disagreed.
- **Reading is easier on the landing page.** Every heading and
  paragraph below the top of the page was centred, which makes long
  copy hard to follow because the eye loses the left edge on each
  line. It reads left aligned now.

## [0.9.58] - 2026-08-20

### Fixed

- **A tile only says "filtered" when it is.** Clicking a chart marked
  every counter on the page as narrowed, including ones reading data
  the click never touched, so a correct number was captioned as
  something it was not. The caption now follows whether the filter
  actually reached that data.
- **The chart you click keeps its own context.** A chart that
  published a filter against another part of the page could end up
  re-filtering itself through the relationship between them, so every
  bar moved when you clicked one.

## [0.9.57] - 2026-08-20

### Added

- **A chart can filter the map even when it counts something else.**
  A chart built from related records answers a question about the
  things on the map: click "Iron" on a chart of measurements and the
  map can now narrow to the sites where iron was over the limit.
  Previously the click had nowhere to land, because the map's layer
  had no such column.

### Fixed

- **Small bars are clickable again.** A category worth 1 against an
  axis running to 1,000 was drawn thinner than a pixel, so the chart
  invited a click it could not receive.

## [0.9.56] - 2026-08-20

### Fixed

- **The legend now explains the map.** It listed one entry per layer,
  repeated once for every widget reading that layer, and drew
  everything as a dot, so rivers and county boundaries looked like
  points and a layer coloured into three classes appeared as a single
  unexplained row. Classified layers now list each class with its own
  label and colour, and each swatch is drawn as the shape the layer
  actually draws.

## [0.9.55] - 2026-08-20

### Fixed

- **A form can no longer be made impossible to submit.** Six question
  types were offered in the designer that nobody could actually
  answer, and marking one required blocked the whole form with no way
  out. They are greyed in the palette now, say so at the top of the
  form, and never block a submission.
- **Controls that did nothing are gone.** The viewer's Query tool
  shipped switched on with no query control anywhere; the editor's
  snapping panel had a self-snap checkbox and a tolerance slider that
  changed nothing at any setting. Report template is no longer
  offered when creating an item, because there is no editor for one.
- **Importing related records into a table works.** A layer with no
  geometry is a supported shape, and importing into one used to
  insert nothing and report success.
- **Emptying orphaned uploads reclaims what it should.** A finished
  analysis job kept its input files alive forever, so every merge an
  org ran permanently doubled its storage. One finished job on the
  demo was holding 16 GB.

### Changed

- **Charts colour their bars per category**, and can be given an
  explicit colour per category so a chart carries the same meaning as
  the map beside it.
- **Text widgets stop honouring the line breaks in your source.** A
  paragraph typed wrapped at 72 characters rendered as a narrow
  column no matter how wide the widget was.

## [0.9.54] - 2026-08-20

### Fixed

- **An app no longer draws its own unstyled copy over your map.**
  When a dashboard's data source pointed at a layer the bound map
  already showed, the app added a second copy on top with default
  styling, so carefully classed symbology rendered as one flat
  colour. The copy also downloaded the whole layer instead of
  streaming tiles, which is what made a large dashboard slow to
  settle.

## [0.9.53] - 2026-08-20

### Added

- **Charts can show a distribution.** Point one at a measurement
  column and it used to draw one bar per distinct reading. Now it can
  group the numbers into ranges: a set number of bars, a fixed range
  size, or ranges you name yourself so the chart cuts where your map's
  classes do. Clicking a bar filters the page to that range.
- **Reference lines on charts.** Draw a limit, a target, or a
  threshold across a chart, with a caption. A measurement chart is
  only readable against the standard it is being compared to.

### Fixed

- **Public apps no longer get whole-layer numbers from a related
  chart.** A chart scoped through a related layer sent that scope
  correctly and the anonymous endpoint quietly ignored it, so the
  numbers described everything instead of the selection. Nothing on
  screen said so.
- **The landing page centres what you feature.** Two or three items
  sat hard left in a four-wide grid with a third of the page empty
  beside them. The layout now follows how many items there are and
  how much room the screen has, and cards stay the same size either
  way.

## [0.9.52] - 2026-08-20

### Fixed

- **Housekeeping now checks the pointers that live in your portal
  settings**, not just the ones inside items. It reported a clean
  bill of health while the Branding page was openly showing two
  "Unknown item" rows in the featured list.
- **A share that lost its boundary is now reported.** When the
  boundary an area-limited share pointed at is deleted, the share
  falls back to no limit, so it quietly grants more than it was set
  up to grant. That was invisible until now.
- **Deleting an item for good cleans up after itself properly.**
  Permanently deleting an item removed it from folders but left it
  pinned to the landing page forever, and emptying the recycle bin
  on schedule cleaned up neither.

## [0.9.51] - 2026-08-20

### Fixed

- **"Auto fill" now works when symbolizing by category.** On portal
  data layers it produced no categories and said nothing, which
  looked like a broken button. It reads the field's distinct values
  from the server, most common first, and tells you when a field is
  empty or has more values than a map can carry.

## [0.9.50] - 2026-08-20

### Added

- **Counters and charts can count distinct values**, not just
  records. "1,480 acidic samples" might be one creek measured
  monthly for a decade; "392 acidic sites" is a map.

### Changed

- **The landing page leads with the live apps.** They were below the
  marketing copy and the whole changelog, so almost nobody reached
  them.

## [0.9.49] - 2026-08-20

### Fixed

- **Housekeeping no longer reports the built-in catalog as stale.**
  Basemaps, themes, and templates that ship with every org are meant
  to sit unused until someone picks one, so they satisfied every
  staleness signal forever and buried anything real.

## [0.9.48] - 2026-08-20

### Fixed

- **Custom apps failed to load in v0.9.47**, showing "Something went
  wrong" instead of the app. v0.9.47 is the only release that carried
  it and it was rolled back within the hour. The prod smoke checks
  now load the published dashboards, so a crash like this fails a
  build rather than a visit.

## [0.9.47] - 2026-08-20

### Added

- **An app's layers are now data sources that carry their own scope.**
  A layer says what it shows: every record, or only what is on a
  given map. Widgets pick a layer and inherit that, so a dashboard's
  pieces agree without setting it on every tile. Managed in a Layers
  panel in the builder.
- **A layer can be scoped through a related one.** A table with no
  location of its own follows a map through its parent: inspections
  are in view when their well is. Whatever narrows the parent narrows
  the child, including a chart click on it.

### Changed

- Widgets bind to a layer by a stable id instead of by position. This
  fixes wrong numbers, not just untidiness: removing a layer, or
  having one fail to load, used to shift every later binding so
  widgets silently answered about a different layer. Existing apps
  convert on open.

### Fixed

- **Auto-refresh can be turned back off**, and the layer picker shows
  layer names rather than a fragment of an internal id.

## [0.9.46] - 2026-08-20

### Added

- **One setting scopes a whole page to a map.** Charts and counters
  inherit it, so a dashboard's pieces agree without setting
  "follow a map's view" on every tile. A widget can still overrule
  it either way. Dashboard starters ship with it on; existing apps
  are unchanged.

### Fixed

- **Clicking a chart now filters the map too.** It narrowed the
  counters and the other charts and left the map showing everything.
- **Auto-refresh can be turned back off.** Setting it to 0 silently
  kept the previous value.
- **The designer no longer calls a working dashboard broken.** A map
  widget said "no map bound" when it was drawing the app's own layers,
  which is how every dashboard is built.
- **The layer picker shows layer names** instead of a fragment of the
  item's internal id.

## [0.9.45] - 2026-08-20

### Fixed

- **A horizontal bar chart labels every bar.** Four of thirteen
  decades came back blank, which defeats the point of the sideways
  layout.

## [0.9.44] - 2026-08-20

### Fixed

- **The clear-filter chip no longer shrinks the chart it belongs to.**
  It moves up beside the caption.

## [0.9.43] - 2026-08-20

### Fixed

- **Chart click filtering had no effect on the numbers.** The filter
  was validated and then dropped before it reached the database, so
  every panel kept showing its unfiltered total. v0.9.42 is the only
  release that carried it.

## [0.9.42] - 2026-08-20

### Added

- **Click a chart to filter the whole page.** Clicking a bar or a
  slice narrows every other panel that reads the same layer: the
  counters recount, the other charts regroup, and the map hides the
  features that are not in it. Click again, or the chip under the
  chart, to put the page back. Each narrowed panel says what it is
  filtered to, because a number that quietly answers a different
  question than its caption claims is worse than no number.

### Fixed

- **Charts and counters now follow the time slider.** Scrubbing back
  moved the map and the table while the numbers beside them stayed on
  today, with nothing on screen to say so.
- **Chart labels no longer collide.** The value axis printed its
  caption over its own numbers, long values ran into each other, a
  horizontal bar's number was clipped on the longest bar, and pie
  percentages were cut off at the top and bottom. Large values also
  print short now (3.8M rather than 3,759,450); the tooltip still
  gives the exact figure.

## [0.9.41] - 2026-08-20

### Added

- **Horizontal bar charts.** A category axis with long names ran out
  of room on a vertical chart and rotated or dropped its labels. The
  same chart on its side reads them left to right at full size.
- **Panels can be expanded to fill the page**, with a second press or
  Escape to put them back. Off by default and set per widget in the
  builder, because a single number gains nothing from a full page
  while a wide table gains a great deal. Expanding is a viewing
  state: a reload returns the layout the app's author published.

### Fixed

- **Charts no longer inherit a scrollbar** from the panel around
  them. A chart always fits its panel, so there was nothing to
  scroll to.

## [0.9.40] - 2026-08-20

### Fixed

- **An app now opens on its own data.** An app built on data layers
  without a saved map behind it inherited the national default
  viewport, so a county dashboard opened at continental zoom and the
  reader's first act was to zoom in. The map now starts framed on the
  layers the app uses. An app that points at a saved map still opens
  where that map says, because that viewport was a deliberate choice.
- **Charts squeezed beside a tall map no longer offer a scrollbar.**
  They shrink to the room they have.

## [0.9.39] - 2026-08-19

### Fixed

- **Indicator tiles no longer grow a scrollbar** when their caption
  wraps to two lines.
- **Large totals print whole.** A summed area showed as
  "798,587.58"; anything past a thousand now drops the decimals
  unless you ask for them.

## [0.9.38] - 2026-08-19

### Added

- **The app builder now shows your data widgets while you lay them
  out.** Indicators, charts, and attribute tables drew a grey
  placeholder box on the design canvas, so building a dashboard meant
  arranging boxes and then opening the app to see what you had made.
  They now render with real data on the canvas, using the same
  components the published app uses, so what you arrange is what you
  get. Map-driven widgets keep their existing previews for now.

## [0.9.37] - 2026-08-19

### Added

- **Charts say what they are showing.** Pie charts now always carry a
  legend, on the right so it fits a dashboard tile, and slices with
  room show their share as a percentage. When a field has a long tail
  of one-off values the smaller ones collect into a single "Other"
  slice that says how many categories it covers, so the chart stays
  readable without hiding anything. Bars now show their value above
  them, and features with no value for the grouping field read "(no
  value)".

## [0.9.36] - 2026-08-19

### Fixed

- **Charts drew their axes and labels but plotted nothing.** On a
  page with a live map the bars restarted their entrance animation
  every time anything else on the page updated, so they never
  finished appearing; they would occasionally fill in once the page
  went quiet, which made it look like slow loading. Charts now draw
  their data immediately.

## [0.9.35] - 2026-08-19

### Fixed

- **Charts squeezed into a dashboard tile could not work out how much
  room they had**, and rendered empty until something else on the
  page resized.

## [0.9.34] - 2026-08-19

### Fixed

- **Charts squeezed into a short tile drew over their own labels.**
  The bars ran past the axis line and through the category names. A
  chart with too little room now scrolls rather than rendering
  something misleading, and the dashboard layouts give their charts
  more height to begin with.

## [0.9.33] - 2026-08-19

Presentation fixes for the dashboard widgets, found by building one
on real data.

### Fixed

- **Indicators no longer print their caption twice.** The tile showed
  its label in the header and again under the number.
- **A pie chart with dozens of slices is readable again.** Grouping by
  a field with a unique value per feature produced a legend that
  swallowed the chart; past a dozen slices the labels move to the
  tooltip.

## [0.9.32] - 2026-08-19

Dashboards, built as widgets inside the web app builder rather than
as an app of their own. No schema changes.

### Added

- **Dashboards.** Two new starting layouts in the web app gallery,
  KPI Dashboard and Operations Board, plus an Indicator widget that
  shows a single number (a count, total, or average) from any layer,
  with its own caption, units, and an optional target to compare
  against. Because these are ordinary widgets, an indicator can sit
  on a map app and a dashboard can grow a map, an editing tool, or a
  second page: a dashboard here is a web app that starts from a
  dashboard layout, not a separate kind of thing you can get stuck
  inside.
- **Charts can finally be configured.** The chart widget shipped
  without a settings panel, so it could not be grouped by a field.
  It now has one: pick the layer, the chart type, the field to group
  by, and what to measure, with the field list read from the layer
  itself.
- **Auto-refresh.** An app can refresh its data on a schedule; the
  dashboard templates come set to once a minute. Refreshing pauses
  while the page is in a background tab, and any single widget can
  be pinned to manual.

### Changed

- **Charts are much faster on large layers, and now respect who is
  looking.** A chart used to download every feature in a layer and
  count them in the browser. The portal now computes the totals and
  sends just the answer, which also means the numbers honour the
  same sharing rules as the features: someone limited to an area, or
  to their own records, sees totals for what they can actually see.
- **The unbuilt "Dashboard" item type is no longer offered.** It
  only ever produced a placeholder page. Anything created that way
  now explains where dashboards live and links to the web app
  builder; nothing else changes.

## [0.9.31] - 2026-08-19

Adds a STAC API and repairs the backup panel's handling of runs whose
process died. Contains one migration (a liveness timestamp on backup
runs); it applies automatically on deploy. On a deployment that
restores its database from a snapshot on a schedule, re-capture the
snapshot after upgrading so the new column survives the next restore.

### Added

- **A STAC catalog of your raster layers.** QGIS 3.42 and newer ships
  a native STAC browser, so the portal's imagery, elevation, and
  other raster layers can now be browsed from stock QGIS with no
  plugin: footprints on the canvas, filtering by area and date, and
  the layer's files and tiles one click away. Public rasters are
  served anonymously; signing in (an API key works) shows every
  raster you can see, with sharing rules applied as everywhere else.
  Searches with filters the server does not support are refused with
  the offender named, never answered with unfiltered results.

### Fixed

- **A backup interrupted by a restart no longer haunts the panel.** A
  backup whose server process died (a deploy or crash mid-run) stayed
  "In progress" forever: it could not be deleted, cancelling it did
  nothing, and no new scheduled backup would start for six hours.
  Running backups now carry a liveness signal, so one that dies is
  closed out as failed within minutes, on its own.
- **The backup panel now offers Stop for a running backup.** The
  server has supported stopping one for a while, but the panel only
  offered Delete, which is refused for live runs; the refusal then
  surfaced as a raw error code instead of the server's explanation.
  Errors now show the actual reason in plain language.
- **Backups whose file no longer exists say so.** A history entry can
  outlive its archive (moved, deleted by hand, or restored from an
  old database snapshot); the panel offered Download and Restore
  anyway, which could not work. Those entries are now labeled and the
  buttons withheld.

## [0.9.30] - 2026-08-18

### Fixed

- **Raster and point cloud items now have a map extent.** Their
  extents were computed at upload and then never copied into the field
  that search and clients read, so geographic search never matched a
  raster, and "Zoom to Layer" on one in QGIS went to the whole world.
  New uploads record it, and existing items are filled in during the
  upgrade.
- **Asking the OGC API for a filter it does not support is now an
  error instead of a wrong answer.** A request with an unsupported
  parameter (for example a date filter) used to return data as if the
  filter had been applied, with no way to tell it had been ignored.
- **The OGC conformance declaration now matches what is actually
  served.** It claimed a catalogue class that does not exist in the
  standard and two tile classes with no matching endpoint; the missing
  per-collection tilesets list now exists, and the invented and
  unsupported claims are gone. Responses also carry the media types
  the documents advertise for themselves (GeoJSON for features,
  Mapbox style JSON for styles, OpenAPI for the API description).

## [0.9.29] - 2026-08-17

### Added

- **Data layers now report how many features each layer holds.** The
  per-layer feature count is stamped after every import and kept
  fresh by the housekeeping extent recompute, which also backfills
  existing layers on its next run. Client software uses it to pick a
  sensible default: the QGIS plugin (0.16.0) opens layers at or
  under 50,000 features as real feature layers with working
  attribute tables, and keeps larger ones on fast tiles.

## [0.9.28] - 2026-08-17

### Added

- **Signed-in access to layers as real features.** A new signed-in
  data feed at /api/ogc serves every data layer you can see, not just
  public ones, in the standard format desktop GIS software reads
  (OGC API Features). In practice: private and organization layers
  can now be opened in QGIS as true feature layers with working
  attribute tables, using the same read-only key that already draws
  them. Everything you are limited to stays limited: geographic
  limits on shares and own-rows-only scoping apply to every read,
  including single-feature lookups.

## [0.9.27] - 2026-08-15

### Added

- **Every raster layer can now be drawn by desktop GIS software.**
  0.9.26 did this for layers stored as a tile package. Layers stored
  as a single image file were still left out: the file is served
  whole, and the only way QGIS could read one was to open it over the
  network itself, which hangs QGIS outright whenever a saved project
  containing such a layer is reopened. The portal now serves map tiles
  for these layers too, off the same address as the others, so a
  desktop map draws them like any other tile service and nothing has
  to open the file.

  Elevation layers are included, and are drawn as a grey picture of
  the terrain. Download the file itself if you need the elevation
  values for analysis.

  Which kind of file backs a layer is worked out per request, so a
  desktop map saved while a layer was still being converted keeps
  working after the conversion finishes.

## [0.9.26] - 2026-08-14

### Added

- **Tile layers can now be drawn by desktop GIS software.** Layers
  stored as a tile package could only be viewed in the portal itself:
  the file is served whole, and QGIS has no way to read that particular
  package format, so those layers could not be added to a desktop map
  at all. The portal now serves their individual map tiles directly, so
  QGIS and similar tools can draw them like any other tile service.
  Private and organization layers still require sign-in, and public
  ones stay public.

### Fixed

- **A tile package uploaded directly could not be served.** Only
  packages the portal built itself were reachable; one supplied ready
  made resolved to nothing and returned "not found". These now serve
  correctly, without loosening who is allowed to see them.

## [0.9.25] - 2026-08-13

### Fixed

- **A notification stranded mid-send is now rescued even while email
  delivery is down.** The recovery from 0.9.23 only ran while the mail
  server was reachable, but a send is most likely to be interrupted
  exactly when mail is flaky; a stuck message is now requeued regardless
  and simply waits for delivery to come back.

## [0.9.24] - 2026-08-13

Fixes a build break in the 0.9.23 test suite that turned CI and the
image scan red (a strict-mode type error in a new unit test; no runtime
change). 0.9.23 was never deployed; deploy 0.9.24 instead.

## [0.9.23] - 2026-08-13

Worker crash recovery. Adds one migration (two nullable timestamp
columns); applied automatically on deploy.

### Fixed

- **A crashed import or interrupted notification no longer strands
  forever.** If the server was interrupted partway through an ArcGIS
  Online migration, the import wizard would spin indefinitely; the job
  now times out and reports that it stopped, so it can be started again.
  Likewise a notification whose send was interrupted mid-flight used to
  get stuck invisibly; it is now automatically requeued (or, once its
  retries are spent, marked failed) and can be retried from the admin
  screen.

## [0.9.22] - 2026-08-13

Upload-size hardening. No schema changes.

### Fixed

- **Upload size limits are now enforced by the server, not just
  advised.** A presigned upload returned a size cap that the browser was
  trusted to honour, so a determined authenticated user could upload an
  arbitrarily large file, including into the small public prefixes
  (avatars, hero images, thumbnails) that are never garbage-collected,
  exhausting storage. The server now refuses an over-cap upload and signs
  the size into the upload URL, so the storage backend rejects anything
  larger.

## [0.9.21] - 2026-08-13

Memory-safety fix for large uploads. No schema changes.

### Fixed

- **A large file upload no longer loads the whole file into server
  memory.** The import upload endpoints (the layer probe, the
  create-wizard's staged upload, and the direct per-layer import)
  buffered the entire upload in the API's memory for the life of the
  request, so two concurrent county-scale imports could exhaust a
  replica. Uploads now write straight to disk, bounding memory
  regardless of file size. (The in-browser preview and the legacy v2
  import still buffer; a follow-up covers those.)

## [0.9.20] - 2026-08-13

Memory-safety fix for reads of large layers. No schema changes.

### Fixed

- **Reading a whole layer as GeoJSON no longer risks running a server
  replica out of memory.** The endpoints that return a full layer (the
  map's overlay source and its anonymous public equivalent) loaded the
  entire collection into memory and serialised it in one pass, so a few
  concurrent reads of a large public layer could exhaust a replica, and
  the response was silently capped at 100,000 features. They now stream
  the response: memory stays bounded regardless of layer size and the
  cap is gone. Paged reads and single-feature lookups are unchanged.

## [0.9.19] - 2026-08-13

Fixes a hang introduced with the atomic import in 0.9.18. No schema
changes; recommended if you are on 0.9.18.

### Fixed

- **A replace-mode import of an unreadable file could hang instead of
  failing cleanly.** The atomic replace added in 0.9.18 rolls back
  correctly on a bad file, but the rollback itself could hang while the
  bulk-load connection was mid-transfer, leaving the import request open
  and the layer's rows held in an uncommitted state until the connection
  was cleared. The rollback now tears the connection down directly,
  which cannot hang. Caught by running a corrupt-file import against the
  live demo.

## [0.9.18] - 2026-08-13

Two follow-up fixes from working through the lower-priority tail of the
2026-08-13 review. No schema changes; safe upgrade.

### Fixed

- **A failed replace-mode import no longer empties the layer.** The
  per-layer import endpoint (the one the Python client uses) wiped the
  target layer in a separate step before loading the new data, so a
  corrupt file, an empty source, a wrong layer name, or any error part
  way through left the layer empty. The wipe and the load now happen in
  one transaction: on any failure it all rolls back and the existing
  data is left exactly as it was. The import is also faster.
- **A background analysis job can no longer hang forever if it crashed
  at one specific moment.** A contour or similar job that was
  interrupted between preparing its result and queuing the load could
  sit "in progress" indefinitely; it is now recovered and reported as
  failed so it can be retried.

## [0.9.17] - 2026-08-13

A remediation release from a second deep security and reliability review.
Contains one database migration (the print render token store). Safe
upgrade. Several of the fixes matter specifically to deployments that run
the API at more than one replica, which the production compose file does.

### Security

- **The external-service proxy could be steered at internal addresses
  through a redirect.** When the portal fetches a connected service on
  your behalf, it checked that the service URL was not internal, but then
  followed HTTP redirects without re-checking. A service whose URL
  redirected to an internal address (including a cloud provider's
  metadata endpoint) could have its response relayed back. Every hop is
  now re-validated, and the same fix applies to the service probe and the
  geocoder and OpenStreetMap endpoints. Server-side fetches also gained a
  timeout and a response-size ceiling.
- **Registering a relationship now requires edit rights on both layers,**
  not just the one you own. Previously a user who could only view the
  second layer could still alter its table through the relationship.

### Fixed

- **Printing and PDF export failed intermittently on multi-replica
  setups.** The one-time token that authorizes a render lived in the
  memory of a single API replica, so about half of renders, handled by
  the other replica, produced a blank or error page. Tokens now live in
  the database.
- **A database restore now pauses the whole portal, not just one
  replica.** The maintenance flag raised during a restore was
  per-replica, so a second replica kept serving traffic against a
  database being rewritten. The flag is now shared.
- **Scheduled jobs (backups, cleanups, notifications) recover after a
  database blip.** Leadership among replicas was decided once at startup
  and never rechecked, so a dropped database connection could leave those
  jobs running twice or not at all. Leadership is now re-verified
  continuously.
- **Auto-disabling inactive users now works for every account.** The
  housekeeping job looked users up in the identity provider by the wrong
  identifier and silently skipped accounts that predated it, so they
  stayed able to sign in.
- **Imports no longer fail on a whole file because of one uncommon
  geometry.** A geometry collection (produced by some KML and GML files)
  aborted the entire import; these are now imported, and coordinates that
  are not real numbers are reported clearly instead of failing cryptically.
- **Large object downloads and imports are more resilient.** Object reads
  now time out rather than hang if storage stalls, streamed downloads are
  released promptly when a viewer navigates away, and CSV export respects
  a slow client instead of buffering the whole file.
- **Deep paging of the OGC Features API is bounded** so a very large
  offset can no longer ask the server to load millions of rows at once.
- **Field data queued offline no longer gets stuck** in a mid-sync state
  on browsers without background sync; the in-app sync now recovers those
  records.
- **Backup cancellation responds mid-object** instead of only between
  files.

### Security tooling

- The bundled PMTiles converter is rebuilt with a patched
  `golang.org/x/net`, clearing a high-severity advisory the image scan
  flagged.

### Notes for operators

- This release adds one table (`print_render_token`) and applies its
  migration automatically on deploy. On a deployment that restores its
  database from a snapshot on a schedule, re-capture the snapshot after
  upgrading so the new table survives the next restore.
- Worker processes now cap their database connection pool
  (`DB_POOL_MAX`) so the combined demand from the API replicas, the
  workers, and the identity provider stays within PostgreSQL's connection
  limit. Nothing to configure; the defaults are set in the compose file.

## [0.9.16] - 2026-08-10

A one-line follow-up to 0.9.15.

### Fixed

- **The backup retention setting had no effect.** The portal read a
  `BACKUP_RETENTION_COUNT` setting and fell back to keeping 7, but the
  value was never passed into the container, so it always kept 7 no
  matter what was configured. Setting it now works.

### Notes for operators

- Retention is set through the environment, not the admin area. On a
  deployment that restores its database from a snapshot on a schedule,
  a value set in the admin area is reverted on the next restore; the
  environment setting is not.
- Worth setting deliberately after upgrading to 0.9.15: an archive is
  now roughly the size of your object store, so retention multiplied by
  that is what your backup volume needs to hold.

## [0.9.15] - 2026-08-10

A rework of the backup subsystem after it was found to have been
producing nothing for sixteen days, plus a rate-limiting fix. Contains
one schema migration. Safe upgrade.

**If you run a portal with a large object store, read the operator note
at the end of this section: your archives are about to get much bigger
than they used to be, and the default retention count may no longer
fit.**

### Fixed

- **Backups no longer need twice their own size in free disk.** A
  backup copied the entire object store to disk, then compressed the
  copy, in the same directory as the archives it keeps. Peak usage was
  bucket + database dump + archive. Because a `pg_dump` is already
  compressed and a GIS object store is mostly already-compressed
  imagery, compression buys almost nothing, so that came to roughly
  twice the size of everything being backed up. On a portal whose
  object store had grown, no retention setting was low enough to make
  a backup fit, and every attempt failed after filling the disk.
  Object data is now streamed directly into the archive. The archive
  format is unchanged and existing archives restore exactly as before.
- **A failed backup no longer prevents all future backups.** Old
  archives were only cleaned up at the end of a *successful scheduled*
  run, so once a backup failed for want of disk, nothing could ever
  free any, and running one by hand could not break the deadlock
  either. Cleanup now runs before every backup.
- **A backup that cannot fit now refuses to start**, and says how much
  space it needs and how much there is, instead of filling the disk
  and failing partway. On a portal where the object store shares a
  volume with something else, that failure could take the other
  service down with it.
- **A backup is now published only once it is complete.** Previously
  the archive was written under its final name as it went, so a backup
  killed partway left a file that looked like the newest good backup
  and was kept in preference to real ones.
- **A backup killed mid-run no longer stays "In progress" forever**,
  and its temporary files are cleaned up on the next start.
- **Rate limiting now applies per client.** The portal was reading the
  wrong address for every request, so all traffic on the internet
  shared a single allowance per endpoint: one heavy user could exhaust
  everyone else's, while no individual user was ever limited.

### Added

- **A backup health check.** The admin area can now report the age of
  the newest archive that actually exists on disk and whether that is
  overdue for the configured schedule. Nothing previously reported
  this, which is why sixteen days without a backup looked identical to
  sixteen hours.
- **Backups can be cancelled.** Previously a running backup could not
  be stopped at all; deleting its entry removed the record while the
  work carried on, leaving an untracked file behind. Deleting a
  running backup is now refused, with cancellation offered instead.
- **Two backups can no longer run at once**, which previously doubled
  the disk a portal needed at the worst possible moment.

### Notes for operators

- **Your archives will be much larger than before.** An archive is
  effectively a second copy of your object store, and compression does
  little on imagery. If your object store has grown since you set your
  retention count, multiply the two together before the next scheduled
  run: the default of 7 may no longer fit. Lowering retention or
  giving backups their own volume are both reasonable answers.
- **Give backups a volume that is not shared with your object store**
  if you can. A backup that fills a shared volume takes the object
  store down with it.
- Contains one migration; it applies automatically on upgrade.
- If a backup has been failing silently, the new health check will say
  so as soon as you upgrade. That is the point.

## [0.9.14] - 2026-08-09

Security fixes from a second deep review pass
(docs/handoff/deep-review-2026-08-09-pass2.md), covering object storage,
the anonymous public read surface, and share row-scope. Safe upgrade, no
database changes, nothing to configure.

Three of these make reads return **less** data than before. That is the
point: each enforces an access control that was configured but not
applied, so anything you lose was data the portal was already meant to
be withholding.

### Security

- **An item can no longer point at an arbitrary storage object.** The
  `storageKey` on file, tile layer and point cloud items is now pinned
  to its own type's object prefix on write, on read, and on delete. The
  items API previously accepted any key, and the public point cloud
  proxy reads with the portal's own storage credentials, which bypasses
  the bucket policy rather than riding it. Any account that could create
  an item, down to the lowest role, could therefore read or delete any
  object in the bucket, including the feedback screenshots meant only
  for admin triage. The same proxy no longer echoes a stored content
  type, so an upload that sniffs as HTML cannot execute as script on the
  portal's own origin.
- **Public data layers are clipped by their tier boundary.** A
  data_layer marked public with a geographic boundary attached was
  clipped for signed-in readers but served whole by `/api/public/...`
  and the OGC feeds. That also let a reader who was being clipped bypass
  their own clip by calling the public mirror instead. Six read paths
  now apply it, including single-feature OGC reads, where a caller who
  knew a feature id could otherwise walk outside the boundary one row at
  a time.
- **Share row-scope applies to reads, not only writes.** A share set to
  "own rows only" was enforced on `/features` and ignored by the paged
  read, attribute search, selection extent, and the vector tile. The
  tile is what the map renders from and it projects every declared
  field, so the restriction was effectively cosmetic. Ownership keys on
  the feature's creation, so a row stays yours after another editor
  touches it.

### Fixed

- **A CI safety guard was inert.** `REQUIRE_PYTHON_SPECS` and
  `SCRIPT_PYTHON` were never declared in `turbo.json`, so turbo stripped
  them before the tests saw them and the suite that checks a spawned
  script cannot read the worker's secrets could skip while the job
  stayed green. Same failure mode the database-backed suites hit once
  before.

### Notes for operators

- No schema migrations. No golden refresh needed.
- If one of your public layers has a geographic boundary attached,
  anonymous visitors and OGC clients will now see only the clipped
  extent. That is what the setting always promised; until now it was
  only honoured for signed-in readers.
- If any item somehow holds a storage key outside its type's prefix, it
  now 404s on read instead of serving the object, and purge logs and
  skips rather than deleting through it. A warning naming the item is
  written to the API log in that case.

## [0.9.13] - 2026-08-09

A security-hardening pass over the script execution feature, plus two
header-trust fixes and a CSV export correctness fix. All findings from a
full audit (docs/handoff/security-audit-2026-08-09.md). Safe upgrade, no
database changes. Everything script-related stays off unless enabled.

### Security

- **Script egress fence no longer reopens on restart.** It targets the
  executor's IP but was only re-applied every few minutes and the IP was
  dynamic, so each deploy or restart left the executor briefly able to
  reach the cloud metadata service (instance credentials on a cloud VM).
  The executor now has a static address, the fence is applied during
  deploy, and the network is pinned IPv4-only.
- **A script can no longer fill the host disk.** The executor runs
  read-only with a bounded tmpfs for every writable path; previously
  only the scratch dir was capped and a loop writing to /tmp could take
  the box down.
- **Orphaned script processes are killed after each run** (a script
  could previously escape the timeout kill with os.setsid and leave a
  process running).
- **The scripts off-switch now reaches the claimer**, and the executor
  refuses to run as root if its unprivileged uid is misconfigured rather
  than silently un-sandboxing.
- **Feedback rate limiting no longer trusts a spoofable header.** The
  client IP is read from the real proxied position, and Caddy is
  configured to sanitise forwarding headers. Previously a client could
  rotate X-Forwarded-For to bypass the limit. OGC link documents are now
  built from the configured base URL rather than a spoofable Host header.

### Fixed

- **CSV export no longer silently stops at 100,000 rows.** It streams
  the whole layer like the GeoParquet export already did; a large export
  was quietly truncated before.

### Notes for operators

- No action required for a deployment that leaves scripts off. If you run
  scripts, redeploy so the executor picks up the read-only and
  static-IP configuration, and confirm the egress fence units are
  installed (docs/scripts.md).

## [0.9.12] - 2026-08-09

Fixes two things that made the scripts feature unusable in practice.
Safe upgrade, no database changes.

### Fixed

- **Turning scripts on did nothing.** `PORTAL_SCRIPTS_ENABLED` was named
  in a comment in the compose file and referenced by the docs, but was
  never passed to any service. Setting it left the portal reporting the
  feature as off, with nothing to explain why. It now reaches portal-api
  and portal-worker, which are the two that read it.
- **Notebooks ran as Python.** The claimer detected a notebook and the
  executor knew how to run one, but the request between them dropped the
  format, so every notebook failed on the first line of its own JSON.
- **The script egress fence could stop the API from starting.** It was
  scoped to the whole script network, which portal-api is also on, so
  the API inherited a fence meant for user code and hung on boot with no
  error. It now applies to the executor's own address.

## [0.9.11] - 2026-08-08

v0.9.10 did not start and was never live anywhere. Use this instead.

### Fixed

- **v0.9.10 hung on boot.** Both API replicas mapped every route,
  logged leader election, and then stopped before listening, with no
  error. The scheduling module for scripts imported a fifth
  `ScheduleModule.forRoot()` to reach Nest's scheduler registry; the
  registry was never needed, since the service already owns its jobs,
  so the import is gone. Everything in 0.9.10 is otherwise unchanged
  and is listed below.

## [0.9.10] - 2026-08-08

**Withdrawn: this release does not boot. Use 0.9.11.**

Scheduled scripts and notebooks, a much larger Python client, and real
documentation for both. Everything new is off unless you turn it on, so
a deployment that ignores scripts is unaffected. One additive database
column; safe upgrade.

### Added

- **Scripts run on a schedule.** Hourly, daily, weekly, or monthly, set
  on the item. Structured fields rather than a cron expression. A
  scheduled run acts as the item's owner, not whoever last edited the
  schedule, and a run that arrives while the previous one is still
  going is recorded as skipped rather than dropped, so a script slower
  than its own schedule looks like one.
- **Jupyter notebooks run.** Upload a `.ipynb` and the portal executes
  it head-lessly with papermill, keeping the executed copy with its
  output on the run, including when the run fails. Charts appear
  inline. There is still no browser kernel and there is not going to
  be one; authoring belongs in the editor you already have.
- **`SCRIPT_EGRESS=portal-only`.** Drops a script's internet access
  while keeping the whole portal API, which is what makes it safe to
  offer script authoring to people you do not know.
- **Python client 0.6.0**, from ten methods to thirty-five: file
  import with replace, export to GeoParquet/CSV/GeoJSON, layer
  creation, feature attachments, sharing, delete and restore,
  calculate-field, server-side geoprocessing through derived layers,
  and geocoding.
- **Documentation for the automation surface.** New help pages for the
  Python client, scripts, and the HTTP API, with worked examples, and
  a link to them from the help landing page, which previously pointed
  at none of it.

### Fixed

- **`find_items(query=...)` in the Python client never filtered.** It
  sent the wrong parameter name, the portal ignored it, and every
  search returned an unfiltered list of the first `limit` items while
  looking like it had worked.
- **A script could reach the host and the cloud metadata service.**
  Container isolation stopped it reaching postgres, minio, and
  keycloak, but not `169.254.169.254`, which on a cloud VM serves the
  instance's credentials. `infra/script-net-firewall.sh` and its
  systemd units close that; installing them is now part of turning
  scripts on. Scratch space is also capped, which it was not: CPU,
  memory, and processes were limited while a script could fill the
  host disk.
- **The nightly demo reset could abort and leave the stack down.**
  Three causes: a service behind a compose profile was invisible to
  the stop list, `CONNECTION LIMIT 0` does not apply to superusers so
  the reconnect guard did nothing, and nothing brought services back
  when a step failed. The reset now derives what to stop, blocks
  connections in a way that works, and restores service on any
  failure.

### Notes for operators

- If you enable scripts, install the egress fence units. See
  [docs/scripts.md](./docs/scripts.md#turning-it-on). On a cloud VM
  this is a real exposure, not a precaution.
- `SCRIPT_EGRESS` defaults to `open`, which is the existing behaviour.

## [0.9.9] - 2026-08-05

A follow-up to 0.9.8 that makes reading a large layer from a script
actually work. Safe upgrade, no database changes.

### Added

- **Paging on layer reads.** `/features` and `/geojson` now accept
  `limit` and `cursor` and report where the next page starts. Reads
  page over stable feature ids rather than an offset, so edits made
  while you are reading cannot cause a feature to be skipped or
  returned twice. Public layers support the same, so anonymous reads
  can be bounded too. Requests without either parameter behave exactly
  as before.

### Fixed

- The Python client's `iter_features()` did not page. It asked the
  portal for one page, the portal had no way to give it one, and the
  whole layer came back in a single response. On a big enough layer
  the read was also silently capped, so a script could quietly process
  only part of its data. It now pages properly and holds one page in
  memory at a time.

## [0.9.8] - 2026-08-05

A safe upgrade from 0.9.7, and the first release with a way to reach
the portal from outside a browser.

**Upgrade note:** this release adds a database table (`api_key`).
Migrations run automatically on API boot as usual, but if you keep a
golden snapshot for demo resets, refresh it after upgrading.

### Added

- **API keys** (#219). Create a key at Profile -> API keys and use it
  as a bearer token from scripts, notebooks, scheduled jobs, or CI.
  A key acts as the person who created it, so sharing rules and
  geographic limits apply exactly as they do in the browser. Keys can
  be marked read-only, can be given an expiry, and are never accepted
  on admin endpoints or for managing other keys. Tokens are stored as
  a one-way hash and shown only once.
- **A Python client** (#220), in `clients/python`. Connect with an API
  key, read a layer as GeoJSON, and write features back, with
  automatic batching under the portal's per-request limit. One
  dependency.

### Fixed

- The MCP server no longer asks you to copy a session token out of
  browser developer tools. Use a read-only API key instead, which does
  not expire mid-session.
- Documentation described personal access tokens that had never been
  implemented. It now describes what actually ships.

## [0.9.7] - 2026-08-03

A safe upgrade from 0.9.6. Full-resolution terrain derives at any
extent, a terrain on/off toggle, and two visibility fixes.

### Added

- Chunked elevation processing (#208). Hillshade, elevation, and
  height-above-ground layers no longer hit the fixed size cap: any
  area builds at full resolution in bounded-memory chunks that
  combine into one seamless surface. Builds that cannot finish
  inside the server's time budget are refused up front with an
  estimate (operator-tunable GRID_* settings), and the building
  state reports real chunk progress.
- 3D on and off is now a toggle that keeps your elevation stack.
  Turning 3D off just flattens the view; the surfaces and their
  ordering are exactly as you left them when you turn it back on.
- The admin housekeeping page gains a "Broken references" card
  (#217): items pointing at other items that no longer exist (or
  sit in the trash) are listed with links, instead of rendering as
  silent holes in maps.

### Fixed

- An expired sign-in no longer shows the signed-in navigation. The
  portal chrome now follows the same session truth as the header
  and banner, so a dead session sees the public page with a sign-in
  prompt rather than a sidebar full of links that would not work.
- A manual golden snapshot no longer leaves the demo's tester
  workspace unassigned until the next nightly reset.

## [0.9.6] - 2026-08-03

A safe upgrade from 0.9.5. Multi-image imagery mosaics, and a
seeder fix that keeps sample-content references stable.

### Added

- Imagery mosaic (#199). Pick several aerial images in one upload
  (or "Add more images" on an existing imagery layer) and the
  portal combines them server-side into one seamless layer. Where
  images overlap, the most recently added wins. The source images
  are kept, so coverage can grow later without re-uploading
  anything; adding images re-composes over the full set. Builds
  are estimated before a byte uploads and refused when they cannot
  finish inside the server's job window (operator-tunable MOSAIC_*
  settings); a failed or partial upload can be retried without
  re-transferring what already made it.

### Changed

- The 3D terrain stack moved out of the basemap menu into its own
  collapsible section at the bottom of the map's layers panel.
  Terrain affects every layer, not just the basemap, and its
  top-wins ordering now reads exactly like the layer list above
  it. The basemap menu is basemaps only again.

### Fixed

- Sample-content items now get the same id every time they are
  seeded (#217). Previously a purged sample item came back under a
  new id, and any hand-built map referencing it silently lost that
  layer. Existing items keep their current ids.

## [0.9.5] - 2026-08-02

A safe upgrade from 0.9.4. Maps can now compose several elevation
layers into one terrain surface.

### Added

- Elevation mosaic (#211). A map's 3D terrain is now an ordered
  STACK of elevation layers instead of a single pick. The server
  composes terrain tiles per pixel across the stack, so two lidar
  surveys that cover different areas both extrude in the same map,
  and where surveys overlap the one nearer the top of the list
  wins. A single-entry stack keeps the existing in-browser path and
  costs the server nothing. Works in saved maps and scratch maps,
  signed in and anonymous.
- Layers remember their ground truth (#211). Derived layers
  (hillshade, steepness, visibility) and point clouds carry a
  reference to their matching elevation layer. Adding one to a map
  offers to bring that terrain along, and a layer's menu gains
  "Use this layer's elevation", which adds its elevation layer to
  the map's terrain stack.
- The elevation profile tool follows the terrain stack, sampling
  the same surface the map is standing on.

### Changed

- The point cloud page's derive section is now called "Elevation
  and shading" and groups its actions more clearly (#212).

### Internal

- First Playwright end-to-end suite: an e2e workspace with 11
  anonymous-path specs, plus a daily production smoke workflow.
- Terrain tiles ride the shared tile cache with the same overload
  backoff as vector tiles; the COG reads go through GDAL's /vsis3
  directly against MinIO.

## [0.9.4] - 2026-08-02

A safe upgrade from 0.9.3. Lidar ingest hardening, honest test
coverage, and small trust fixes.

### Fixed

- Multi-tile lidar uploads no longer lose everything to one bad
  round-trip. Tiles upload three at a time with automatic retry on
  transient failures; a tile that still fails is reported by name,
  and you can retry just the failures or start the merge with what
  made it and add the rest later.
- A point-cloud worker restart no longer leaves an interrupted
  merge's partial downloads on the scratch disk. The worker sweeps
  abandoned job directories at startup, keyed on the job table's own
  liveness, so a crash loop cannot ratchet the volume toward full.
- The portal now ships a favicon and Apple touch icons, so browsers
  and link previews stop receiving 404s for them.

### Added

- Merges are estimated before they start. The upload panel shows
  "N tiles, M GB, roughly H hours" before you commit gigabytes, a
  merge that cannot finish inside the server's time budget is
  refused up front with advice instead of dying at the timeout
  hours later, and the building state shows the estimate. The rates
  are operator-tunable and re-derivable from each completed merge's
  logged stats.
- The install doctor reports point-cloud scratch capacity against
  the merge sizing rule, and the deployment guide documents how to
  size the disk.

### Internal

- The PostGIS-backed engine and search-index test suites now run in
  CI against a real database through the production driver adapter,
  with a guard that fails the build if they would silently skip.
  Reverting the v0.9.3 feature-insert fix now turns CI red, which is
  the property that was missing when it shipped broken.

## [0.9.3] - 2026-07-30

A safe upgrade from 0.9.2. Nothing here requires a configuration
change: the additions are demo and operator tooling that stays off
unless you turn it on.

### Fixed

- Saving features works again. The advisory lock the write path takes
  asked PostgreSQL for rows from a function that returns nothing, and
  the database driver could not deserialize that, so the transaction
  rolled back. Every insert path was affected: form submissions,
  imports, OpenStreetMap saves, and sample data seeding.
- A portal whose sign-in has expired no longer presents itself as
  signed in. The header showed a name and avatar while the API had
  already downgraded the same session to anonymous, so private items
  quietly disappeared with no explanation. The header now offers Sign
  in, matching the banner that was already there.
- `infra/deploy.sh` parses `.env.prod` instead of sourcing it through
  bash. Sourcing expanded the values, so anything containing a dollar
  sign (a bcrypt hash, for one) silently became something else, and a
  secrets file was arbitrary code in a root deploy. Parsing follows
  the same rules `docker compose --env-file` uses, so the scripts and
  compose always agree. The golden snapshot and restore scripts use
  the same loader.

### Security

- The bundled `pmtiles` binary is built against golang.org/x/text
  0.39.0, past CVE-2026-56852. Upstream still pins the vulnerable
  version, so the image build upgrades the dependency itself and
  asserts the result.

### Added

- Optional traffic analytics for a public demo deployment: Caddy
  access logs and Keycloak login events collected into a SQLite store
  outside the nightly reset, rendered as a static dashboard at
  `/_stats` behind basic auth. Off by default. `STATS_USER`,
  `STATS_HASH`, `CADDY_LOG_DIR` and `ANALYTICS_DIR` are documented in
  `infra/.env.prod.example`; the default credentials cannot
  authenticate, so an untouched deployment exposes nothing.
- A demo sign-in theme that lists the shared tester accounts, and
  seeding that gives those testers an owned and shared workspace after
  each nightly reset. Both are demo-instance tooling.

## [0.9.2] - 2026-07-26

### Added

- The deployed version now shows on the landing page footer and at the
  bottom of the signed-in user menu, linking to that release's notes.
  Deploys stamp the exact ref (a release tag, or a describe string for
  between-releases builds), and /api/portal-info reports the same
  value for API clients.

## [0.9.1] - 2026-07-26

### Fixed

- The trash listing now serializes the lean owner projection like the
  live list and the detail read. The pre-snapshot demo purge keys its
  keep-or-purge decision on the owner and correctly refused to run
  against rows without one, which blocked the golden refresh after the
  v0.9.0 deploy.
- The purge script requests the API's real page cap instead of a
  parameter that never existed, and documents the fail-safe direction
  when an org outgrows one page.

## [0.9.0] - 2026-07-26

The first tagged release. GratisGIS has been developed in the open on
`main` until now; from this release forward the installer and the
deploy script track release tags, and
[docs/UPGRADING.md](./docs/UPGRADING.md) describes how self-hosters
move between them.

### Added

Everything is new in a first release. What ships, briefly:

- The portal: organizations, users, groups, folders, an item catalog,
  and sharing with row, column, and geographic limits, on top of an
  append-only observation-log engine with Cedar geometry-aware
  authorization.
- Web maps authored on PostGIS-backed data layers with vector tile
  rendering, drawings, scratch maps, live PostgreSQL/PostGIS
  connections, and print/PDF layouts.
- Forms and field data collection: form authoring, submissions, and an
  offline-capable field PWA.
- Web apps: viewer, editor, and custom widget apps built in the App
  Builder, with seeded app and print templates.
- Analysis: derived-layer tools, a visual tool builder with OSM as a
  first-class source, an in-browser analyze panel, and a server-side
  analysis workbench (contours, viewshed, steepness, height above
  ground, elevation profiles, SAM-assisted outline capture).
- 3D: COPC point cloud upload, merging, and streaming, plus terrain
  built from lidar elevation layers.
- Interoperability: OGC API Features, Tiles, Styles, and Records under
  `/api/public/ogc`; GeoParquet import and export; an ArcGIS Online
  content importer and Esri WebMap JSON import/export; an MCP server
  (`apps/portal-mcp`). A QGIS plugin lives in its own repository.
- Operations: single-host Docker Compose deployment with a one-command
  installer, guided setup, health checks, admin backup and restore,
  five UI languages, and one-click sample data.

### Changed

- `infra/install.sh` and `infra/deploy.sh` now check out the newest
  release tag by default instead of tracking `main`. Setting `GG_REF`
  overrides the choice with a tag, branch, or commit sha.
- Breaking: `GET /api/items` now returns the narrow item shape by
  default and paginates (default page 500, hard cap 1000). Pass
  `full=1` for full `data_json` payloads and page with `limit` and
  `offset`.
- The service worker replays queued field edits through one offline
  queue with Background Sync, trims the runtime tile cache, and purges
  per-user caches on sign-out.
- Observation partition maintenance runs on a schedule inside
  Postgres (the pg_partman background worker), and premade future
  partitions drop from 24 to 4, cutting how many partitions each hot
  query probes.
- Infrastructure hardening: deploys, golden snapshots, restores, and
  the nightly demo reset share one lock; snapshot and restore verify
  their artifacts before any destructive step; dependent services wait
  on a Keycloak healthcheck; container memory budgets are sized to the
  reference 8 GB box.

### Fixed

- Ghost features: filtered reads (vector tiles, feature search, the
  geocoder, derived layers, bbox and clip reads, exports) now collapse
  each feature to its latest version before applying filters, so
  deleted and superseded versions no longer resurface.
- Retried feature creates that carry a client-supplied id are
  recognized and deduplicated under an advisory lock instead of
  inserting duplicate features.
- Raster protocols (PMTiles, COG) are re-asserted at map init rather
  than trusted from a cached flag, and production web builds use
  webpack, ending the dual maplibre-instance tile failures.
- OGC API Features paging emits `next` links again and no longer
  reports a misleading `numberMatched`.
- Imports: replace-mode truncation runs inside the COPY transaction so
  a failed replace rolls back; stale-job recovery runs periodically;
  cancelled jobs stop reporting phantom inserted rows.
- Point clouds: merge timeouts are configurable, scratch space is
  checked up front, worker output no longer deadlocks on a full pipe,
  and concurrent API writes are no longer clobbered.
- Analysis jobs carry a heartbeat and a reclaim sweep, so a killed
  worker no longer strands jobs as running forever, and queued or
  running jobs can be cancelled.
- Housekeeping gained a reconciliation sweep that removes orphaned
  uploads left in object storage by crashed jobs.
- Feature search and the geocoder can run on per-field trigram indexes
  (admin rebuild action) instead of full scans.
- Folder edits can send an optimistic-concurrency precondition and get
  a 409 instead of silently overwriting a concurrent save.
- Map: terrain rebuilds when a different DEM is picked, drawings
  survive basemap swaps, vector and GeoJSON sources keep their caches
  across style-only changes (no blink on opacity drags), and assorted
  popup, selection, and refetch races are fixed.
- Sessions: a failed token refresh is treated as signed out, so public
  pages fall back to the anonymous view instead of erroring.

### Security

- SSRF hardening: server-side fetches of user-supplied URLs
  (thumbnails, geocoding, the ArcGIS Online importer) revalidate every
  redirect hop and block internal address ranges.
- Stored XSS closed: uploaded SVGs are served as attachments, response
  disposition derives from the actually served content type, and
  serves carry `nosniff`.
- Object storage keys for tile layers and feature attachments are
  pinned to their expected prefixes, and serving reads by key through
  the S3 SDK instead of stored URLs.
- Cross-organization gaps closed in group administration, comment
  editing and deletion, and feature attachments.
- Zip ingestion runs in-process with traversal and symlink rejection,
  decompression and entry caps, and per-entry CRC checks.
- The web proxy rejects dot segments before allowlist matching.
- The Keycloak master realm is blocked at the edge, the materialized
  realm import file is no longer world-readable, and a root
  `.dockerignore` keeps secrets out of image build contexts.
- Dependency updates for published CVEs: Next.js 16.2.11, next-auth
  4.24.15, sharp, fast-uri, postcss, brace-expansion, tar, and the
  `@hono/node-server` override.

[0.9.2]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.2
[0.9.1]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.1
[0.9.0]: https://github.com/palavido-dev/gratis-gis/releases/tag/v0.9.0

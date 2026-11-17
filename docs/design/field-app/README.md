# Handoff: GratisGIS Field — native mobile data collection app

## Overview

Design for the native (iOS + Android) field data collection client for
GratisGIS: the mobile surface for `data_collection` items. It covers
portal sign-in, the collection catalog, offline area management, map-mode
and form-mode capture, feature review, photo capture, GPS/instrument
configuration, sync (the "Outbox"), and account/storage.

The design is grounded in this repository, not invented:

| Source read | What was taken from it |
| --- | --- |
| `docs/editing-and-collection.md` | `data_collection` item shape, map vs form mode, `workAreaPolygon`, tile packages, `ownEditWindow`, conflict policy, schema-version-aware queue |
| `docs/data-collection-phase1.md` | What already ships: 21 question types, IndexedDB outbox, `clientId` idempotency, attachments queued separately |
| `apps/portal-web/src/app/items/[id]/field/field-runtime.tsx` | Control geography (Layers top-left, search beside it, zoom/compass/locate right rail, add-FAB bottom-right, crosshair reticle, template picker, form modal, More menu), GPS accuracy banner, "one Submit only" decision |
| `apps/portal-web/src/app/field/field-catalog.tsx` | Deployment row layout, cache status dot, `Sync N` chip, two-tap destructive confirm |
| `apps/portal-web/src/lib/i18n/messages/en.ts` | All offline/sync/download copy — these screens reuse those exact sentences rather than inventing new ones |
| `docs/design-system.md`, `apps/portal-web/src/app/globals.css` | Contour palette, type scale, spacing, radii, Lucide icons |
| `apps/portal-web/src/components/brand-mark.tsx` | The three-contour brand mark used on the sign-in screen |

## About the design files

`GratisGIS Field.dc.html` is a **design reference written in HTML** — a
static prototype showing intended layout, color, type and copy. It is not
production code and should not be copied into the app. The task is to
**recreate these screens natively** (SwiftUI / Jetpack Compose, or React
Native if the team goes cross-platform) using the platform's own controls
and this repo's Contour tokens.

Open the file in a browser. It is a canvas: three rounds of work stacked
newest-first, each screen inside an iPhone frame with a caption
explaining the reasoning.

## Fidelity

**High-fidelity.** Colors, type, spacing, copy and control sizes are
final and taken from the tokens below. Recreate pixel-accurately, then
substitute platform-native controls (iOS switches/pickers, Material 3
switches/segmented buttons) where noted in the Android deltas.

The map canvases are **placeholders** — simple SVG stand-ins for a
MapLibre Native view. Do not recreate the SVG; mount the real map.

## Screens

Ids below match the badges in the HTML file (`#1a`, `#3a`, …).

### 1a — Connect a portal
Sign-in. Centered 72px brand mark, wordmark ("Gratis" in ink, "GIS" in
sage), subtitle. Portal address field (52px, `--surface-2` fill, 1px
`--border`, radius 8, Geist Mono value). Primary Continue button (52px,
sage fill, white ink, arrow icon). "Recent portals" list: 30px rounded
initial tile, title 14/600, URL 12 mono muted, right side either a
"signed in" success pill or a chevron. Footer note on `--surface-2`:
session is refreshed for offline use before leaving signal, and captures
keep queueing after it lapses.

### 1b — Collections (home, tab 1)
Large title 30/36 + search and account circle buttons (40px). A
connectivity banner (warn-tinted, 8px radius) using the catalog's own
offline sentence. One row per `data_collection`: 42px rounded icon tile
with a 13px cache dot (success = cached, neutral = not) at lower-right;
title 15.5/600; meta line "Cached 148 MB · 6 h ago · 3 areas"; chips for
queued records and pending photos. Uncached rows are dimmed to 0.72 and
carry a "Get" action with the required size. Sorted queued-first, then
`updatedAt` desc (same as the web catalog). Footer hint pinned above the
tab bar. Bottom tab bar: Collections · Map · Outbox, 83px tall (49 bar +
34 safe area), red badge on Outbox.

### 1c — Offline areas
Per-collection list of prepared areas. Each is a card: 132px map preview
with the area drawn as a 2px sage rectangle over a 14%-alpha fill;
title + "Ready" success marker; meta "148 MB · zoom 10–18 · 4 layers,
1 form, 812 features · downloaded 6 h ago"; Update / Rename / delete
row (38px). An incomplete area uses the warn card and the portal's
`fieldOffline.partial` + `tilesRefusedGeneric` sentences, with
"Retry the rest" / "Lower detail". An in-flight download shows the
`offlineMessage.download.basemapNthPercent` line, a 6px progress bar,
Stop, and a note that it continues with the screen off. Footer: dashed
50px "Draw a new area on the map" plus a note that supervisor-assigned
areas arrive pre-drawn.

### 1d — Map capture, idle (tab 2) — **primary screen**
Compact header: collection title 16/600 + 36px overflow button. Then the
**status strip**: one 8px-tall row, three segments hairline-divided —
connectivity (warn tint when offline), GPS accuracy + receiver name
(success/warn/danger by band), queue depth. Tapping the GPS segment opens
1k. The strip is the answer to "settings are buried": device state is
always on screen and two taps from its controls.

Map fills the rest. Controls, all 44×44 with 10px radius, 1px border,
`--surface-1` at 97% opacity, `shadow-card`:
- Layers top-left at (12,12); search at (64,12).
- Zoom + / zoom − / compass as one joined 44px-wide stack, top-right (12,12).
- Locate at top-right (12,156), info-blue when watching.
- Bottom-left: a context card ("Bear Creek reach · offline area",
  "6 captures today · last 11 min ago").
- Bottom-right: 64px circular sage FAB, `shadow-overlay`, white plus.
  `bottom: calc(1.25rem + safe-area-inset-bottom)`.
Feature markers: 15px circles, 2.5px white stroke, filled with the
layer's symbology color. GPS position: 12px info-blue dot inside a
30px 18%-alpha halo.

### 1e — Placing a feature
Chrome hidden (matches the runtime's `showRuntimeChrome` rule). Crosshair
reticle centered, 72px: white outer ring, sage inner ring, sage center
dot, four 14px tick marks, `pointer-events: none`. GPS accuracy pill
centered at top, colored by band. Bottom card: 26px template swatch,
template label + layer/geometry sublabel, close button, then three
commits — **My location** (sage fill, 52px, accuracy `±2.4 m` on a
second line), **Crosshair** ("place by hand"), and a 52px **OFFSET**
button that opens the laser / bearing-distance path. Caption line:
"Averaging 10 fixes… hold still, or tap to accept now."

### 1f — Form over the map
Sheet 676px tall over the map, 18px top corners, `shadow-overlay`, 40px
grab handle. Header: Cancel (outline) / title + "Page 1 of 3" / Submit
(sage) — **one** submit, per the runtime's note. 3px page-progress bar.
Content: a sage-tinted geometry row (coordinates 12.5/600, "Averaged 10
fixes · ±2.4 m · SXblue Platinum", Update pill), then fields. Text field
48px with a 48px barcode-scan button beside it. Radio options are full
48px rows, selected one 1.5px sage border + 9%-alpha fill. Stepper:
56px − / value / 56px +. Photos: 72px thumbnails (queued ones carry a
"queued" tag) plus a dashed Camera tile. Content container has 40px
bottom padding to clear the home indicator.

### 1g — Form mode (survey)
Same runtime with no map. Close / title + "Page 2 of 4 · draft saved" /
Save. Four 4px page pills. Section heading 20/700. Segmented control
(four 46px cells). Select row 50px with chevron and a "from the
*Substrate* pick list · cached" hint. Repeating group as a card with a
count chip, numbered rows in mono, and "Add an entry". Warn note: captured
against form v3, collection now on v4, review before sending. Sticky
footer: Back (88px) + Next (sage, flex).

### 1h — Feature details
512px bottom sheet. Header: 26px swatch, title 17/600, layer · site code,
and a state pill ("Queued" warn / "Sent" success). Attribute rows are
label-left / value-right with 1px `#EDE9DF` rules; coordinates in mono
with accuracy underneath. Photo thumbnails 62px. A `--surface-2` note
states the own-edit window: "You can edit your own records for 30 days
after capture. **29 days left.**" Footer: Edit (sage) / Duplicate /
delete.

### 1i — Superseded by 3a.

### 1j — Camera
Dark screen (`#1A1917`). Done / title + "Photos · 2 of 6" / flash.
Viewfinder with a translucent stamp block top-left showing lat/long,
accuracy, bearing and time in mono; barcode and offset buttons top-right;
52px focus square centered. Controls row: 54px last-shot thumbnail with a
count badge, 74px white shutter with a 5px 35%-alpha ring, 54px
front/back toggle. Caption: full resolution saved to the queue, uploads
at 2 MB when signal returns.

### 1k — Location & instruments
Reached by tapping the GPS segment of the status strip. Success-tinted
receiver card: name, "Bluetooth · SBAS fix · 14 sats · ±2.4 m", "In use"
pill, and a three-up HDOP / vertical / battery row. Then a settings card:
antenna height (value + chevron), "Average before commit" with subtitle
"10 fixes · reject over 5 m", "Track log" with subtitle "Records your
route with the screen off" — both 50×30 switches. Then "Instruments":
paired rangefinder with a success dot, barcode scanning with a switch and
subtitle naming the fields it fills, and "Pair another device — Bluetooth
NMEA, serial, or Lightning". Last card records the last offset
("14.6 m @ 214° · −3° incl.") and states that raw fix and derived
position are both stored.

### 1l — Account & storage
46px avatar, name, portal host in mono, "session ok" pill. Storage card:
a 10px stacked bar (sage offline maps / clay schema / warn unsynced) with
a legend and sizes in mono, and a note that storage is marked persistent
so the system won't evict captures. Preferences card: Sun mode (switch),
Units, Coordinate format, "Send only on Wi-Fi — Photos wait; records
always send". Sign out is danger-outlined and blocked while unsynced work
exists.

### 3a — Outbox (tab 3) — **the settled sync screen**
Screen title "Today", subtitle "Thu 13 Sept · 17 records · 6.2 km walked",
"Earlier" pill. Three count tiles (sent / waiting / refused) tinted
success / warn / danger with the number in mono 19/600. **Refusals are
pinned above the log** in a danger card carrying the server's own
sentence verbatim — e.g. "Species is not one of the allowed values for
this layer." (422) — with "Fix and resend" / "Discard". Below, a
chronological day log: 44px mono timestamp column, an 11px state dot on a
1.5px connector rail, then title + detail. Dot colors: warn = waiting,
danger = refused, success = sent, neutral = non-record events
("Track log started"). Sticky "Send 13 waiting" button above the tab bar.

Rationale: the surveyor's 4pm question is "did I get all twelve pools?",
so sent records stay listed and the day is auditable — but a refusal can
never scroll out of sight.

### 1m — Android deltas
Material bottom navigation; predictive back and hardware back both run
the form's "discard draft?" confirm. Material switches, radio buttons and
M3 segmented buttons. The capture FAB becomes an M3 extended FAB reading
"Add". CameraX with the same stamp; bind a rugged handset's programmable
key to shutter and to *My location*. Bluetooth NMEA **plus** USB serial
(OTG), and Android's mock-location provider so an external receiver can
feed the whole OS — iOS has no equivalent and feeds the app only.
WorkManager for queue drains and area downloads; a foreground-service
notification while the track log runs (Android requires it, iOS does
not). Scoped storage means exports land in a SAF-picked folder.

## Interactions & behavior

- **Capture, the one flow that must be fast.** Map (1d) → FAB → template
  picker (skipped when the collection has exactly one template) → armed
  reticle (1e) → *My location* or *Crosshair* → form sheet (1f) →
  Submit → returns to 1d with the new marker drawn and the queue count
  incremented. With one template and a GPS fix this is two taps.
- **Status strip taps:** connectivity segment → sync attempt; GPS segment
  → 1k; queue segment → Outbox tab.
- **Offsets:** OFFSET in 1e captures distance / azimuth / inclination
  (typed, or read from a paired rangefinder). Store the raw fix and the
  derived position; never overwrite one with the other.
- **Averaging:** default 10 fixes, reject any over 5 m. The commit button
  shows live accuracy so the collector judges before tapping.
- **Photos:** written to the attachment queue at full resolution and
  uploaded separately from the parent record (the documented behavior —
  a large photo must never hold up its row).
- **Sync:** automatic when connectivity returns, including with the screen
  off. One local notification when the queue empties, one per refusal.
  Idempotent on `clientId`; a re-drained queue is a no-op.
- **Schema versions:** records carry `formVersionId`. Additive changes
  send silently; structural changes mark the record "needs review
  (v3 → v4)" and require a review sheet before sending.
- **Own-edit window:** Edit is offered only inside `ownEditWindow`, and
  the remaining days are stated in words rather than the button being
  silently disabled.
- **Destructive actions:** two-tap arm-then-confirm (the catalog's
  pattern), and counts of what would be lost — including another
  account's parked rows — in the confirmation.
- **Motion:** 120–240ms, purposeful; disabled under reduce-motion.

## State

Per collection: `cached` manifest (size, `cachedAt`, areas), feature
snapshot in scope, form schema + published version, pick lists, tile
package. Per device: queue (`clientId`, `formVersionId`, owner, status
`queued → sending → sent | failed | rejected`), attachment queue, rejected
rows with the server's message, parked rows belonging to other accounts.
Live: connectivity, GPS status (`idle | watching | denied | unavailable`),
current fix (lat, lon, accuracy, source), follow mode, active template,
pending vertices, paired instruments, storage estimate + persistence
grant.

## Design tokens (Contour, from `globals.css`)

Light mode, resolved to hex for convenience — **use the CSS variables /
their native equivalents, not these literals**, and ship the matched dark
set from the same file.

| Token | HSL | Hex |
| --- | --- | --- |
| `--surface-0` | 45 30% 98% | `#FBFAF6` |
| `--surface-1` | 45 27% 96% | `#F7F5EF` |
| `--surface-2` | 45 22% 93% | `#F0EDE4` |
| ink (`--surface-*-ink`) | 40 12% 13% | `#262320` |
| `--muted` | 40 7% 44% | `#78726B` |
| `--accent` / `--brand-sage` | 124 8% 38% / 40% | `#5A6858` / `#5F6D5D` |
| `--brand-clay` | 33 33% 54% | `#B78A5B` |
| `--brand-mauve` | 350 18% 46% | `#8A5A63` |
| `--success` | 142 60% 30% | `#1E7A4B` |
| `--warn` | 33 85% 47% | `#DF8110` |
| `--danger` | 0 68% 49% | `#D22B2B` |
| `--info` | 205 75% 42% | `#1B7CBB` |
| `--border` | 43 18% 87% | `#E3DED3` |

Deep ramp steps used for text on tinted fills: sage `#4C5B4A` /
`#3E4A3C`, warn `#8A4F06`, danger `#9E1F1F`, success `#155E3A`, info
`#155E8E`.

- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. No freelance values.
- **Radii:** sm 4 · md 8 · lg 12 · xl 16 · full. Cards and inputs 8–10;
  sheets 18 top corners; pills/FABs full.
- **Type:** Inter (variable) for UI, Geist Mono for coordinates, sizes,
  counts and IDs. Scale as in `design-system.md`: h1 30/36, h2 24/32,
  h3 18/28, body 14/22, small 12/18, mono 13/20. Screen titles 28–30/700
  at −0.5px tracking.
- **Elevation:** `shadow-card` rested (map controls, rows),
  `shadow-raised` popovers, `shadow-overlay` sheets and the FAB.
- **Touch targets:** 44pt minimum everywhere; map controls exactly 44;
  commit buttons 52; FAB 64.
- **Contrast:** ink on paper 12.6:1. No secondary text below 4.6:1. State
  is always carried by label + shape as well as hue (sunlight, and
  color-vision safety).

## Assets

- **Brand mark:** three nested contours from
  `apps/portal-web/src/components/brand-mark.tsx`. Use that geometry;
  do not redraw. Below 20px use the `small` variant.
- **Icons:** Lucide, stroke width 2 at interface sizes. The prototype
  inlines Lucide path data; the app should use the platform Lucide port.
- **Maps:** MapLibre Native with the repo's Protomaps light/dark pair.
  The SVG map in the prototype is a placeholder only.
- **Photos:** none. Thumbnails in the prototype are flat SVG placeholders.

## Files

- `GratisGIS Field.dc.html` — all screens, with per-screen design notes.
  Self-contained apart from Google Fonts (Inter, Geist Mono) and
  `ios-frame.jsx`.
- `ios-frame.jsx` — the iPhone bezel/status-bar wrapper used by the
  prototype. Presentation scaffolding only; nothing to implement.
- `support.js` — runtime for the HTML prototype format. Not part of the
  design.

## Open items for whoever implements this

- The tappable capture-flow prototype (1d → 1e → 1f) had not been built
  when this package was cut.
- Assignments are explicitly Phase 2 in `editing-and-collection.md` and
  are not designed here.
- Line and polygon capture reuse the runtime's vertex-collection footer;
  only the point path is drawn in these screens.

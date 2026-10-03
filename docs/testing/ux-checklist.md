# GratisGIS UX/UI testing checklist

A thorough manual walkthrough of every shipped feature. Aimed at
catching bugs, broken empty states, missing permissions, and
"this used to work but doesn't" regressions. Designed for a solo
maintainer who wants to validate the platform end-to-end before
inviting real users.

**How to use this:**

1. Set up two test accounts in your local Keycloak realm: an
   admin (`admin@local`) and a contributor (`alice@local` in the
   default org, plus `bob@external` in a *different* org for
   cross-org tests). Note their UUIDs.
2. Open this file in a markdown editor that supports interactive
   checkboxes (VS Code preview, GitHub, Obsidian). Or paste
   into an issue and tick boxes as you go.
3. Walk through the sections in order. Each item is *one* concrete
   action with *one* expected outcome. If the outcome is wrong,
   note it inline (`- [ ] item title — BUG: <what happened>`).
4. The sections marked **(known stub)** are documented as not
   shipped; skip them or just verify the placeholder renders
   without erroring.
5. Total walkthrough is ~3-4 hours if you're being thorough.
   Splitting across two sessions is fine.

**Browser matrix:** validate Chrome (latest) at minimum. Firefox
and Safari should both work; one full pass through Section 1-3 in
each non-Chrome browser catches >90% of cross-browser bugs.

**Viewport matrix:** desktop (1920x1080), laptop (1440x900), tablet
(iPad portrait), and mobile (iPhone 13 portrait). The field PWA
section explicitly tests mobile-portrait.

---

## 0. Pre-flight

- [x] `pnpm infra:up` brings up postgres / keycloak / minio / pg_tileserv / nominatim cleanly
- [x] `pnpm dev` starts portal-api (port 4000) + portal-web (port 3000) without errors
- [x] Local URL `http://localhost:3000` loads the public landing page
- [x] Local URL `http://localhost:4000/health` returns `{ "status": "ok" }`
- [x] Local URL `http://localhost:8081` loads Keycloak admin console
- [x] Local URL `http://localhost:9001` loads MinIO console
- [x] At least two test users exist in the gratis-gis realm with passwords you know
- [x] At least one user has the `admin` org role; the other has `contributor`
- [x] The dev DB has the latest migrations applied (`pnpm --filter @gratis-gis/portal-api exec prisma migrate status` shows clean)

---

## 1. Authentication & sign-in

### 1.1 Sign-in flow

- [x] **Public landing renders without a session.** Open an incognito window. The landing page should show the org name, hero band, and (if `landingShowPublicItems` is on) public items. No sidebar, no admin chrome.
- [x] **Sign-in CTA navigates to Keycloak.** Click "Sign in" in the top bar; lands on Keycloak's login form.
- [x] **Successful login redirects back to portal.** Sign in as your contributor user; lands on `/items` (or wherever you came from).
- [x] **Bad password shows Keycloak error.** Try wrong password; Keycloak shows error inline, doesn't crash the portal.
- [x] **Session persists across page reload.** After signing in, hard reload — still authenticated.
- [x] **Sign-out works.** Click your avatar -> Sign out -> lands on the public landing again, no session.
- [x] **callbackUrl preserved.** While signed out, navigate directly to `/items/<some-id>`. After sign-in, lands on that item page (not `/items`).
- [x] **Token refresh is silent.** Leave a tab open for >5 minutes and click around. No "session expired" dialogs (Keycloak's refresh-token flow runs in background).

### 1.2 Edge cases

- [x] **Two browsers, same user.** Sign in as alice in Chrome and Firefox simultaneously. Both sessions work; making a change in one and refreshing the other shows the change.
- [x] **Auto-disable.** As admin, set alice's `autoDisableAt` to a date in the past. Alice (already signed in) can keep working until token refresh; new sign-in attempts fail.
- [x] **Password reset flow.** As admin in `/admin/users`, click reset password for alice. Email or Keycloak-side reset link works.

---

## 2. Public landing page

- [x] **Org name + hero render.** Configured branding (title, subtitle, hero image) appears.
- [x] **Public items grid populates.** If at least one `access: public` item exists, it shows in the grid.
- [x] **Item card click opens runtime.** Clicking a card opens the runtime (e.g. viewer for a viewer web_app, in a new tab via `target="_blank"`).
- [x] **`landingShowPublicItems = false` hides the grid.** Admin toggles this in `/admin/branding`; public landing now shows just the hero + sign-in CTA.
- [x] **Empty-state copy.** With no public items, the grid section shows "Nothing has been shared publicly yet" instead of crashing.
- [x] **Schema.org JSON-LD is present.** View source; `<script type="application/ld+json">` tag exists with `CollectionPage` + `ItemList`.
- [x] **Project marketing section.** With `NEXT_PUBLIC_PROJECT_LANDING=1` (or `?preview=project` query param), the open-source project section renders below the hero.
- [x] **Authenticated user lands but sees public CTA become "Open my items".** Sign in, navigate to apex domain again; CTA now says "Open my items" and links to `/items`.

---

## 3. Items list

### 3.1 Browse and filter

- [x] **Default scope is "My items".** Lands on `/items`; only items owned by the current user appear.
- [x] **All items toggle.** Click "All items"; visible item set expands to include items shared with the user / org / public.
- [x] **Search bar filters.** Type partial title; grid narrows; clears on backspace.
- [x] **Type filter chip.** Click a type chip (e.g. "Maps"); grid narrows to that type. Multiple type chips combine OR.
- [x] **Owner filter.** As admin viewing "All items", filter by another user's id; grid narrows.
- [x] **Bbox filter ("In this area").** Toggle the area filter; only items whose bbox intersects the current map extent show.
- [x] **Tag click filters by tag.** Clicking a tag chip on an item card narrows to all items with that tag.

### 3.2 Folders

- [x] **Folder rail renders.** Left sidebar shows folder tree; can expand/collapse.
- [x] **Click a folder navigates.** URL becomes `/items?folder=<id>`; main grid shows that folder's contents.
- [x] **Breadcrumbs above grid.** Clicking a parent breadcrumb navigates back up.
- [x] **Create folder.** "+ New folder" button opens prompt; new folder appears in rail.
- [x] **Drag item into folder.** Drag a card from the grid onto a folder in the rail; item now appears in that folder.
- [x] **Subfolder creation.** Nest a folder inside a folder; rail shows the hierarchy.
- [x] **Smart folders (saved query).** Create a smart folder; populate criteria; verify items matching the criteria appear.
- [x] **Folder cycle prevention.** Try to make folder A a child of folder B that's already a child of A; portal refuses.
- [x] **Folder share cascades.** Share a folder with bob; bob can see all items inside.

### 3.3 Item creation

- [x] **+ New button.** Clicking opens `/items/new` wizard.
- [x] **Type picker shows all groups.** Five groups visible: Data, Maps, Apps, Analysis, Organize. Each group has the right tile set.
- [x] **Pick "Data layer" -> wizard advances.** Proceeds to step 2 with a title field + an Import tab.
- [ ] **Import tab probes a GeoJSON.** Drop a small `.geojson` file; wizard shows feature count + field schema.
- [ ] **Import tab probes a Shapefile zip.** Drop a `.zip` containing `.shp + .shx + .dbf + .prj`; same probe surface.
- [ ] **Import tab probes a GeoPackage.** `.gpkg` works.
- [x] **Import tab probes a GDB zip.** `.zip` of a File Geodatabase works.
- [ ] **Type-specific inputs render.** Pick "Connected service" (or ArcGIS service); URL field appears with probe button.
- [ ] **Probe a known good ArcGIS REST URL.** Wizard auto-detects the protocol and fills in defaults.
- [ ] **Wizard step 2 access selector.** Three options: Private / Organization / Public; descriptions render under each.
- [x] **Submitting creates the item and redirects to the detail page.**

### 3.4 Item context menu

- [x] **Right-click (or three-dot) menu opens.** On an item card.
- [x] **Share opens sharing panel.** With current shares + access level prefilled.
- [x] **Edit opens metadata edit page.** `/items/[id]/edit`.
- [x] **Delete soft-deletes.** Item moves to trash; disappears from list.
- [x] **Add to folder works.** Item appears in chosen folder.
- [ ] **Reassign owner (admin only).** Visible only to admins; transfer flow completes.

### 3.5 Empty states

- [x] **No items at all.** New user with zero items sees a "Create your first item" CTA.
- [x] **No items in a folder.** Empty folder shows "This folder is empty".
- [x] **No items match search.** Search for nonsense; "No items match" copy renders.

---

## 4. Item detail pages by type

For each item type, create one of that type (or open an existing
one), then run through the per-type checks below.

### 4.1 Map item

- [x] **Map detail page renders.** Header (title, badge), MapEditor canvas, sharing panel.
- [x] **MapLibre canvas loads.** Basemap tiles render.
- [x] **Add layer dialog.** Right-rail "Add layer" button opens a dialog with five source tabs: Portal (with Items / Groups / Folders sub-tabs and search), File, Paste, URL, ArcGIS.
- [x] **Pick a data_layer.** Layer is added to the map; renders with default style.
- [x] **Pick a v3 multi-sublayer data_layer.** Per-sublayer fan-out: each sublayer becomes its own MapLayer entry.
- [x] **Layer panel toggle visibility.** Click eye icon; layer hides/shows.
- [x] **Layer panel reorder.** Drag a layer up/down; render order changes.
- [x] **Layer group.** Create a group; drag layers into it; toggling the group cascades.
- [x] **Style editor.** Open a layer's style; change point color; canvas updates live.
- [x] **Renderer editor: simple, unique-values, class-breaks.** Each kind renders correctly.
- [x] **Popup editor.** Add fields to popup; click feature on map; popup shows those fields.
- [x] **Labels editor.** Toggle labels on; labels render.
- [x] **Filter editor (single clause).** Add `field == value`; only matching features render.
- [x] **Scale visibility.** Set min/max zoom; layer hides outside range.
- [x] **Layer-level boundary clip (geo_boundary).** Pick a boundary; only features inside render.
- [x] **Per-share row scope (own / all).** Share with bob at `view, rowScope=own`; bob sees only his own features.
- [x] **Default extent boundary.** Pick a geo_boundary as default extent; map opens zoomed to it.
- [ ] **Search bar (address).** Type an address; nominatim returns results; click flies map to it.
- [ ] **Search bar (per-layer attribute).** Configure attribute search on a layer; type a value; matching features highlight.
- [x] **Save persists changes.** Edit something; refresh; change is still there.

### 4.2 Data layer item (v3 multi-layer)

- [x] **Detail page renders.** Schema editor, sublayer list, provenance panel, version history.
- [x] **Add sublayer.** New sublayer with geometryType + fields appears.
- [x] **Add field to sublayer.** Field appears in schema; ingest reads from JSONB attrs (no DDL).
- [ ] **Mark a field as `searchable`.** Engine creates the corresponding btree expression index automatically (manual verification: `\d observation` shows the expression index).
- [ ] **Per-feature add via map editor.** Open the map editor for a layer; click "Add point"; place a feature; attribute form opens; save.
- [ ] **Edit a feature's geometry.** Select feature; "Edit geometry" pane opens; drag vertex; save.
- [ ] **Edit a feature's attributes inline (attribute table).** Click an attribute table cell; type new value; saves on blur.
- [ ] **Delete a feature.** Select; click delete in the pane; row disappears from table + map.
- [ ] **Bitemporal asOf read.** Hit `/api/portal/items/<id>/layers/<key>/geojson?at=<past-timestamp>`; older view returns.
- [ ] **Version history panel surfaces edits.** Each create/update/delete observation appears.
- [ ] **Bulk delete via attribute table.** Select multiple rows; bulk-delete button; rows tombstoned.
- [ ] **Schema break notification.** Drop a field that's referenced by a deployed data_collection; admin and field downloaders get notification.
- [ ] **Replace-mode ingest.** Re-import the same file via the layer's import tab in "replace" mode; old observations cleared, new set inserted.

### 4.3 Map editor pane

- [ ] **Edit-mode pane is right-docked.** Top-right; matches AGO's layout.
- [ ] **Tools pill ordering.** Basemap, Layers, Attribute Table, Measure, Select, Edit.
- [ ] **Crosshair cursor in Add mode.** Switching to Add mode changes cursor over the map canvas.
- [ ] **Hide Create-features list during geometry edit.** When editing geometry, the "Create features" template list hides.
- [ ] **Auto-cancel pendingGeometryEdit on tool switch.** Start a geometry edit, switch to a different tool; pending edit cancels.
- [ ] **Measure pane.** AGO-style narrow vertical pane with unit toggle (m/km, ft/mi).
- [ ] **Measure unit changes update display.** Switch units; readout converts.
- [ ] **Selection sync between map + attribute table.** Click a feature on map; row highlights in attribute table. Click row in table; feature highlights on map.
- [ ] **Show only selected toggle in attribute table.** Filter button; table narrows to selection.
- [ ] **Hidden system columns.** `_global_id`, `_created_at`, etc. are hidden by default.
- [ ] **Pick-list cells render as selects.** A cell whose field has a `pickListItemId` renders as a dropdown of the pick list values.
- [ ] **"Edit history" button label** (was "Track edits").

### 4.4 Derived layer item

- [ ] **Detail page renders.** Source picker, pipeline editor, output schema preview.
- [ ] **Pick source data_layer.** Schema dropdown populates with that layer's fields.
- [ ] **Add a buffer step.** Distance + units; output schema previews.
- [ ] **Add a chained step.** Buffer -> centroid; output is centroid points.
- [ ] **Tools available:** buffer, centroid, convex-hull, dissolve, fishnet, simplify, densify, vertices, calculate-geometry, nearest-neighbor, random-sample, top-n, bbox.
- [ ] **Save and view in a map.** Add the derived layer to a new map; renders correctly.
- [ ] **Source layer write triggers cache refresh.** Add a feature to the source; derived layer updates.

### 4.5 Form item

- [ ] **Form designer renders.** Question canvas, palette of question types, properties panel.
- [ ] **Question types:** text, number, date, single-choice (radio), multi-choice (checkbox), select (dropdown), file upload, photo, sketch, audio, video, barcode, geo-point, geo-line, geo-polygon, repeat group, attachment group.
- [ ] **Drag a question onto canvas.** Question appears; properties panel opens.
- [ ] **Question rules (required, default value, conditional visibility).** Each works.
- [ ] **Pick-list reference on a select question.** Pick list dropdown shows values from the referenced item.
- [ ] **Linked data layer auto-populates.** Form gets a paired data_layer; submissions write rows there.
- [ ] **Open form runtime.** "Open" button opens `/forms/<id>/respond` in new tab.
- [ ] **Submit a response.** Form renders correctly; required-field validation works; submit succeeds.
- [ ] **View responses.** Form's Responses page lists submissions; each can be opened.
- [ ] **Schema mutation flow.** Add a field after a deployment is in the field; field crew gets a schema-break notification.
- [ ] **Form export / import (portable JSON).** Export a designed form to JSON; import to a different form item; questions match.

### 4.6 Web app templates (Editor / Viewer / Survey / Custom)

- [ ] **Editor template detail page.** Configure a runtime workspace; canvas + tools + layer targets.
- [ ] **Editor runtime opens.** `/items/<id>/editor/run` loads with the configured map + edit tools.
- [ ] **Viewer template detail page.** Reference map + targets + toolbar trim.
- [ ] **Viewer runtime opens.** `/items/<id>/viewer/run` loads as a read-only view.
- [ ] **Survey template detail page.** Form binding + reference map.
- [ ] **Survey runtime opens.** `/items/<id>/survey/run` loads.
- [ ] **Convert to custom button.** From Editor / Viewer / Survey, click "Convert to custom"; modal explains it's one-way; confirm; page reloads on the Custom designer with map + targets carried over.

### 4.7 Custom web app (designer + runtime)

- [ ] **Custom designer opens.** Three panes: palette / canvas / inspector.
- [ ] **Drag a Map widget onto canvas.** Widget appears at drop position; auto-binds to the app's default map if there's only one.
- [ ] **Drag every widget kind.** Map, legend, layer-list, attribute-table, text, chart, search, print, select, basemap-gallery, image, button, divider, embed, bookmark, coordinates, my-location, tabs.
- [ ] **Resize widget.** Grab a corner handle; widget resizes; grid snaps.
- [ ] **Move widget.** Drag widget body; widget reflows.
- [ ] **Tabs widget.** Drop child widgets into different tabs; switching tabs in designer shows the right children.
- [ ] **Inspector panel.** Selecting a widget opens its config in the right rail.
- [ ] **Tool-mode display.** Toggle a widget (e.g. Layer List) to "tool" mode; in runtime it shows as an icon button + popover.
- [ ] **Save and open runtime.** `/items/<id>/custom/run` renders the configured layout.
- [ ] **Map widget renders.** With basemap + visible target layers.
- [ ] **Layer-list, legend, basemap-gallery, search, print, select.** Each binds to the configured map and works.
- [ ] **AttributeTable widget.** Loads features, click row syncs to map.
- [ ] **Chart widget renders (Recharts).** Bar / line / pie variants. Aggregation (count / sum / avg / min / max) produces correct output.
- [ ] **Text widget renders markdown.** Bold, italic, links, lists.
- [ ] **Image / button / divider / embed.** Each renders.
- [ ] **Bookmark / coordinates / my-location.** Each binds to a map and updates camera / display correctly.

### 4.8 File item

- [ ] **File detail page renders.** Filename, size, MIME type, upload date, preview if applicable.
- [ ] **Image preview inline.** PNG / JPG renders.
- [ ] **PDF preview inline.** PDF renders in an iframe or pdfjs.
- [ ] **Download button.** Gated by canDownload; downloads the file.

### 4.9 Pick list item

- [ ] **Pick list editor renders.** Code-label list with add/remove/reorder.
- [ ] **Add a value.** Persists.
- [ ] **Reference from a data_layer field.** Field's editor shows the dropdown.

### 4.10 Geo-boundary item

- [x] **Polygon editor renders.** MapLibre canvas with draw tool.
- [ ] **Draw a polygon.** Save; appears as named region.
- [ ] **Reference from a share geo-limit.** Polygon clip applies.
- [ ] **Reference from a layer-level boundary clip.** Polygon clip applies.
- [x] **Reference from a map's default extent.** Map opens zoomed to it.

### 4.11 Basemap item

- [ ] **Basemap detail.** Tile URL + attribution + thumbnail.
- [ ] **Org default basemap (positron) loads.** Confirmed satellite swapped to USGS National Map URL.
- [ ] **New custom basemap renders.** Add a custom URL (e.g. a Maptiler tile URL); save; pick on a map; tiles render.
- [ ] **Built-in basemap seeds.** OSM, Positron, Voyager, Dark matter, Satellite all selectable.

### 4.12 ArcGIS service / WMS / WFS / Service (unified)

- [ ] **URL probe auto-detects protocol.** Paste an arcgis-rest URL; protocol detection identifies it as FeatureServer / MapServer.
- [ ] **Layer picker.** Service has multiple sublayers; can select which to expose.
- [ ] **Credential management.** For an auth-required service: paste credentials; portal proxies the request; consumers don't see the secret.
- [ ] **Add to a map.** Service item appears in the Add Layer dialog and renders.

### 4.13 Folder item

- [x] **Folder detail page.** Child item list, breadcrumbs, edit button.
- [x] **Add items to folder.** Can drop items in.
- [x] **Edit folder title / description.** Persists.
- [x] **Smart folder (saved query) populates.** Configure criteria; matching items appear automatically.

### 4.14 Data collection item

- [ ] **Data collection detail.** Map binding, form binding, field-mode UI presets.
- [ ] **Deploy to field PWA catalog.** Item appears in `/field`.
- [ ] **Field worker downloads for offline use.** Catalog button triggers offline cache.

### 4.15 Dashboard

Dashboards are web apps, not their own item type. Create a web app
and pick KPI Dashboard or Operations Board. A leftover `dashboard`
row explains that and links to the web app builder. It does not show
a coming-soon placeholder.

- [ ] KPI Dashboard template opens in the web app builder with an indicator or chart.
- [ ] A legacy dashboard item points at Create a web app and does not promise a dedicated editor.

### 4.16 Report template item

Document report templates are not built. The create picker does not
offer `report_template`. Print templates are a different, shipped
item.

- [ ] A leftover report template item shows the coming-soon notice. No editor.

---

## 5. Sharing model

- [x] **Set access to private.** Only owner can see the item.
- [x] **Set access to org.** Same-org users can see.
- [x] **Set access to public.** Anonymous users (incognito) can see.
- [x] **Add a per-user share at view tier.** Bob (different org) can read.
- [ ] **Add a per-user share at download tier.** Bob can use the GeoJSON download endpoint.
- [x] **Add a per-user share at edit tier.** Bob can edit attributes.
- [ ] **Add a per-user share at admin tier.** Bob can edit but not reassign owner / purge.
- [ ] **Per-group share.** Share with a group bob is in; bob inherits access.
- [ ] **Time-bounded share.** Set expiresAt to 1 minute from now; wait; bob loses access.
- [x] **Geo-limited share.** Attach a polygon to bob's share; bob sees only features inside.
- [x] **Per-share row scope (own / all).** Bob with rowScope=own only sees features he created.
- [ ] **canRead via Cedar.** Verified in unit tests; manually: cross-org user without share gets 404 on item detail.
- [ ] **canAdmin still owner-/org-admin only.** Even with admin-tier share, bob can't reassign ownership.
- [ ] **Layer-level access matrix on web maps.** A map shared org-wide can hide a specific layer from a specific group.
- [x] **Sharing panel dependency audit.** For an editor item, the panel warns if shared targets aren't reachable for the share recipient.

---

## 6. Field PWA

> Run on a phone (or Chrome's mobile emulator at iPhone 13 portrait).

- [ ] **`/field` catalog loads.** Lists all data_collection items the user has access to.
- [ ] **Per-row offline cache state.** Fresh row shows "Available offline" toggle off.
- [ ] **Download for offline.** Tap toggle; cache populates; row shows "Up to date".
- [ ] **Tile cache.** Pan + zoom around the layer's extent; tiles cached; turn off network; tiles still render.
- [ ] **Form fill.** Open a deployed form; fill fields; submit. Online: appears in Responses immediately.
- [ ] **Offline form submit.** Turn off network; submit; entry queued.
- [ ] **Queue indicator.** Catalog shows queued-edit count per item.
- [ ] **Sync on reconnect.** Turn network back on; queue drains; submissions appear in Responses.
- [ ] **Per-edit retry on failure.** If one row fails (e.g. validation error), it stays queued without poisoning subsequent rows.
- [ ] **Schema-break notification.** Admin drops a field referenced by a deployed form; field worker sees a "Schema changed; sync required" banner.
- [ ] **Sign out + sign in on field.** Session expiry shows a clear sign-in CTA with callbackUrl back to the catalog.
- [ ] **Persistent GPS strip.** While in field-mode, the GPS chip stays visible at top.
- [ ] **GPS metadata stamps.** Each captured feature has lat/lng/accuracy/altitude in the right metadata columns.
- [ ] **Photo / sketch / audio / video / barcode capture.** Each works on mobile.
- [ ] **Geo-point / line / polygon capture.** Each draws on the map.
- [ ] **Repeat groups.** Add multiple instances of a repeat-group question.
- [ ] **Add to home screen.** The PWA installs; opens full-screen.

---

## 7. Profile & settings

- [ ] **`/profile` page loads.** Identity fields editable, role/org read-only.
- [ ] **Edit first name.** Saves; reloads with the new value.
- [ ] **Avatar upload.** Pick image; uploads; appears in top bar.
- [ ] **Avatar remove.** Falls back to initials badge.
- [ ] **Notification preferences page.** `/settings/notifications` lists notification types per channel.
- [ ] **Toggle a notification type.** Optimistic UI; saves immediately.
- [ ] **Sign out from profile.** Same flow as top-bar sign-out.

---

## 8. Groups

- [ ] **`/groups` lists groups user has access to.** Empty state if none.
- [ ] **Create new group.** Title, description, access selector, optional thumbnail.
- [ ] **Group detail page.** Header (thumbnail, title, access chip), description, owner, member list.
- [ ] **Add member.** Pick a user; add as member or admin.
- [ ] **Promote member to admin.** Member's chip changes.
- [ ] **Remove member.** Member loses access; group's count decreases.
- [ ] **Owner-not-member badge.** If owner removed self from membership, badge appears as a reminder.
- [ ] **Edit group metadata.** Title, description, access, thumbnail. Owner / org-admin only.
- [ ] **Delete group.** Soft-delete; appears in `/groups/trash`.
- [ ] **Restore deleted group.** From trash; group + members come back.
- [ ] **Share an item with the group.** Group members see it.

---

## 9. Recently deleted (trash)

- [x] **`/recently-deleted` lands on Items tab by default.**
- [x] **Items tab shows trashed items.** Within 30-day retention.
- [x] **Restore an item.** Returns to its original folder + access state.
- [x] **Permanent delete (purge).** Owner / admin only; confirms before purging; item is gone for good.
- [ ] **Cascade-revert candidates.** When restoring an item that has dependents, surfaces what else might need to come back.
- [ ] **Groups tab.** Same flow for trashed groups.
- [x] **Empty state.** No trashed items shows the empty copy.

---

## 10. Admin surfaces

> Sign in as admin user.

### 10.1 Branding (`/admin/branding`)

- [x] **Page renders.** Org name, landing title, subtitle, hero image.
- [x] **Edit landing title.** Save; public landing reflects it.
- [x] **Upload hero image.** Save; renders behind hero band.
- [x] **Toggle "show public items".** Save; public landing grid disappears or reappears.
- [x] **Featured items picker.** Pick 1-3 items to surface first; they reorder on the public landing.

### 10.2 Users (`/admin/users`)

- [x] **User list renders.** With filters for enabled / verified / last-seen.
- [ ] **Filters work.** Each narrows the list correctly.
- [ ] **Edit user identity.** First/last/email; saves to Keycloak.
- [x] **Reset password.** Triggers Keycloak reset flow.
- [x] **Disable user.** Sets enabled=false; user can't sign in.
- [x] **Auto-disable date.** Sets future date; banner shows for that user.
- [x] **Resend invite email.** Goes out via SMTP.
- [x] **Remove user.** Confirms before deleting from Keycloak + portal.
- [ ] **Helpful banner if Keycloak admin integration unconfigured.** When KC admin service account isn't set up, page surfaces a friendly explanation instead of failing silently.

### 10.3 Notifications platform (`/admin/notifications`)

- [x] **Page renders.** Notification types listed with enable/disable toggles.
- [x] **Test send.** Triggers a test email; arrives.
- [ ] **Per-org template editor.** Open a template; edit copy; saves.
- [ ] **Variable insertion picker.** Click-to-insert known variables (`{{user.name}}`, `{{item.title}}`, etc.); inline preview shows resolved values.

### 10.4 Housekeeping (`/admin/housekeeping`)

- [x] **Summary cards.** Item count, user count, storage usage all populate with real numbers.
- [x] **Stale items list.** Items unused for >90 days; bulk-delete button works.
- [x] **Stale users list.** Users last seen >90 days ago; bulk-disable works.
- [x] **Large items list.** Top 10 by storage.
- [x] **Expiring shares.** Time-bound shares within next N days.
- [x] **Expiring users.** Users with auto-disable dates approaching.
- [x] **Storage breakdown.** Per-table sizes + per-item largest.
- [ ] **Schedule config.** Cron expression editor; last run log shows recent invocations.

### 10.5 Backup (`/admin/backup`)

- [x] **Page renders.** Last backup timestamp, status, manual trigger button.
- [ ] **Manual trigger.** Click; archive job runs; new run appears in history.
- [ ] **Schedule editor.** Daily / weekly / monthly / custom cron.
- [ ] **Retention policy.** Set N days; older archives prune.
- [ ] **Restore flow.** Pick an archive; preview what'd be restored; commit.
- [ ] **Maintenance-mode gate.** During restore, portal is read-only.

### 10.6 Field queue monitor (`/admin/field-queues`)

- [ ] **Per-user queued edit count.** Surfaces who has work pending.
- [ ] **Status breakdown.** Pending / failed / synced.

---

## 11. Esri WebMap interop

- [ ] **Export: GET /api/portal/items/<map-id>/web-map.json.** Returns a valid v2.x WebMap JSON with operationalLayers + baseMap + initialState.viewpoint.
- [ ] **Open in ArcGIS Pro.** Add Data -> From URL -> the export URL; map opens with the layers visible.
- [ ] **Open in QGIS WebMap plugin.** Same URL; layers render.
- [ ] **Import: POST /api/portal/items/web-map-json:import.** Hand it an AGO export; new map item is created.
- [ ] **Round-trip a portal map.** Export to JSON; import into the same portal as a new map; new map renders the same way.
- [ ] **Definition expression preserved (single clause).** Filter on a layer; export; import; filter is on the new map.
- [ ] **Multi-clause definitionExpression.** Export-import drops with a warning (documented behaviour).
- [ ] **Unsupported layer types.** Tiled / Group / Raster -> warning, skipped.

---

## 12. Engine substrate (CLI verification)

> Connect to the dev DB with `psql` for these.

- [ ] **`SELECT COUNT(*) FROM observation;`** Returns the current row count.
- [ ] **Per-partition count.** `SELECT tableoid::regclass, COUNT(*) FROM observation GROUP BY tableoid;` Shows current month with most rows.
- [ ] **Partition list.** `SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'observation'::regclass;` Shows monthly partitions; >24 entries.
- [ ] **pg_partman registered.** `SELECT parent_table, partition_interval, premake FROM partman.part_config;` Shows the observation entry.
- [ ] **No legacy fs_ tables.** `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ '^fs_[0-9a-f]{32}_';` Returns 0 rows.
- [ ] **Engine read works.** `SELECT DISTINCT ON (entity) entity, attrs FROM observation WHERE scope = 'data_layer:<id>:<key>' AND valid_to IS NULL ORDER BY entity, valid_from DESC LIMIT 5;` Returns recent feature rows.
- [ ] **Cedar is loaded by portal-api.** Boot log shows `[PolicyService] Cedar engine ready (sdk=4.13.0, lang=4.5)`.

---

## 13. Cross-cutting concerns

### 13.1 Performance gut check

- [ ] **Items list loads in < 1s.** With ~50 items.
- [ ] **Map page first paint < 2s.** With one data_layer source of ~1k features.
- [ ] **Tile fetch p95 < 300ms.** Pan around at typical zoom; no obvious tile jank.
- [ ] **Form runtime opens in < 1s.** Even on a slow mobile network (Chrome devtools "Fast 3G").

### 13.2 Error states

- [ ] **404 for missing item.** Renders a friendly "Item not found" page, not a stack trace.
- [ ] **403 for inaccessible item.** Same shape as 404 to avoid existence probing (matches the docs/auth-model.md spec).
- [ ] **API error in client.** Trigger a deliberate failure (rename a layer mid-edit on the API side); UI shows a toast / inline error, doesn't crash.
- [ ] **Network error.** Disable network; click around; UI shows offline indicator if applicable; doesn't crash.
- [ ] **Stale token.** Manually expire the JWT in localStorage; next request silently refreshes or redirects to sign-in.

### 13.3 Accessibility

- [ ] **Keyboard navigation through items list.** Tab moves through cards; Enter opens detail.
- [ ] **Sharing panel keyboard accessible.** Tab + Enter operate every control.
- [ ] **Focus indicators.** Visible on all interactive elements (no `outline: none` regressions).
- [ ] **Screen reader hits.** With NVDA / VoiceOver, the items list announces item types + titles.
- [ ] **Color-contrast.** No `text-muted` on `bg-surface-2` reads under 4.5:1.

### 13.4 Mobile

- [ ] **Items list responsive.** Cards stack on phone width.
- [ ] **Map editor falls back to mobile layout.** Right-rail pane becomes a slide-out.
- [ ] **Form runtime mobile.** Tap targets are large enough; geo-capture works.
- [ ] **Field PWA.** Already covered above.

### 13.5 Browser extensions / quirks

- [ ] **uBlock Origin doesn't break the public landing.** Common ad-blocker filter lists shouldn't false-positive any portal endpoint.
- [ ] **1Password / autofill.** Sign-in form accepts password from a manager.

---

## 14. Documentation surface

- [ ] **README links resolve.** Click every link in the top half of the README; each lands on a real doc.
- [ ] **ROADMAP reflects shipped state.** Spot-check 3 random "[x]" items and 3 "[ ]" items; reality matches the marker.
- [ ] **/docs/architecture/observation-log-engine.md is current.** No stale fs_ references.
- [ ] **/docs/architecture/cedar-policy-integration.md is current.** Includes Phase D wiring.
- [ ] **/docs/migration/from-arcgis-online.md walkthrough.** Try the steps end-to-end with a small AGO export.

---

## When you're done

Tally bug-noted items; group by severity:

- **Sev 1 (blocker):** Anything that loses data, leaks data across orgs, or blocks the user from completing a core flow (sign-in, create item, edit, share).
- **Sev 2 (major):** Visible bug that has a workaround. UI glitch that misleads.
- **Sev 3 (minor):** Cosmetic / typos / nitpicks.

File Sev 1s as GitHub issues immediately; batch Sev 2s + 3s into a "v1 polish" milestone.

Re-run Section 11 (WebMap interop) and Section 12 (engine
substrate CLI) after every meaningful engine change. Re-run
Sections 1-3 after any auth / sharing / items list change.
Full pass after every ROADMAP-level milestone.

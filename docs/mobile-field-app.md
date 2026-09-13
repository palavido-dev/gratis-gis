# GratisGIS Field: native mobile app plan

Status: planned, not started. Decided 2026-09-13. Revised the same day
after a review that changed the approach to the form and sync logic
(embedded engine instead of a Kotlin port), cut the auth prerequisite
to a fraction of its first estimate, and added two server items the
first draft missed (edit conflicts, engine versioning).

Scope of this document: the native Android client for `data_collection`
items, and what has to change in portal-api, Keycloak and the shared
packages to support it. iOS is covered only where an Android decision
would foreclose it.

The visual design is settled and lives in `design_handoff_field_app/`.
Read that README before writing any UI. This document is the
engineering plan behind it, and where the two disagree about what the
server stores, this one is correct.

## The decision

Build a native Kotlin + Jetpack Compose app. Android first, iOS after a
Mac is available.

The portable logic is **not** ported to Kotlin. The form engine
(`packages/form-schema`) and the sync helpers in
`packages/shared-types` are bundled into one dependency-free JavaScript
file and run on the device inside an embedded JS engine (QuickJS on
Android, JavaScriptCore on iOS). The Kotlin app is a native shell around
the same logic the server and the web client already run. See "The
engine bundle" below; it is the load bearing idea in this plan.

This supersedes three lines written before the decision, all of which
should be updated to point here:

- `docs/editing-and-collection.md:622` lists native apps as Phase 3,
  demand-driven, "if PWA-only proves insufficient".
- `docs/architecture/observation-log-engine.md:800` lists "A mobile app
  rewrite. The existing field PWA stays." as an explicit non-goal.
- `docs/auth-model.md` described the `field-app` Keycloak client as
  serving a "React Native field app" and specified device-id binding
  and offline JWKS verification. Updated 2026-09-13 to match this
  document.

**The field PWA at `/field` is not being retired.** It stays as the
zero-install path, the desktop-browser path, and the fallback for
devices the app does not support. Two clients, one server contract, one
implementation of the logic that decides what a valid record is.

### Why native, and why not React Native

Four drivers, all of them device-layer:

1. **External GNSS receivers.** Bluetooth and USB NMEA receivers
   (SXblue, Arrow, Bad Elf). The web Geolocation API cannot reach them
   at all. This is the strongest native-only argument and the one that
   screen `1k` in the handoff is built around.
2. **Background and long-session reliability.** Queue drains and track
   logging that survive the screen being off and a multi-hour
   collection day.
3. **Store presence and procurement.** Install from Play, MDM
   deployment, and clients who will not accept a website.
4. **Storage limits and offline durability.** IndexedDB quota ceilings
   and eviction risk against multi-GB tile packages and queued photos.
   `docs/field-offline-areas.md:117` already flags iOS Safari's roughly
   1 GB cap.

React Native was rejected deliberately:

- Three of the four drivers (BLE and USB serial NMEA streaming,
  WorkManager drains with the app killed, CameraX with a live overlay)
  require writing Kotlin under React Native anyway, and then add a
  bridge between the device hot path and the logic that consumes it.
  NMEA at 1 to 10 Hz across the JS bridge is the wrong shape.
- Compose is straightforwardly better for the Material 3 deltas in
  handoff section `1m`, and predictive back is a platform feature that
  React Native tracks behind.

A WebView wrapper around the existing PWA (Capacitor-style, with Kotlin
plugins for GNSS, background drain and storage) was also considered. It
would satisfy all four drivers with one client and no rebuild of the
thirteen screens. It was rejected because the settled design is a
Compose design, not a themed web page, and because the map, camera and
capture screens are exactly the ones where a WebView is weakest. That
is a product call, not a technical one, and it is recorded here so it
does not get re-asked.

The important thing about the four drivers is what they do **not**
require. None of them needs the form engine or the queue logic to be
Kotlin. Form validation, visibility, calculations, queue folding and
replay planning run at human input speed with JSON in and JSON out.
They are the opposite of a hot path. The first draft of this plan
accepted a 4,400-line port and a conformance corpus as the price of
going native. That price was self-inflicted, and the next section
removes it.

Confidence: high on native given the four drivers. The drivers
themselves came from outside this repo and are not re-litigated here.

## The engine bundle

### What it is

One JavaScript file, built from the packages the server and the web
client already run, loaded by the app at startup into an embedded JS
engine with no DOM, no network, no filesystem and no Android API
access. The Kotlin side calls a small fixed set of functions and passes
JSON both ways.

What goes in (all verified pure: no `crypto`, `Intl`, `fetch`,
`window`, `process` or `require` anywhere in these files):

| Package | Lines (non-blank) | What it is |
| --- | --- | --- |
| `packages/form-schema/src/index.ts` | 2,736 | 49 question types, a JSON expression language, `validate`, `isVisible`, `isRequired`, `applyCalculations`, `pruneHidden` |
| `packages/form-schema/src/from-layer.ts` | 466 | `generateFormFromLayer`, the no-authoring fallback path |
| `packages/shared-types/src/feature-validate.ts` | 469 | `validateFeatureProperties` |
| `packages/shared-types/src/queue-fold.ts` | 142 | Same-device edit folding, insert-then-delete annihilation |
| `packages/shared-types/src/queue-replay.ts` | 190 | Retry ladder, 120s claim window, chain-head ordering |
| `packages/shared-types/src/offline-message.ts` | 314 | The code-plus-params i18n envelope for every sync string |
| `packages/shared-types/src/sync-outcome.ts` | 42 | HTTP status to retry / park / success |
| `packages/shared-types/src/submission-stamp.ts` | 113 | Server-stamped field protection |
| `packages/shared-types/src/filter-match.ts` | 99 | Client-side layer filter evaluation |

What stays out: `xlsform-import.ts` (authoring-time, web only) and
anything in `shared-types` that touches `TextEncoder` (`qr.ts`, not
needed on device).

### How it is built

A new workspace `packages/field-engine` with one entry file that
re-exports the functions above behind a flat, frozen surface, and an
esbuild step (esbuild is already a root devDependency, so this adds no
dependency) producing `dist/gratis-field-engine.js` as a single IIFE
targeting ES2020, minified, with a source map kept beside it. The build
also emits `dist/engine-version.json` carrying `ENGINE_VERSION` and the
bundle's SHA-256, which the Android build reads into `BuildConfig` so
the app can report exactly which engine it carries.

The surface is the contract. It is a plain list of
`name(jsonIn) -> jsonOut` functions, each documented in the package
README, and it is versioned public surface in the same sense
`portal-mcp`'s tool names are: adding is fine, renaming or changing a
shape is a breaking change to a shipped app. Keep it flat and boring.
No callbacks, no objects held across calls, no engine-side state except
a loaded form cache keyed by form id.

Bundle size is expected in the low hundreds of KB. The engine binary
(QuickJS) is roughly 1 MB per ABI. Neither matters against tile
packages.

### How the app hosts it

- `:core:engine` owns the JS runtime. One engine instance, one context,
  on a single dedicated background thread; every call is a
  `suspend fun` that marshals to that thread. Form evaluation per
  keystroke goes through it. Expect sub-millisecond calls; measure in
  the skeleton (step 3) before building the form renderers around the
  assumption, and if a call is ever slow the answer is batching on the
  Kotlin side, not moving logic into Kotlin.
- The bundle ships inside the APK as an asset. It is loaded once, its
  SHA-256 is checked against `BuildConfig`, and a mismatch is a fatal
  startup error, not a warning.
- The Kotlin side of the boundary is a thin marshalling layer:
  `kotlinx.serialization` data classes in `:core:model` that mirror the
  JSON shapes in `shared-types`, and nothing else. That layer is the
  only place a parity bug can now live, and it is the kind of bug a
  round-trip test catches.
- Binding, decided 2026-09-13: `io.github.dokar3:quickjs-kt` (1.0.15,
  Apache-2.0, released 2026-09-03). Chosen over Cash App's
  `app.cash.quickjs` because it is Kotlin Multiplatform, coroutine
  native, interruptible with a per-instance timeout, and publishes a
  `-jvm` artifact, so `:core:engine` is unit tested on the desktop
  against the real bundle without an emulator. It is a small project
  (one maintainer, about 150 stars); the mitigation is that the
  surface we use is `create`, `evaluate<String>` and `close`, which a
  few hundred lines of JNI could replace if it ever stops moving.
- No Android API is exposed to the engine. This is a security property
  of the design as much as a simplicity one: the bundle is trusted code
  from this repo, but the boundary should still be one-directional.

For iOS later, `JavaScriptCore` ships with the OS and loads the same
file. That is the whole iOS story for the logic layer.

### Serving the bundle from the portal (not v1)

Because the bundle is a versioned artifact, the portal could serve it
alongside a collection so a device in the field runs the server's exact
engine. That closes the deployed-drift problem in the next section
completely. It is not in v1 because Google Play's policy on downloaded
executable code has an exception for interpreted code that is worded
around WebViews and browsers, and whether a QuickJS-loaded bundle
clearly falls inside it is not something to find out from a rejection.
Ship the bundle in the APK. Revisit once the app is in production and
the policy can be checked against a real listing.

### The conformance corpus, demoted

The first draft made a shared fixture corpus a prerequisite for writing
any Kotlin form code, because a Kotlin port could drift from the
TypeScript. There is no port now, so the corpus no longer gates the
Android work. It is still worth building, for two smaller reasons:

- It exercises the host integration end to end: bundle loads, each
  surface function round-trips through the Kotlin marshalling layer
  and returns what the TypeScript spec says. That is the test for the
  one place a bug can still hide.
- `packages/shared-types` running the subset that maps onto
  `validateFeatureProperties` ties the two existing validators
  together. That gap exists today and is worth closing regardless of
  whether the Android app happens.

Layout as before, `packages/form-schema/conformance/cases/*.json` with
`{ form, response, expected: { visible, required, calculated,
violations } }`, generated by enumerating the TypeScript implementation
and then frozen. The Android side is an instrumented test in
`:core:engine` reading the same directory. It is a gate for the
production release (step 8), not for step 3.

One rule from the first draft is corrected: a case is not "never
edited". It is edited only in a commit that bumps `ENGINE_VERSION`, and
the README says so.

## Engine versioning

This is the problem the corpus could never have solved and the first
draft did not name. The web client always runs the server's version.
An APK in the field runs whatever was installed months ago. When
authoring gains a question type, an expression builtin or a validation
rule, an old app evaluates the form wrong, and nothing in the repo
detects it because every commit was green on its own.

The fix is small and belongs in `packages/form-schema`, so the web
client and the server get it too:

- `ENGINE_VERSION`, an integer, exported from `form-schema`. Bumped in
  any commit that changes evaluation behaviour. The corpus README and
  a spec both say so.
- Every question type, expression builtin and `FieldViolationCode`
  carries the engine version it was introduced in, in the same tables
  that already define them. `requiredEngineVersion(form)` walks a form
  and returns the maximum. This is a table lookup, not a heuristic;
  do not replace it with "stamp the server's current version", which
  would force an app update on every deploy for forms that use nothing
  new.
- The server stamps `requiredEngineVersion` onto the form item's data
  on every create and update (`apps/portal-api/src/forms/form-engine-stamp.ts`,
  called from `ItemsService`), replacing whatever the client sent. It
  is server state in the same sense `linkedLayerId` is. It is not
  denormalised onto the `data_collection` item: forms change
  independently of the collections that bind them, and the app has to
  fetch each bound form's schema to render it anyway. Forms saved
  before the stamp existed carry none; the app computes the same
  value locally through `form.requirement` in that case, which is
  also what it does for the auto-generated no-authoring forms.
- The app compares against its own `ENGINE_VERSION`. A collection whose
  forms need a newer engine opens in drain-only mode: queued records
  still sync, capture is disabled, and the message says to update the
  app. Never silently evaluate with an older engine.

Shipped 2026-09-13: `packages/form-schema/src/engine-version.ts`
(tables, `engineRequirement`, `requiredEngineVersion`,
`engineSupports`), the server stamp, and `packages/field-engine`
(the bundle, its `call` entry point, the vm-context spec). See that
package's README for the surface.

This applies to the web PWA too, in principle, but the PWA is served by
the same deploy as the server, so the check is always trivially true
there. It still gets the check; it costs nothing and keeps one code
path.

## Server prerequisites

Less than the first draft said, and only one item blocks the closed
track. Sequence it that way.

### 1. Mobile auth: mostly exists already

The first draft said none of the mobile auth existed in code. That was
wrong, and it is the good kind of wrong. Verified 2026-09-13:

- `apps/portal-api/src/auth/jwt.strategy.ts` validates any RS256 token
  issued by the realm, with `audience: undefined`. A token from any
  realm client is accepted. portal-api needs no change to accept a
  mobile client's token.
- `infra/keycloak/realm-gratis-gis.prod.json.tmpl` already defines a
  `qgis-plugin` client: public, standard flow, PKCE S256, a native
  redirect scheme (`gratisgis-qgis://auth-callback`) plus a loopback
  redirect, and `org` / `org_role` protocol mappers. `infra/deploy.sh`
  reconciles it into the live realm on every deploy and grants
  `offline_access` to every user so refresh tokens survive.
- The realm does not set `offlineSessionIdleTimeout`, so Keycloak's
  default of 30 days applies to offline sessions. That is the "30-day
  refresh TTL" the auth doc asked for, already in effect.

The QGIS plugin is a native client doing the authorization-code-plus-
PKCE flow with an offline refresh token against this portal, in
production, today. The Android app is the same flow with a different
redirect scheme. Keycloak is the token endpoint; PKCE lives in the app
and in Keycloak; portal-api only ever sees a bearer JWT. "No token
endpoint on portal-api, no PKCE implementation" was a category error.

Done 2026-09-13 (checked against the live realm first):

- A `field-app` client already existed, in both realm templates since
  the first prod scaffold and live in prod with PKCE S256 and the
  `org` / `org_role` mappers. What it had wrong was a leftover from
  the React Native plan: a portal-wide `https://gratisgis.org/*`
  redirect plus a web origin (and an Expo `localhost:19000` redirect
  in the dev realm). The templates now carry the native scheme only,
  `gratisgis://auth-callback`, and `deploy.sh` and `restore-golden.sh`
  both reconcile the live client to that list on every run, since the
  import pass never touches an existing client and the nightly golden
  restore would otherwise undo a one-off edit. The two scripts also
  gained a shared `kc_ensure_client` so a realm created from an older
  template gets `field-app` the same way it gets `qgis-plugin`.
- `offlineSessionIdleTimeout` is pinned to 2592000 in both templates
  and by both reconcile scripts. Live it was already that value by
  default.
- The Android redirect URI is therefore `gratisgis://auth-callback`
  (not `gratisgis-field://`, which an earlier draft of this document
  proposed before the existing client was found).

App side, shipped 2026-09-13 in `clients/android/feature/auth`:
authorization code + PKCE in a Custom Tab, `openid offline_access`,
tokens AES-GCM under an Android Keystore key. **Not AppAuth-Android**:
its last release was 0.11.1 in December 2021, and the flow is a URL,
one form POST and a redirect, so it is hand-rolled and unit tested
against the RFC 7636 vector and a mock token endpoint. The access
token's claims are read without verifying the signature, per
`docs/auth-model.md`. If portal-api ever starts checking `aud`,
`field-app` and `qgis-plugin` both need to be in the accepted set.

Bootstrap is from one URL: `GET /api/portal-info` (already public,
built for exactly this) returns the OIDC issuer and the API base, and
the app caches it so a cold start offline still knows both.

Dropped from the first draft, deliberately:

- **Offline verification against a cached JWKS.** The app received its
  token from Keycloak over TLS. Verifying that token's signature on the
  device defends against an attacker who can write to the app's private
  storage, and that attacker can replace the cached JWKS in the same
  write. It is work that protects nothing. The app reads `exp` and the
  identity claims from the token without verifying, treats a past `exp`
  as "refresh when online", and lets the server be the verifier, which
  it already is.
- **Device-id claim binding and a portal-side device registry.**
  Keycloak offline sessions are already one per device login, listable
  and revocable per user through the admin console (reachable over the
  SSH tunnel, see `infra/Caddyfile`) and the Admin REST API, which
  portal-api already talks to over the docker network. "Revoke this
  phone" is "revoke this offline session". v1 ships plain offline
  refresh tokens and uses Keycloak's surface for revocation. A portal
  admin page that lists and revokes a user's offline sessions is a
  thin proxy to Admin REST and can come later if operators want it in
  the portal rather than in Keycloak. No new claim, no new table.

That resolves the "device-id in v1 or plain refresh token" question from
the first draft: plain refresh token, and per-device revocation comes
with it.

### 2. Config fields the design assumes and the server has never stored

The handoff and `docs/editing-and-collection.md` describe a
`data_collection` shape that does not exist. Shipped `DataCollectionData`
(`packages/shared-types/src/data-collection.ts`) is four fields:
`version`, `mapId`, `formBindings?`, `offlineAreas?`, plus an `offline?`
key the file itself marks as a tombstone.

| Design calls for | Reality | Decision |
| --- | --- | --- |
| `ownEditWindow` (ISO 8601, default P30D) | Does not exist. The runtime uses `editingPolicy: 'all-rows' \| 'own-rows-only'` on the data_layer sublayer. `rowScope` ships on share rows and Editor targets, not here. | In v1. Server work: the field on `DataCollectionData`, enforcement in `effectiveRowScope` measured from the observation's server-received time (never the device clock), and the remaining window returned with the feature so screen `1h` can show it. A window that is displayed but not enforced is a UI fiction; do not ship the display first. Blocks `1h` only. |
| `formVersionId` | Does not exist. Forms carry `schemaVersion: number` (always 1); features carry a `schemaHash`, a SHA-256 of the canonical field list from `hashLayerSchema()`. Detects drift, does not version-map. | Ship screen `1g`'s drift warning against `schemaHash` plus the engine version check above. Proper form version identity and submission-to-version mapping stay where `docs/forms-schema-mutation.md` already specifies them, as later work. `1g` gets the same user-facing warning for a fraction of the server work. |
| `mode: 'map' \| 'form'` | Does not exist. Map mode only. Form mode ships as the separate `/forms/[id]/respond` surface. | Out of v1. `data_collection` stays map mode; `POST /api/forms/{id}/submissions` leaves the v1 wire protocol; the form-mode variant of `1g` is deferred. Reversible later without a migration, since it is additive. |
| `workAreaPolygon` | Does not exist. Superseded by server-built `offlineAreas: OfflineArea[]`. | Drop from the design. The replacement is better. |
| `tilePackage` | Does not exist as config. Shipped as client-side tile warming plus server-built PMTiles packages. | Drop from the design. |

### 3. Edit conflicts

Not in the first draft at all. Verified: `PATCH features/:fid` in
`apps/portal-api/src/data-layer/features.controller.ts` carries no
`If-Match` and no base version. Two devices editing one feature offline
is last-write-wins, silently, whichever drains second. The web PWA has
the same behaviour today, so this is not a regression, but the app's
whole pitch is multi-device multi-hour days, and the design has a
review flow for schema drift (`1g`) and nothing for the more common
case.

Decision: PATCH and DELETE gain an optional `baseObservationId` in the
body. When present and not the feature's current head observation, the
server returns 409 with the current feature in the body. When absent,
behaviour is unchanged. The observation log makes the check one indexed
lookup. The Android client always sends it and parks a 409 into the
`3a` review flow with both versions shown; the web PWA opts in when it
is next touched. `clients/python` already has a `ConflictError`, so the
error taxonomy does not change.

### 4. Rate limiting

The global throttle is 300 requests per 60 seconds per IP, memory-backed
per process across two replicas, with `trust proxy` set to 1 so the IP
is the true peer behind Caddy. A crew of ten behind one field NAT shares
one bucket, and a drain is bursty: dozens of feature rows, a presign per
attachment, and tiles on the way back to the map. The first draft said
"check whether this trips". It will. The fix is server-side and small:
a `ThrottlerGuard` subclass whose `getTracker` returns `user.sub` when
the request is authenticated and the IP otherwise. `PublicModule`,
`FeedbackModule` and `GeocodingModule` keep their own tighter per-route
limits, which are per-IP by design.

The client still implements `If-None-Match` / 304 on tiles and honours
503 `Retry-After`; those are unrelated to the bucket.

## What the app talks to

The wire protocol is small. This is the whole surface for v1.

Writes:

```
POST   /api/items/{dataLayerId}/layers/{layerKey}/features
PATCH  /api/items/{dataLayerId}/layers/{layerKey}/features/{globalId}
DELETE /api/items/{dataLayerId}/layers/{layerKey}/features/{globalId}
POST   /api/storage/presign-upload
PUT    {presigned url}                       (no Authorization header)
POST   /api/items/{id}/layers/{layerKey}/features/{globalId}/attachments
POST   /api/field/queue-manifest             (telemetry, 204, optional)
```

Reads:

```
GET /api/items?type=data_collection&full=1
GET /api/items/{id}
GET /api/items/{id}/layers/{layerKey}/geojson
GET /api/items/{id}/layers/{layerKey}/features?entity={globalId}
GET /api/items/{id}/layers/{layerKey}/tile/{z}/{x}/{y}.mvt
GET /api/items/{itemId}/offline-areas
GET /api/items/{itemId}/offline-packages/{packageId}/file
```

These are portal-api's own routes, reached directly. Verified in
`infra/Caddyfile`: `/api/*` is routed straight to portal-api, with only
`/api/auth/*`, `/api/portal/*`, `/api/geocode/*` and `/api/locale`
owned by portal-web. Presigned PUTs go to the public storage host, also
fronted by Caddy, so nothing here needs a new ingress.

The web client does not use these routes directly: it goes through the
BFF catch-all at `apps/portal-web/src/app/api/portal/[...path]/route.ts`,
which attaches the Keycloak access token server-side, does
anonymous-fallback rewriting, stale-token warning, `revalidatePath`
calls, and a long-timeout agent for ingest and export. A native client
bypasses all of that, not just a path prefix. Anywhere the web runtime
appears to get behaviour for free, check whether that handler is the
thing providing it.

Contracts that are easy to get wrong:

- **There is a second, unrelated feature API.**
  `apps/portal-api/src/features/features.controller.ts` serves
  `@Controller('items/:id/features')` with its own `POST`, `PATCH :fid`
  and `DELETE :fid`. That is the legacy v1/v2 path and the field runtime
  does not use it. `GET /api/items/{id}/geojson` likewise exists
  separately from the per-layer one. Both are easy to hit by mistake and
  will appear to work.
- **Features key on a client-generated `globalId`**, enforced in SQL
  under an advisory lock, returning `{ inserted, deduplicated,
  globalIds }` with `globalIds` order-aligned to the request. (Form
  submissions use a different scheme keyed on `clientId`; they are out
  of v1, but if they come in later, do not unify the two. The web
  client keeps them in separate IndexedDB databases for this reason.)
- **Batch cap is 5,000 features per POST**, with the source comment
  noting real sync flushes ship dozens of rows.
- **Tiles carry only `_global_id`.** Online, a tap fetches attributes
  via `?entity=<id>`. Offline there is no `?entity=`, so the attribute
  set for every feature in an offline area has to be in Room before
  the crew leaves signal. The per-layer `geojson` GET is the source;
  the offline area download is not complete until it has run.
- **Presigned PUT must not carry the Authorization header.** It
  invalidates the signature. `clients/python/src/gratisgis/client.py:1279`
  has the comment and the workaround.
- **Offline packages are PMTiles read by byte range**, built server-side
  by the go-pmtiles CLI from the Protomaps daily planet build. Limits
  (`OFFLINE_PACKAGE_MAX_TILES` 25,000, `OFFLINE_PACKAGE_MAX_ZOOM` 15)
  are exported from `shared-types`, so they are shared contract already.
  MapLibre Native reads PMTiles directly.

`clients/python` is the closest thing to a reference implementation for
the item and feature APIs, and its error taxonomy (`AuthError`,
`NotFoundError`, `ValidationError`, `ConflictError`, `RateLimitError`
carrying `retry_after`) is worth copying verbatim into Kotlin. It covers
none of the field surface: no offline packages, no queue manifest, no
tiles.

### On codegen

`@nestjs/swagger` is wired and serves `/docs`, but there are **zero
`@ApiProperty` decorators in the entire `apps/portal-api/src` tree**,
`setVersion` is hardcoded to `0.0.0`, Swagger is gated off in
production, and nothing writes a spec to disk. Generated Kotlin models
would be near-empty.

Two options: hand-write the client against `shared-types` as the source
of truth, or enable the Nest CLI plugin (`@nestjs/swagger/plugin`),
which infers most `@ApiProperty` metadata from the existing
`class-validator` decorators. The second is a small change with value
beyond this project. Either way, many handlers write straight to
`@Res() res: Response` and stay invisible to the generator, so codegen
is at best partial. Plan on hand-writing. The surface is small enough.

## Android module layout

```
:app                  Compose UI, navigation, the 13 handoff screens
:core:design          Contour tokens as a Compose theme, type scale, shapes
:core:model           kotlinx.serialization data classes mirroring shared-types
:core:engine          QuickJS host, bundle asset, the frozen call surface
:core:network         HTTP client, auth interceptor, error taxonomy, 304/503
:core:database        Room: collections, features, queue, blobs, forms, picklists
:feature:auth         AppAuth PKCE, Keystore token store
:feature:map          MapLibre Native, PMTiles offline, layer rendering
:feature:capture      Reticle, fix averaging, offsets, vertex collection
:feature:forms        Compose question renderers over :core:engine (no logic)
:feature:sync         WorkManager drain over :core:engine fold/replay/outcome
:feature:camera       CameraX plus the metadata stamp overlay
:device:gnss          BLE NMEA, USB serial OTG, mock location provider
:device:rangefinder   Bluetooth laser offset capture
```

`:feature:forms` and `:feature:sync` contain no decision logic. If a
pull request adds an `if` to either that decides whether a record is
valid, visible, required, foldable or retryable, it is in the wrong
place and belongs in the bundle.

`:device:*` is the part that justified going native and has no web
counterpart to stay in parity with, so it is the lowest-risk new code
in the project despite being the most unfamiliar.

**iOS foreclosure.** The module layout is exactly the kind of Android
decision that forecloses iOS. Structure `:core:model`, `:core:engine`
(the interface, with the QuickJS actual in `androidMain`),
`:core:network` and the non-UI parts of `:feature:sync` as Kotlin
Multiplatform modules with a `commonMain` from day one, even while only
`androidMain` has implementations. This costs a Gradle plugin and some
discipline now and most of the iOS logic layer later. Compose UI stays
Android-only for now; whether Compose Multiplatform is used for iOS is
a decision for when a Mac exists.

Room replaces IndexedDB and maps closely onto the existing stores
(`deployments`, `features`, `forms`, `pickLists`, `queue`, `blobs`,
`meta`), which are documented in `apps/portal-web/src/lib/offline-store.ts`
at schema version 4. Read `QueueRecord` and `PendingBlob` there before
designing the Room schema; the field names are contract with the drain,
and now also with the bundle, which takes `QueueRecord` JSON as input.

Six question types parse but have no capture control anywhere today
(`UNCAPTURABLE_QUESTION_TYPES` at `packages/form-schema/src/index.ts:125`):
`signature`, `geotrace`, `geoshape`, `pick-feature`, `route`,
`area-buffer`. A native app is the natural place to close signature,
geotrace and geoshape. Treat that as a bonus, not as v1 scope. Note
that closing one means a renderer only; the engine already validates
them.

## Play Store timeline

This runs on a calendar, not on engineering effort, and it is the part
most likely to surprise.

- **12 testers, 14 continuous days.** A personal developer account
  registered after 13 November 2023 must run a closed test with at least
  12 testers opted in continuously for 14 days before it can apply for
  production access. Testers who opt out and back in restart the clock,
  and as of 2026 Google also checks that the testers actually used the
  app, so twelve installs that sit idle do not count. Organization
  accounts and personal accounts registered before that date are
  exempt. **Decide the account type before step 3, not during it.**
  Registering as an organization removes the requirement entirely, and
  the answer changes the calendar by four to six weeks.
- **Where the 12 testers come from is not decided.** If the account is
  personal, this needs an answer before step 3 uploads anything.
- **Background location review.** `ACCESS_BACKGROUND_LOCATION`, which the
  track log and background drains need, requires a Play Console
  declaration plus a manual policy review of roughly 3 to 5 days, in
  which a reviewer must be able to verify the declared feature works in
  the app. "Nice to have" justifications are rejected. Budget for at
  least one bounce.
- Add data safety declarations, a privacy policy URL, and target API
  level compliance.

**Decided 2026-09-13: Play is the last step, not a parallel track.**
Everything before it is tested without the store: the Android Studio
emulator (AVD) for sign-in, the engine bundle, Room, offline areas, the
queue drain and WorkManager, and a debug APK sideloaded over USB with
`adb install` onto a real handset for the device layer. Bluetooth NMEA
and USB OTG need a physical device either way; the emulator's Bluetooth
is a virtual controller and does not reach real receivers. Nothing in
this list needs a developer account, a listing or a review.

The trade is calendar. A closed track could run its 14-day clock and
the background-location review in parallel with development, because a
closed track is not a public release. Putting Play last means that if
the account is personal, those four to six weeks land at the end of
the project as pure waiting. If the account is an organization, the
requirement does not apply and the trade costs nothing. That is one
more reason to settle the account type early even though the upload is
late.

Mirror the `publish-python.yml` pattern for release automation: a
separate `android-v*` tag namespace decoupled from the portal version,
for the reason already stated in that workflow (the client and the
portal move at different speeds). Actions in this repo are pinned by
SHA; match that. The Android release job depends on the
`packages/field-engine` build so the bundle in the APK is always built
from the tagged commit.

## AGPL and app store distribution

The repo is AGPL-3.0-or-later, `CONTRIBUTING.md:105` requires no CLA,
and Matt is sole copyright holder. Nothing in the repo addresses store
distribution.

- **Google Play: not a problem.** AGPL apps ship there routinely.
- **Apple App Store: genuinely contested.** The known friction is
  Apple's terms against GPL-family section 6, on the user's right to run
  modified copies (the VLC precedent). Positions differ and this is not
  settled law.

Android-first sidesteps it. Decide before iOS starts, not during. Being
sole copyright holder means the options are open: an additional store
permission on the app module, or dual-licensing the mobile client
specifically. Taking outside contributions to the Android code before
deciding closes those options, so decide first if iOS matters.

This is a legal question and the summary above is not legal advice.

## Phasing

Ordered by dependency, not by visibility. The first draft put every
server item ahead of the closed-track upload; only one of them actually
blocks it, and the doc's own priority is to start the Play clock as
early as possible.

1. **Engine bundle.** Done 2026-09-13: `packages/field-engine`, the
   esbuild step, the frozen surface, `ENGINE_VERSION`, the
   introduction-version tables and `requiredEngineVersion`, the server
   stamp on save.
2. **`field-app` Keycloak client.** Done 2026-09-13: templates
   tightened, reconcile in `deploy.sh` and `restore-golden.sh`. Lands
   live on the next tagged deploy.
3. **Android skeleton on the emulator and one sideloaded handset.**
   In progress 2026-09-13. Done: `clients/android` (AGP 9.0.1, Kotlin
   2.3.20, Compose), `:core:engine` loading and hash-checking the
   bundle with the sample validation matching the server on the API 37
   emulator, `:core:network` with discovery and the error taxonomy,
   `:feature:auth` with PKCE sign-in up to Keycloak's login page, a
   collections list behind it, and a CI job running the JVM tests and
   assembling the debug APK. Remaining: a person completing a sign-in
   on the emulator (credentials), the offline area download, queue one
   record and drain it, engine call latency measurement, and the BLE
   NMEA spike on a handset. Ugly is fine. No store involvement.
4. **Server slices, in parallel with 5.** Per-user throttle keying,
   `ownEditWindow` with enforcement, `baseObservationId` 409 on PATCH
   and DELETE, the conformance corpus on the TypeScript side.
5. **The capture loop.** Screens `1d`, `1e`, `1f`, `3a`, plus
   `:feature:map`, `:feature:capture`, `:feature:forms`, `:feature:sync`.
   This is the bulk of the work and the thing that must be fast. `3a`
   now handles 409 conflicts as well as 422 refusals.
6. **The device layer.** `:device:gnss`, `:feature:camera`,
   `:device:rangefinder`, screens `1j` and `1k`. This is why the project
   is native; do not let it slip to last and get cut.
7. **The rest of the handoff.** Screens `1c`, `1g`, `1h`, `1l`, and the
   `1m` Material deltas throughout.
8. **Play Store.** Closed track first (this is where the 14-day clock
   starts if the account is personal), background location review,
   then production. Gate: the conformance corpus green on both the
   TypeScript side and the `:core:engine` instrumented test, and the
   engine version check demonstrated against a form that needs a newer
   engine than the APK carries. Until this step every build is a debug
   APK on the emulator or sideloaded.

## Open questions

Resolved since the first draft, recorded so they stay resolved:
device-id binding (no; Keycloak offline sessions), `formVersionId`
(no; `schemaHash` plus engine version), `mode` (map only in v1),
offline JWKS verification (dropped), whether to port the form engine
(no; embed it).

Also resolved 2026-09-13: the app lives in this repo at
`clients/android/` (the engine bundle is a build input copied from
`packages/field-engine/dist/`, and CI builds both from one checkout),
the QuickJS binding is quickjs-kt, and auth is hand-rolled rather than
AppAuth.

Still open:

- Organization or personal Play developer account, and if personal,
  who the 12 testers are.
- Which physical receivers are in scope for v1? "Bluetooth NMEA" is not
  a specification; SXblue, Arrow and Bad Elf differ in pairing, in their
  sentence mix, and in whether they present as a serial profile.
- Minimum supported Android version, and whether rugged handsets in
  scope (the handoff mentions binding a programmable key) constrain it.

## Estimates

Deliberately not given. There is no basis for estimating velocity on a
platform not yet shipped on, and a number here would be a guess dressed
up as a plan. The dependency order above is the useful part. What can
be said with confidence: steps 1 and 2 are now small and entirely
non-Android, step 4 is the real server cost and it runs in parallel,
and the Play Store calendar in step 3 is four to six weeks that no
amount of engineering speed shortens unless the account type removes
it.

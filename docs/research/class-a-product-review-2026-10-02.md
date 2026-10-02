# Class A: what GratisGIS has to become (2026-10-02)

An objective pass over the product as it sits in the tree: look and
feel, features, usability, security, and reliability, plus the three
things that are not built yet and now matter: a hosted multi-tenant
offer, SSO that an org admin can turn on, and an AI tie-in that does
not betray the self-hosted promise.

This is not a parity chase with ArcGIS Online. The July 2026 memo
(`docs/research/outside-perspective-2026-07-16.md`) still has the
right frame: meter-free analysis, an open portal, and honest limits
beat a clone of Experience Builder. What changed is the ambition.
A hosted service has a different bar than a repo a motivated admin
can install. A first paying customer will judge the product by the
afternoon they spend in it, not by the depth of the observation log.

## Verdict

GratisGIS is already a serious GIS portal. The map editor, data
layers, sharing model, web-app builder (including the KPI and
operations dashboards), print-to-PDF, field collection, and the
PostGIS/DuckDB analysis path are real. The help corpus and the
ArcGIS migration guide are more honest than most commercial GIS
marketing. That honesty is an asset. Keep it.

It is not yet a class-A hosted product. Three gaps dominate:

1. The deployment is one organization on one machine. The code says
   so. A shared database would leak across tenants today.
2. The surfaces a buyer lives in are uneven. Desktop map authoring
   is strong. Mobile web authoring, document reports, and the
   visual workflow canvas are not. About 193 of 311 items in
   `docs/testing/ux-checklist.md` are still unchecked (118 checked).
3. SSO and the LLM plan exist as design docs only. What shipped
   under "AI" is Segment Anything for digitizing, which is valuable
   and is a different product.

Do not sell a shared multi-tenant cloud on this tree. Sell, if you
host at all, one stack per customer until the isolation bugs below
are fixed and a control plane exists. That is the same architecture
`docs/deployment.md` already tests.

## What already holds up

These are the parts a class-A product is built on, not replaced.

- **Map authoring.** `apps/portal-web/src/app/items/[id]/map/` is a
  full editor: layers, symbology, popups, labels, filters, the
  attribute table, Terra Draw editing, print, markup pins, map
  comments, and presence. This is the product.
- **Data.** Observation-log layers, schema editing, version
  snapshots, and optimistic concurrency when a client sends
  `baseObservationId` (`DataLayerFeaturesService.updateFeature`).
- **Sharing.** Private / org / public, plus per-principal shares,
  geo limits, and row scope, evaluated through Cedar
  (`SharingService`, `PolicyService`). Deeper than a typical
  ArcGIS Online share link.
- **Apps.** Custom web apps, viewer and editor templates, KPI
  Dashboard and Operations Board as web-app layouts, print
  templates with a server PDF. Dashboards are not a placeholder
  anymore. Report templates still are.
- **Field.** A real offline field runtime and an Android client
  that replays edits with a base observation id. The web field
  runtime is further along than the UX checklist admits, and less
  proven than a paid field deployment needs.
- **Analysis without a meter.** Derived layers, recipe runner,
  DuckDB-WASM in the browser (`layer-analyze-panel.tsx`). This is
  the differentiator the July memo argued for. It is shipped.
- **Identity foundation.** Keycloak, PKCE, short-lived access
  tokens, API keys stored as SHA-256, AES-256-GCM for upstream
  credentials. The right primitives. They are wired for one realm.

## Do not host customers on one database yet

`AdminUsersController.invite` states the model in code:

> Orgs are single-tenant per realm in the current model, so new
> users inherit the inviting admin's org slug. When we go
> multi-tenant, an explicit org claim moves onto the DTO.

That comment is accurate, and two authorization checks do not
even meet it.

`GroupsService.canSee` treats every `orgRole === 'admin'` as able
to see every group, with no `group.orgId === user.orgId` check.
`canAdmin` does compare org ids. `listMembers` repeats the same
admin shortcut, so an org admin who knows a group id in another
org can read that roster. Today this is latent, because a normal
install has one org. The day two customers share a Postgres, it
is a cross-tenant read.

`GET /admin/users` lists the Keycloak realm with no org filter,
and `GET /admin/users/:id` returns any user in the realm. Writes
go through `assertMutationAllowed` and are org-scoped. Reads are
not.

Backups are full-stack, and the schema comment says they are not
scoped by org. Rate limits are per IP, in memory, and doubled
while two API replicas run (`app.module.ts`). There is one
`CREDENTIAL_ENCRYPTION_KEY` for every secret in the database.
There is no billing, no quota, no per-tenant subdomain, and no
signup that provisions an org. Orgs appear when a JWT carries an
`org` claim (`AuthSyncService`).

A shared-database SaaS needs, before the second customer:

- Org checks on every admin and group read, not only on writes.
- Postgres row-level security on `org_id`, so a missed `where`
  fails closed.
- Per-tenant backup and restore.
- Per-tenant rate limits and storage quotas.
- A distinct encryption domain per tenant, or a tenant key
  wrapped by a host key.
- An audit log of admin actions. `docs/auth-model.md` already
  lists that as future work.

Until those exist, the hosted offer is a control plane that
runs `infra/setup.sh` once per customer. Isolation is the VM.
That is slower to operate and much harder to get wrong. It is
also what the installer, Caddy hostnames, and Keycloak realm
template already assume.

### The license is part of the product

The repo is AGPL-3.0-or-later. Offering the unmodified program as
a network service obliges you to offer the corresponding source
to those users. A proprietary hosted fork of this tree is not
available under the current license. Decide this before the first
invoice: host the AGPL build and publish source, or add a
separate commercial license for customers who need to keep their
own modifications private. This memo is not legal advice. It is
the constraint the `license` field already sets.

## Security, beyond the tenant bugs

The auth core is in good shape. JWT validation, API keys that
cannot call `/admin` or mint other keys, Cedar on item reads,
and the public proxy's SSRF guard (`assertSafeOutboundUrl`) are
the work of someone who has been burned before. The remaining
issues are the ones a host will be asked about.

| Issue | Where | Why it matters when you host |
| --- | --- | --- |
| Admin and group reads ignore org | `groups.service.ts` `canSee`, `listMembers`; `admin-users.controller.ts` `list` and `get` | Cross-tenant metadata if the database is shared |
| JWT audience is not checked | `jwt.strategy.ts`, `docs/auth-model.md` | Any client in the realm (`portal-web`, `field-app`, `qgis-plugin`) presents the same authority. Fine for one org. Weak once clients mean different tenants |
| Public items replay stored upstream credentials | `PublicProxyController` | Marking a secured service `public` publishes that data through your host. Correct, and easy to misconfigure |
| Presigned upload is any signed-in user | `StorageController.presignUpload` | A token can burn storage (up to the large tile/point-cloud limits) for about a minute. Abuse, not a data leak |
| SSRF rebinding window | `common/net-guards.ts` | DNS can change between the check and the connect. Documented in the file |
| No Content-Security-Policy | `infra/Caddyfile` | A XSS bug becomes a session bug. CSP is hard with MapLibre and should still be an explicit allowlist |
| `/health` does not touch dependencies | `apps/portal-api/src/health.controller.ts` returns `{ status: 'ok' }` | A host will page on a green check while Postgres is down |
| No admin audit log | `docs/auth-model.md` | You cannot answer "who invited this user" after an incident |
| In-memory rate limit | `app.module.ts` | NAT-shared field crews trip one bucket; two replicas split the budget |

None of these are exotic. They are the list a security review of
a hosted GIS will produce on day one. Fix the org-scoped reads
before any architecture diagram shows two customers in one
database. The rest can land with the control plane.

## Look, feel, and usability

The design system in `docs/design-system.md` describes a calmer,
tighter product than the July audit found, and a meaningful part
of that audit is now true in the app: dark mode, the Contour
mark, Sonner toasts, a dismissible welcome panel, and five
locales. Tokens live in `apps/portal-web/src/app/globals.css`.
The doc still points at `packages/ui/src/tokens.css`, which is
not there. Small, and it is the pattern: the system is ahead of
the last mile.

What a new user actually feels:

- **First hour, desktop, signed in.** Good. Items, a wizard that
  groups data / maps / apps / analysis, a map that looks like a
  tool rather than a demo, help in a drawer. This is the path to
  protect.
- **First hour, phone browser.** Weak. The map editor's own
  comment says the sidebar drawer is future work. Field
  collection has a mobile runtime. Authoring a map does not.
  Planners evaluate GIS on a laptop and then open the link on a
  phone. The second session is where it feels unfinished.
- **Empty and unfinished types.** `coming-soon.tsx` still owns
  report templates, widget packages, layer packages, and form
  submission collections, and it shows the raw JSON under the
  explanation. Fine for the maintainer. Wrong for a customer who
  clicked "report" because the type exists in the data model.
- **Dialogs.** A shared Radix dialog exists. Dozens of panels
  still use a hand-rolled overlay. Focus trap and escape are
  therefore a coin flip. This is the consistency gap the July
  memo named, and it is only partly closed.
- **Density.** `text-2xs` (11px) is the working size of the map
  and admin chrome. It reads as an instrument panel, which is
  right for a GIS, and it fails a "class A" glance test wherever
  body copy uses it. Keep it in tables. Stop using it for
  sentences.
- **`/why`.** The argument is right and the chrome is wrong: that
  page still uses a Lucide compass instead of the brand mark the
  landing page and the app shell use.
- **Command palette.** The design doc promises one. There is no
  `cmdk` in the app. Useful, not blocking. Ship it after the
  paths below are verified, not before.
- **Locales.** Five languages, all non-English flagged
  machine-translated. Do not sell a localized product until a
  human has read the locale a customer will use.

The UX checklist is the uncomfortable number. 118 checked, 193
unchecked. The unchecked clusters are the product: feature
editing, forms end to end, web-app widgets, the field PWA,
sharing tiers, admin restore, accessibility, mobile. A class-A
host does not need every box checked. It needs the ones a pilot
customer will hit in week one checked by a person, with the
failure written down. That is a verification project, not a
feature project, and it is the highest-leverage UX work left.

## Features a buyer will hit

Ranked by how fast they end an evaluation, not by how interesting
they are to build.

1. **Enterprise sign-in.** Covered below. An IT department stops
   at "our users sign in with Entra ID" if the answer is "SSH to
   the box and use the Keycloak console."
2. **Document reports.** Print templates produce a map PDF.
   `report_template` is a coming-soon type. Permitting and
   inspection customers ask for "the PDF of this submission"
   before they ask for a node graph.
3. **The workflow canvas.** The recipe model is a graph
   (`packages/shared-types/src/tool.ts`). The editor is a list
   (`tool/recipe-editor.tsx`). Help says so. CARTO and
   ModelBuilder set this expectation. The backend can wait; the
   UI is the gap.
4. **Story-style and multi-page apps.** Explicitly not built
   (`docs/item-type-guidance.md`). Say so on the evaluation call.
   Do not let the web-app builder be mistaken for Experience
   Builder or StoryMaps.
5. **Mobile web maps.** Above.
6. **"I uploaded a spreadsheet and it mapped itself."** CSV
   detection finds coordinate pairs
   (`csv-smart-detect.ts`). It does not geocode an address
   column. Felt's first five minutes is this feature.
7. **Imagery and 3D as a normal map.** Point clouds exist. A
   general raster/COG path and a 3D view on the map item do not.
   Utilities and drone pilots will ask. Everyone else will not,
   in the first pilot.

What not to build next, even though competitors have it: a second
dashboard product (dashboards are web apps now), a visual theme
builder before the existing theme item is in the pilot script,
and a realtime cursor websocket before presence polling has a
customer who needs it.

## Reliability

The compose stack is honest about being one host. Postgres,
Keycloak, MinIO, Caddy, and the worker are single instances.
`portal-api` runs twice and elects a leader with a Postgres
advisory lock, which is the right way to keep cron from doubling.
The worker is still one process: imports, point-cloud merges,
SAM embeddings, offline packages, and backups queue behind each
other.

Field sync is in better shape than the checklist suggests. A
client that sends `baseObservationId` gets a 409 and parks the
edit. A client that does not gets last-writer-wins. The Android
client sends the id. The web field client is the one to confirm
before a crew depends on it.

`/health` cannot tell a load balancer that the database is gone.
`infra/doctor.sh` can, and it is a shell script an operator runs,
not a probe. For a host, add a readiness check that pings
Postgres, Keycloak's JWKS, and MinIO, and keep the shallow
`/health` as liveness so a slow dependency does not restart a
healthy process.

There is no metrics stack, no tracing, and no error reporter in
the repo. A single-tenant VPS can live on `docker logs`. A
hosted service cannot. OpenTelemetry to somewhere you already
operate is enough. Do not adopt a second observability product
before the readiness check exists.

Backups are real (`backup.service.ts`: pg_dump plus the object
store) and restore takes the stack down for maintenance. Write
the RPO and RTO in the customer agreement from that behavior,
not from a wish. A point-cloud merge can also fill the disk; the
worker already refuses a merge that fails the scratch check.
Surface that failure in the admin UI if it is still only a log
line. A customer whose lidar job dies silently will not call it
a class-A product.

## SSO

Keycloak can already do this. The portal does not expose it.

`docs/auth-provider-admin-ui-design.md` is the right design and
it is explicitly pre-implementation. Admins leave the product,
tunnel to a console that Caddy hides from the public internet,
and edit identity providers by hand. That was an acceptable
self-host story. It is not a hosted story. The customer's IT
admin will not get a shell on your VM.

Build the design's first slice, and only that, before a tenant
control plane:

- One OIDC provider per org (Entra ID, Google Workspace, Okta).
  Client id, issuer, secret. Test connection. Enforce it.
- Domain hint so `alice@customer.org` is sent to that provider.
- JIT provisioning into the inviting admin's org, with a default
  role of viewer. Promotion stays an admin action.
- MFA as a realm switch the portal already plans to hide behind
  one control.

SAML is the second slice. SCIM is the third, and only after a
customer contract requires it. Do not start with SCIM.

Per-tenant IdP and a shared Keycloak have a known shape: one
realm per customer, or Keycloak Organizations if you are ready
to bet the admin API on it. Realm-per-customer matches
stack-per-customer and avoids rewriting `org` as a global
attribute. If you later collapse to one database, the realm
boundary is what you give up last.

The API should keep validating issuer and signature, and it
should start checking `aud` once each tenant has its own
clients. `docs/auth-model.md` already names that debt.

## AI

`docs/llm-integration.md` is the right product and none of it is
in the tree. There is no `apps/portal-api/src/llm/`, no Ollama
service in compose, and no pgvector column. The migration that
would have added embeddings says they were omitted on purpose.
Item search is still a substring match.

What did ship is SAM: server-side image embeddings and a browser
ONNX decoder so an editor can outline a feature from a raster
(`SamController`, `apps/portal-web/src/lib/sam-outline.ts`).
That is a class-A editing feature. Call it that. Do not call it
the AI assistant.

For the assistant, ship phase 1 of the existing doc and stop:

- Opt-in, off by default, one env flag.
- Embeddings of title, description, tags, and field names in
  pgvector.
- Search merges substring and vector results and still applies
  `visibleWhere`. A sharee must not retrieve an item they cannot
  open. That is the entire safety property.
- No generation. Ranking cannot hallucinate a schema change.

Phase 2 (draft a form or a layer from a sentence, human accepts)
is the one customers will call "AI." Build it only after phase 1
has the auth boundary in production. The doc's other rules are
the ones to keep when you are the host as well as the author:
drafts, not writes; pinned model versions; the model runs where
the data runs. A hosted tier can offer a managed model in the
same region as the tenant's stack. Do not send tenant features
to a third-party API by default. That sentence is the product
promise. An "AI add-on" that silently uses someone else's cloud
breaks it.

A practical tie-in that is smaller than phase 2 and more useful
than a chatbot: "explain this layer" and "write the filter" as
drafts on the map the user already has open, with the Cedar
decision attached to the prompt's item list. Same gate, smaller
surface than a general agent.

## Sequence

This is the order that makes the hosted offer and the product
the same thing.

1. **Land the dependency housecleaning.** Node stays on 24 LTS
   (`24.21.0` in both Dockerfiles). The Node 26 image pulls are
   declined because `gdal-async` does not build there. The npm
   minor/patch group is reapplied on current main rather than
   merged as a conflicting lockfile. See the pull request that
   accompanies this memo.
2. **Fix org-scoped admin and group reads**, and add a test that
   an admin of org A gets 404 for org B's group and user. Do
   this even if the first hosted customers are one stack each.
   The bug is a trap for the next architecture conversation.
3. **Write the pilot script and check it.** Sign in, create a
   layer from a file, style it, share it to a second user, fill
   a form, take it offline in the field runtime, print the map.
   Check those UX-checklist rows. Fix only what that script
   breaks.
4. **SSO slice one**, from the existing design doc, on the
   single-tenant stack. Entra ID or Google is enough to learn
   where the admin UI is wrong.
5. **Readiness, backup RPO, and an error log a host can read.**
   No new product surface.
6. **Hosted offer: one stack per customer**, AGPL source offer
   written down, custom domain as a Caddy site you generate,
   not a multi-tenant router. Billing can be a spreadsheet until
   the tenth customer.
7. **Semantic search (LLM phase 1)**, behind the flag, gated by
   `visibleWhere`.
8. **Then** the features that make the second year feel class A:
   submission PDFs, the workflow canvas, mobile map chrome,
   address geocoding on upload, and LLM drafts.

Items 2 through 6 are what "we offer hosting" requires. Items 7
and 8 are what "this product kicks ass" requires. They are not
the same list, and shipping 8 first will produce a beautiful
app that cannot take a second customer's data safely.

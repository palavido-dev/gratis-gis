# Admin org-settings triage (vs. AGO)

## Why this exists

#172 designed the in-portal Auth/Security surface. This doc is the
companion: a section-by-section walk through AGO's full
organization Settings sidebar, evaluating whether each section's
features are worth bringing into GratisGIS. The ground rule is
"only what truly adds value and ease of use; if it's an edge case
that adds clutter for functionality nobody will actually use, skip
it".

The AGO sidebar (per the Settings page) is:

```
General                    -> mostly already covered, plus a few worth adding
Home page                  -> defer (heavy editor, our branding covers basics)
Gallery                    -> defer (we have curated already)
Map and scene              -> partial: defaults worth bringing
Items                      -> partial: categories + comments worth considering
Groups                     -> already covered
Webhooks                   -> BUILD (Matt flagged: webhook as item type)
Utility services           -> partial: geocoding done, print pending
Member roles               -> Phase 2 (custom roles editor)
New member defaults        -> BUILD (default role, groups, username format)
Marketplace                -> SKIP (Esri Marketplace)
Credits                    -> SKIP (Esri credit system)
Security                   -> covered by #172
Open Data                  -> partial: per-group public-share already exists
Organization extensions    -> SKIP (mostly Esri-specific extensions)
```

What follows is the per-section triage and what should land as
discrete tasks.

## General

AGO's General tab covers org profile (name, logo, summary, contact
link, region, language, number/date format, short name slug,
administrative contacts, Esri UX program, shared theme colors and
logo, navigation bar visibility, app launcher).

Mapping:

| AGO field                 | Status / decision                                     |
|---------------------------|-------------------------------------------------------|
| Org name                  | #171 already on the list                              |
| Logo                      | Already in `/admin/branding`                          |
| Summary                   | Already in `/admin/branding`                          |
| Contact link              | **BUILD**: small, real value, easy add                |
| Region / language         | Phase 2 i18n; out of scope today                      |
| Number / date format      | Inherits from browser locale; defer                   |
| Short name (URL slug)     | Already on the org record                             |
| Administrative contacts   | **BUILD**: drives notification routing                |
| Esri UX program           | SKIP (Esri-specific telemetry)                        |
| Shared theme              | Already in `/admin/branding`                          |
| Navigation bar visibility | **BUILD**: per-org "hide this top-nav item" toggles   |
| App launcher              | SKIP (Esri concept)                                   |

Three concrete additions: contact link, administrative contacts,
and nav-bar visibility toggles.

The administrative-contacts field is more useful than it looks. AGO
uses it for email routing: "send the help-with-X mail to these
people". For us it dovetails with #137 / #139 (notifications): an
admin can mark themselves opt-in or opt-out of being CC'd on
member-help requests, and our notifications system targets that
list when a relevant trigger fires.

Nav-bar visibility lets an org hide top-nav items they don't use
(Notebooks, Open Data, etc.) so members see only what matters for
their portal. Cheap toggle, big perceived simplification.

## Home page

AGO offers a full home-page editor: hero image, custom colors and
fonts, multiple item galleries, links, text blocks. Heavy.

For us, `/admin/branding` already covers the basics (logo, hero
image, theme colors, summary). The full block-editor is a Phase 3
nice-to-have when someone actually asks for it. **Defer**.

## Gallery

AGO lets the admin pick a group whose items become the gallery on
the org home page, and choose sort order.

We have a "curated content" surface tied to the home page already.
**No new work**.

## Map and scene

AGO surfaces:

* Basemap gallery group (2D + 3D)
* Default basemap for maps and scenes
* Default extent
* Default units (US Standard / Metric)
* Web styles groups (2D / 3D / sketch)

Mapping:

| AGO field             | Status / decision                                     |
|-----------------------|-------------------------------------------------------|
| Basemap gallery group | Tied to #73 (Map-as-basemap). Lands with that.        |
| Default basemap       | Already in `/admin/branding`                          |
| **Default extent**    | **BUILD**: org-wide default map view                  |
| **Default units**     | **BUILD**: US Standard vs Metric, used by measure     |
| Web styles groups     | SKIP (Esri-specific symbol library concept)           |

Default extent is currently per-map (each map has its own); an
org-wide default that new maps inherit from is a small but useful
addition. Default units is one toggle that fixes the measure tool
and any future scalebar / labels module.

## Items

AGO surfaces:

* Comments on items
* Metadata edit + style
* Organization categories
* Recycle bin opt-in
* Search using related terms (synonym search)

Mapping:

| AGO field                       | Status / decision                            |
|---------------------------------|----------------------------------------------|
| Comments                        | Defer; we have no item comments yet          |
| Metadata enable + style         | Already covered by #33 (XML upload)          |
| **Organization categories**     | **BUILD**: org-defined taxonomy for items    |
| Recycle bin opt-in              | Soft-delete is already always-on for us      |
| Search using related terms      | SKIP (search infra would need work)          |

Organization categories is the real value here. AGO uses it for
hierarchical taxonomy (e.g., "Infrastructure > Roads > Maintenance"),
where each item can be tagged with one or more categories from the
org's tree. Items list lets you filter by category. Folders give
us part of this but folders are for ownership/organization;
categories are for discovery/taxonomy. Worth a separate design.

## Groups

AGO's Groups settings are about featured groups. We already have
Folders + Groups; this maps cleanly. **No new work**.

## Webhooks (Matt's flag)

This is the most interesting one. AGO's webhook management today
has two surfaces:

* **Org-level Settings -> Webhooks**: only houses retry / timeout /
  failure-cap defaults. The actual webhook subscriptions live
  elsewhere.
* **Per-feature-layer item -> Webhooks tab**: where you define a
  webhook (URL, events to subscribe to like add/update/delete,
  payload format).

So AGO already de-facto treats per-webhook config as item-level,
but doesn't formalize it as its own item type. Matt's instinct
("webhook should be an item type") is sound: making it a first-
class item type gives webhooks the same surface every other item
gets:

* Sharing and access control. Webhook owners and admins manage who
  can edit; the URL endpoint and any auth headers stay private.
* Soft-delete and recycle bin.
* Folder organization, tags, search.
* Editor tracking (who created / last edited).
* Auditable history.
* Discoverability via the items list.
* Item-detail page that shows recent deliveries, failure rate, last
  payload, manual "fire test event" button.

### Proposed `webhook` item type

```ts
{
  type: 'webhook',
  // standard item fields (id, owner, org, title, summary, tags, ...)
  data: {
    targetUrl: string;          // POST endpoint
    secret?: string;            // HMAC-signing secret (encrypted)
    headers?: Record<string,string>;  // optional auth headers
    events: WebhookEvent[];     // e.g. ['feature.created','feature.updated']
    sources: Array<{
      itemId: string;           // a data_layer / form_collection / etc.
      layerId?: string;         // optional sub-layer scope
    }>;
    enabled: boolean;
    deliveryConfig: {
      maxAttempts: number;       // default 3
      timeoutMs: number;         // default 5000
      backoffMs: number;         // default 1000 (exponential)
    };
  };
  // dependencies tracking already gives us the "this map / form
  // / data_layer feeds into webhook X" backreference for free.
}
```

### Trigger model

A small webhook-dispatcher service in portal-api listens on the
existing event bus we use for notifications (#127-130), filters
events whose source matches any subscribed webhook's `sources`,
and POSTs the payload to `targetUrl`. Failed deliveries go into
a queue with the same retry semantics as the notification queue
(we already built the retry / backoff / dead-letter plumbing
there; reuse it).

### Why this is high value for GratisGIS

Webhooks are how a self-hosted portal earns its keep against
third-party integrations. Every "I want to fire a Zapier when a
new inspection lands" or "I want to update our SCADA when this
data_layer changes" use case maps directly to a webhook. Without
them, users have to poll our REST API. With them, integration
becomes one step.

The org-wide settings (retry attempts, timeout, max failures)
land on the Settings -> Webhooks page as a small card, mirroring
AGO. The bulk of the surface is item-level.

**BUILD**, with a phased plan analogous to the auth-provider doc:

* Phase 1a: schema + dispatcher + per-item config UI.
* Phase 1b: org-wide defaults card.
* Phase 1c: deliveries history + retry / replay UI.
* Phase 2: HMAC signing + filterable payloads + Slack/Teams
  shorthand presets.

(Note: webhook is genuinely separate from the existing notifications
plumbing in spirit, but the queue / retry / dead-letter mechanism
underneath should be the same. Reuse the notification worker,
extend its job-types union to include webhook deliveries.)

## Utility services

AGO surfaces:

| AGO service           | Status / decision                                     |
|-----------------------|-------------------------------------------------------|
| Print service         | Pending #132 (Print Template item type)              |
| GeoEnrichment         | SKIP (Esri-specific)                                 |
| **Geocoding**         | Already covered (Nominatim integration)              |
| Directions / Routing  | Defer; we have no routing today                      |
| Travel modes          | Defer; tied to routing                               |

The Geocoding service surface (multiple locator URLs, reorder,
per-locator config) is something we partially have via Nominatim
but should formalize: an admin should be able to add a custom
geocoder URL (third-party Pelias, in-house service) without
editing infra. **BUILD as small follow-up**: a Settings ->
Locators card that lets admins register additional geocoder URLs
and reorder the list used by the search bar.

## Member roles

AGO ships built-in roles (Administrator / Publisher / User /
Viewer / Data Editor / Facilitator) plus a "Create role" editor
where you build a custom role from a privilege checklist.

We have admin / contributor / viewer baked in, plus #4 (per-user
capability overrides). The next step up is a real custom-role
editor: pick privileges, save as a named role, assign it to
members. That's a meaningful undertaking but high value for orgs
with finer-grained needs (e.g., "can publish data but not
delete", "can edit features but not change schema"). **Phase 2**:
a custom-role editor on top of our existing capability model.

## New member defaults

AGO surfaces user type, role, add-on licenses, groups, credit
allocation, Esri access, username format.

Mapping:

| AGO field          | Status / decision                                       |
|--------------------|---------------------------------------------------------|
| User type          | We don't have user types; SKIP                          |
| **Role**           | **BUILD**: default role for newly invited members       |
| Add-on licenses    | SKIP (Esri-specific)                                    |
| **Groups**         | **BUILD**: auto-add new members to these groups         |
| Credits            | SKIP (Esri credit system)                               |
| Esri access        | SKIP                                                    |
| **Username format** | **BUILD**: org-defined username pattern (e.g., first.last) |

Three concrete additions: default role, default group memberships,
username format. All three eliminate per-invite manual setup that
admins do today. The username format helper is small but high-
ROI: an org that wants `firstname.lastname` everywhere can stop
manually typing it on every invite.

## Marketplace, Credits

Both Esri-specific. **SKIP entirely**.

## Open Data

AGO has an "Enable Open Data" toggle and a per-group "share to
public Open Data hub" workflow. We already have OGC API Features
(#66) and a CSW catalog (#31), so the underlying public-data
plumbing exists.

What AGO offers on top is the "designated open-data groups"
concept: you mark certain groups as the staging area for public
data, and only items shared into those groups get exposed via the
public catalog. That's a useful curation step (vs. letting any
publicly-shared item appear in the public catalog).

**Phase 2**: add an `openData: boolean` flag to groups and gate
the OGC / CSW catalog endpoints to only surface items shared with
open-data-flagged groups.

## Organization extensions

AGO surfaces Workflow Manager and Location Sharing. Both are
Esri-specific subsystems.

* Workflow Manager: SKIP (entire Esri product).
* Location Sharing: tied to Field Maps tracking. We don't have
  field tracking yet; if we add it, the org-wide retention
  toggle (30/90/180 days, etc.) is the same shape.

**SKIP for now.**

## Summary: what should land

Discrete tasks that fall out of this triage:

1. **Webhooks as a first-class item type** + dispatcher + per-item
   config + org-wide retry/timeout card (Matt's flag; biggest
   value).
2. **Org categories**: tree-based taxonomy for items, items list
   filter by category.
3. **New member defaults card**: default role, default groups,
   username format pattern.
4. **General settings additions**: contact link, administrative
   contacts (notification routing), nav-bar visibility toggles.
5. **Map & scene defaults**: org-wide default extent + default
   units.
6. **Locators card**: register additional geocoder URLs, reorder.

Phase-2 follow-ups:

7. Custom-role editor (next step up from #4 per-user overrides).
8. Open Data per-group flag + OGC/CSW gating to only flagged
   groups.

Explicitly skip: Esri Marketplace, Credits, GeoEnrichment, Workflow
Manager, app launcher, Esri UX telemetry, web styles groups,
search-using-related-terms.

Defer (no real value yet vs. cost): Home page block editor, item
comments, routing/travel modes, location-sharing track retention.

## Open questions

1. Should the org categories tree be a first-class item type
   (`category_set` or similar) or a property on the org? Lean
   toward property-on-org for simplicity, but item-type would let
   us share the taxonomy across orgs.
2. Webhooks: do we expose payload-shape config (e.g., flatten /
   nest / include geometry / strip attachments), or just emit a
   canonical shape? Lean canonical for v1; add presets later.
3. Nav-bar visibility: per-org or per-role-within-org? Probably
   per-org-only; per-role is a different beast.

## Status

Pre-implementation. Awaits Matt's read-back on the priority order
above. The "BUILD" tier (1-6) lands as discrete tasks; the
Phase-2 list (7-8) waits until the BUILD tier is in.

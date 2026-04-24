# Granular Sharing

A common and legitimate frustration with cloud-GIS platforms is that sharing
is coarse: you share the whole layer, to a whole group, and everyone sees
every column and every row. The usual workaround is to create a parallel
"layer view" per audience, which gets messy fast: view proliferation,
schema drift, and you end up shipping multiple apps to point at the
different views.

GratisGIS rejects that approach. We want **one layer, one app, one URL**,
with what the user sees computed per-request from policies attached to
that layer.

## Three levels of granularity

1. **Per-principal sharing** (already implemented): share an item to a
   specific user, or to a group. Supported natively in the schema, not a
   group-only restriction.
2. **Row-level access policies** (phase 2): within a feature-service,
   filter rows based on the requesting user's identity, role, or group.
3. **Field-level access policies** (phase 2): within a feature-service,
   hide or mask specific columns based on the requesting user.

(2) and (3) are **policies attached to the base layer itself**, not
separate layer-view items. One feature-service can serve every audience;
each user's request is filtered in-flight.

## Why attached policies beat layer-views

| Dimension | Layer-views (AGOL-style) | Attached policies (our choice) |
| --- | --- | --- |
| **Schema evolution** | Every view must be edited when the base table gains/loses a column. Risk of accidental leak if a new column gets surfaced. | One schema. New columns are invisible by default (configurable); policies explicitly opt a column in. |
| **App count** | Different audiences need different layers â†’ different apps, or app logic to pick the right view per user. | One app, one layer URL. The server does the right thing based on who is asking. |
| **Tile caching** | Each view has its own tiles. Duplicated compute and storage. | One tile source. Per-request column masking happens on the API path; row filtering compiles into the tile query. |
| **Audit** | "Who can see column X?" means inspecting every view. | "Who can see column X?" is a query against the policy table. |
| **Composition** | Views of views are awkward; permissions drift. | Policies stack naturally; permission checks compose as SQL `AND`/`OR`. |

## Schema additions (phase 2)

```
FieldPolicy (one row per policy):
  id              uuid PK
  itemId          uuid â†’ Item (must be feature-service)
  name            text          — admin-facing label
  principalMatch  jsonb         — who this applies to
  visibleColumns  text[]        — columns this audience can see
  maskMode        enum          — 'drop' | 'mask_null' | 'mask_redact'
  priority        int           — tiebreak when multiple rules match
  createdAt       timestamptz

RowPolicy (one row per policy):
  id              uuid PK
  itemId          uuid â†’ Item
  name            text
  principalMatch  jsonb
  filter          jsonb         — safe-expression AST (see below)
  priority        int
  createdAt       timestamptz
```

### principalMatch

Small JSON shape describing which users a policy applies to. Evaluated
server-side against the authenticated `AuthUser`. Composable.

```jsonc
// Match the owner
{ "is": "owner" }

// Match a specific user
{ "userId": "aaaaaaaa-..." }

// Match any member of a group
{ "groupId": "gg-001" }

// Match by org role
{ "orgRole": "contributor" }

// Match "everyone in the user's org"
{ "is": "org-member" }

// Match "everyone" (including anonymous, if layer is public)
{ "is": "any" }

// Composition
{ "anyOf": [ {"groupId": "hr"}, {"userId": "bob-..."} ] }
{ "allOf": [ {"orgRole": "contributor"}, {"groupId": "field-team"} ] }
```

### filter (row policy)

Safe expression AST evaluated per row. No raw SQL in the payload — the
server compiles it into parameterized SQL.

```jsonc
{ "op": "eq",  "left": { "col": "owner_id" }, "right": { "viewer": "id" } }
{ "op": "in",  "left": { "col": "status" },   "right": { "value": ["approved", "published"] } }
{ "op": "and", "operands": [ ... ] }
{ "op": "or",  "operands": [ ... ] }
{ "op": "not", "operand": { ... } }
```

Column references use `{"col": "<name>"}`. Viewer references use
`{"viewer": "id" | "orgId" | "groupIds"}` and always resolve from the
authenticated `AuthUser`, never from the request body.

## Evaluation algorithm (per request)

**Guiding principle: deny by default.** If nothing explicitly grants
access, nothing is visible. The owner and org admins override this; for
everyone else, policies must say yes.

For a read of feature-service `S` by authenticated user `U`:

1. **Authorization gate** — `canRead(U, S)` via the normal item sharing
   rules (see `data-model.md`). If false: 404 and stop.
2. **Owner / admin short-circuit** — if `U` is `S`'s owner or an org
   admin of the owning org: full access (all rows, all columns), skip
   policies entirely. This is how item ownership always works: create an
   item and it's yours, full visibility, no policy authoring required.
3. **Row filter composition (deny-by-default, union on match)**:
   - Find all `RowPolicy` rows on `S` whose `principalMatch` is satisfied
     by `U`.
   - **If zero match: return an empty row set.** The user is not an owner,
     not an admin, and no policy has explicitly said they can see any
     rows. 404 vs. empty-result is the caller's choice; we return `200
     [[]]` for read-lists and `404` for read-by-id so URL-guessing can't
     distinguish "empty by policy" from "didn't exist."
   - Otherwise: `effectiveFilter = OR(matching filters)`. User sees any
     row matching *any* policy they qualify for. Union semantics,
     consistent with PostgreSQL RLS, BigQuery row access policies, and
     Snowflake row access policies.
4. **Field visibility composition (deny-by-default, union on match)**:
   - Find all `FieldPolicy` rows on `S` whose `principalMatch` is
     satisfied by `U`.
   - **If zero match: the only visible columns are `id` and `geom`** (the
     minimum any map renderer needs to draw a feature). All attribute
     columns are dropped or masked per the item's default mask mode. This
     is a safety floor: a user who somehow reaches a feature-service
     without a field policy sees shape only, never data.
   - Otherwise: `visibleCols = UNION(each matching policy's
     visibleColumns)`. User sees a column if *any* matching policy allows
     it. Union semantics.
5. **Query compilation**: translate to parameterized SQL with the
   `effectiveFilter` in `WHERE` and the `visibleCols` as the `SELECT`
   list. Non-visible columns are either omitted (`maskMode='drop'`) or
   replaced with `NULL` / `'••••'` in the projection.
6. **Enforce identically on the tile path**: pg\_tileserv uses a
   parameterized function wrapper that reads the JWT claims, computes the
   same `effectiveFilter` + `visibleCols`, and returns only matching
   rows and exposed columns. Belt-and-suspenders.

### Consequence: every shareable item needs at least one policy per audience

Because we deny by default, simply sharing an item to a group via
`ItemShare` is not enough to let that group *read* rows from a
feature-service — you also need at least a RowPolicy (even a trivial
"always true" one) matching that group. The Permissions UI enforces this
by refusing to save a share to a non-admin without at least one
applicable policy, and offers to scaffold a trivially permissive policy
so the admin can narrow it afterward. This trades slightly more up-front
configuration for much stronger safety guarantees — the same trade-off
Postgres RLS forces, for the same reason.

For non-feature-service item types (web-maps, reports, dashboards,
notebooks) the deny-by-default row/field policies don't apply — those
items have no rows or fields to filter. Sharing rules from
`data-model.md` govern them directly.

## Example

Employees table with columns `id, name, role, manager_id, salary, ssn,
dob, performance_notes`. Policies:

| Kind | Audience | Rule |
| --- | --- | --- |
| RowPolicy | `{ is: 'org-member' }` | always true (everyone sees all rows, subject to other policies) |
| FieldPolicy | `{ is: 'org-member' }` | visible: `[id, name, role]` |
| FieldPolicy | `{ groupId: 'managers' }` | visible: `[id, name, role, manager_id, performance_notes]` |
| RowPolicy | `{ groupId: 'managers' }` | `{op: eq, left: {col: manager_id}, right: {viewer: id}}` |
| FieldPolicy | `{ groupId: 'hr-admins' }` | visible: `[*]` |
| RowPolicy | `{ groupId: 'hr-admins' }` | always true |

Effective behavior:

- A regular org member sees every row, but only `id, name, role`.
- A manager sees only their direct reports (row filter `manager_id =
  :viewer.id`), and additionally sees `manager_id` and
  `performance_notes` (union of their field policies).
- An HR admin sees everything.

No separate layer-views. No parallel apps. Add `hire_date` to the table
and nobody sees it until you add a field policy that includes it.

## Schema changes are safe

New columns are **invisible by default** to non-owners — because no
existing `FieldPolicy.visibleColumns` array mentions them. (Owners and
org admins still see them immediately, per step 2.) This is the opposite
of the layer-view pattern, where the base schema leaks into every view
unless you remember to update each view's column list.

To expose a new column to an audience, you explicitly add it to the
relevant field policy's `visibleColumns`. That's a single edit, audit-
friendly, and reviewable.

## Enforcement layers

1. **API (portal-api)**: the query builder consults `FieldPolicy` and
   `RowPolicy` on every feature read, composes the SELECT list and WHERE
   clause, runs a parameterized query against the tenant schema.
2. **Tile path (pg\_tileserv)**: tiles go through a server-side function
   (`gratisgis.tile_features(item_id uuid, z int, x int, y int, claims
   jsonb)`) that enforces the same policies. A malformed policy or an
   API bug cannot leak data through tiles.
3. **Drift check (nightly)**: a background job diffs the API's compiled
   access decision against the tile function's compiled access decision
   for each (item, principal) pair, across a sampled set of users. Any
   drift raises an alert.

## UI surface

On an item detail page for a feature-service, owners (and org admins) see
a **Permissions** tab with three sections:

1. **Access**: baseline access (private/org/public) + explicit shares
   (groups and users, with view/edit/admin levels). This is the existing
   `ItemShare` UI.
2. **Row access**: ordered list of row policies. "For [audience picker],
   show rows where [filter builder]." Drag to reorder.
3. **Field access**: a matrix. Rows are audiences; columns are base-layer
   columns; cells are checkboxes. A "default" row at the top controls
   what happens for audiences not explicitly listed.

Plus: a **"Preview as…"** selector at the top of the tab. Pick a real
user or a hypothetical principal-match, and the page re-renders showing
exactly what that user would see: visible columns grayed out,
effective row count, the compiled SQL. This is the single feature that
most reduces configuration error in policy-based systems.

## Escape hatch

There are cases where a fully derived layer is legitimately needed
(e.g. spatially joined with another table, different geometry). For
those, we keep a `feature-service` item type that points to a
materialized query rather than a base table. It's just another
feature-service from the sharing POV, and policies attach the same way.

**But this is the exception, not the pattern.** The default for "show
different audiences different things" is a single layer with attached
policies.

## What this gives you that AGOL layer-views don't

- One layer, one app, one tile cache — serves every audience
- Per-user sharing, not just per-group
- Column hiding *and* column masking ("••••" instead of dropped, when
  the UI needs to indicate "something exists here, you can't see it")
- Row filters that reference the viewer (`owner_id = :viewer.id`)
- Schema additions are invisible until explicitly exposed
- Preview-as-user testing before a policy goes live
- Audit: "who can see column X?" is one SQL query

## Scope

**Phase 1 (now):** per-principal sharing (user + group) with UI. No
row/field policies yet.

**Phase 2 (web maps):** `FieldPolicy` and `RowPolicy` tables, the
policy-evaluation logic in the API query path, the Permissions tab UI
(including Preview-as-user). This lands alongside the first feature-
service rendering work so policies are a first-class concept from day
one — never bolted on later.

**Phase 2+ (hardening):** the pg\_tileserv function wrapper that enforces
policies at the tile path, and the nightly drift check. Required before
shipping to environments handling sensitive data.

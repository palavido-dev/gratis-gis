# Cedar policy integration

The engine pivot defers the open question "policy engine choice"
in `observation-log-engine.md` (section 7) to Phase A of the
authorization rebuild. This doc closes that question and lays out
the integration plan.

## Decision

We picked Cedar (`@cedar-policy/cedar-wasm`) over OPA and a
hand-rolled DSL. Reasoning:

- **Geometry- and attribute-aware checks are first-class.** Cedar
  policies can compare entity references and JSON-encoded
  attributes natively (`principal.org == resource.org`,
  `resource.geom.area > 1000`). The eventual "contractors only see
  parcels inside their assigned polygon" rule is a single Cedar
  permit.
- **One dependency.** WASM ships in-process; no sidecar daemon (OPA
  Rego eval is fast but operationally heavier for a self-hosted
  v1 portal). The bundle is ~12 MB which is acceptable for a
  Postgres-anchored backend.
- **Sync API.** `isAuthorized()` is synchronous so we can drop it
  inline in existing controllers without an async refactor.
- **Familiar to the AGO crowd.** AGS sharing rules are imperative
  but the underlying mental model (principal, action, resource,
  conditions) maps cleanly to Cedar; users coming from Esri see
  similar shape, written declaratively.

OPA stays a candidate only if a hosted offering ever makes a
policy sidecar pay for itself. A portal serves one organization,
so for the self-hosted product Cedar's in-process model wins.

## Integration scope

Wiring Cedar in is broken into three phases. Phase A landed
alongside this doc; Phase B and C are follow-ups.

### Phase A (this commit)

- Add `@cedar-policy/cedar-wasm@^4.10.0` to `apps/portal-api`.
- Stand up `PolicyModule` + `PolicyService.check()` in
  `apps/portal-api/src/policy/`. `check()` takes a
  `PolicyCheckRequest` (principal, action, resource, optional
  context, optional entities, optional policy override) and
  returns a `PolicyCheckResult` (decision, reasons, errors).
- Ship `DEFAULT_POLICY_TEXT` covering the four
  static rules `SharingService` enforces today: owner can do
  anything; org admin can do anything inside the org; public
  items are world-readable; org-access items are readable by
  org members. Explicit per-share grants
  (`item_share` rows) stay in `SharingService` for now.
- Add a Jest spec exercising every default policy branch plus a
  caller-supplied policy override (forbid-trumps-permit).
- `PolicyService` is registered in `AppModule` so other modules
  can inject it. **No callsites use it yet.** SharingService
  still owns the runtime authorization decision.

### Phase B (next commit, not yet shipped)

Migrate `SharingService.canRead / canEdit / canDownload / canAdmin`
to delegate to `PolicyService.check`. Keep the existing public
function shape so controllers don't change. Each canX call:

- Builds a `PolicyEntity[]` from the principal (User), the org
  (Org), and the resource (Item).
- Calls `policy.check({...})` with the matching action.
- Returns `result.decision === 'allow'`.

The migration is value-preserving: the default policy text is
designed to produce the same answer as the existing function
body, and the existing ~60 sharing tests stay green throughout
the migration.

Per-share grants (`item_share.permission == 'view' | 'edit' |
'download' | 'admin'`) become entity attributes on the User entity:

```cedar
permit (
  principal,
  action == Action::"read",
  resource
) when {
  resource has shareGrants &&
  resource.shareGrants.contains(principal)
};
```

### Phase C (lens-level custom policies, infrastructure shipped)

`apps/portal-api/src/policy/lens-policy.service.ts` adds the
row-level evaluator that runs lens-attached Cedar policies against
per-feature inputs. The lens carries an optional
`Lens.policy` Cedar text field; at read time the engine combines
it with an implicit feature-level baseline (the Item gate already
ran upstream, so the baseline permits) and runs the evaluator per
row. forbid rules in the lens text *narrow* visibility from the
baseline; permit rules in the lens text are redundant but
harmless.

**Geometry predicates: pre-resolved in PostGIS, evaluated as set
membership in Cedar.** Cedar's published WASM bundle (4.x) ships
`decimal`, `datetime`, and `ipaddr` extension types but **not**
geometry. Custom extensions require building Cedar from source,
which the published WASM doesn't expose. The architectural
workaround keeps PostGIS doing the spatial math (where it belongs;
it's fast and we already use it) and feeds the result into Cedar
as a `Set<string>` attribute on the Feature entity:

```cedar
forbid (
  principal,
  action == Action::"read",
  resource is Feature
) when {
  !resource.spatial.contains("assigned_area")
};
```

The read pipeline is responsible for computing
`resource.spatial` per feature: typically a `ST_Within(geom,
$polygon)` against the principal's assigned area or a
geo\_boundary item. Convention: keys are lower-snake-case
identifiers chosen by the lens author (`assigned_area`,
`service_area:fire`, `boundary:abc123`). The resulting set goes
into the `Feature` entity's attributes; Cedar evaluates the
`.contains(...)` membership check natively.

**Attribute predicates** work the same way they would for any
Cedar policy:

```cedar
forbid (
  principal,
  action == Action::"read",
  resource is Feature
) when {
  resource.attrs has cost &&
  resource.attrs.cost > 10000
};
```

The `has` guard is important: a missing attribute on the feature
makes the bare `> 10000` comparison error inside Cedar, which
trips `LensPolicyService`'s evaluation-error path and denies the
row. That's safe-by-default (an unannotated row that should have
been classified is hidden), but lens authors writing intentional
"hide if cost is high *and we know what cost is*" rules should
guard their attribute access.

**API:** `LensPolicyService.checkFeature({ user, lens, feature })`
returns a single boolean per row. It short-circuits on a missing
or whitespace-only `lens.policy` (the read pipeline gets the same
speed as before for unpolicied lenses). Parse errors and runtime
errors fail closed and log so authoring mistakes surface in the
operator log instead of silently leaking data.

### Phase D (read-path wiring)

`DataLayerEngine.listFeatures` now accepts an optional
`lensPolicy: { lens, user, spatialKeysFor? }` argument. When
present, every feature returned by the SQL query is run through
`LensPolicyService.checkFeature`; rows that fail are dropped from
the resulting FeatureCollection. Absent or empty `lens.policy`
short-circuits to passthrough so the unpolicied path stays at
Phase B speed.

Spatial keys are caller-provided. Cedar's WASM has no geometry
extension, so the engine doesn't auto-compute "is this feature
inside the principal's assigned polygon" itself. Callers that
want spatial rules pass a `spatialKeysFor: (feature) => string[]`
function that runs the PostGIS containment check (or otherwise
resolves named keys) per feature; the lens policy then references
the same keys via `resource.spatial.contains("assigned_area")`.

The most common shape for that resolver: query PostGIS once for
"every entity whose geom is inside the principal's assigned
polygon," cache the resulting Set<entityId>, and return
`["assigned_area"]` from the resolver iff the feature's id is in
the cache. That keeps per-feature cost at O(1) hash lookup.

End-to-end tests live in
`apps/portal-api/src/engine/data-layer.spec.ts` under
`DataLayerEngine.listFeatures > lens-policy filtering (Phase D)`:

- Passthrough on absent / empty policy (no Cedar invocation, no
  perf cost)
- Per-row deny based on `checkFeature` decision
- Spatial keys from `spatialKeysFor` reach the policy verbatim
- Feature attrs (caller-set + engine-tracking underscore fields)
  forwarded to the policy intact

Wiring the resolver from real PostGIS queries (e.g. the
`SharingService.geoLimitFor` polygon as the assigned area) is the
next concrete user-facing slice. With Phase D landed, it's a
matter of constructing a `spatialKeysFor` callback that wraps an
`ST_Contains(polygon, feature.geom)` query and threading the
resulting set through; the engine plumbing is in place.

## Entity model

The portal's authorization world has three entity types in v1:

- `User::"<userUuid>"` -- one per portal user. Attributes: `org`
  (entity ref to Org), `role` ("admin" | "contributor" | "viewer").
- `Org::"<orgUuid>"` -- one per organisation. No attributes in v1;
  org membership is recorded as the User's `org` attribute.
- `Item::"<itemUuid>"` -- one per portal item. Attributes:
  `owner` (entity ref to User), `org` (entity ref to Org),
  `access` ("private" | "org" | "public").

Phase B adds a `shareGrants: Set<User>` attribute on Item; Phase C
adds `feature` and `lens` typed entities for row- / lens-level
checks. The schema lives in `apps/portal-api/src/policy/schema.ts`
once Phase B lands; v1 evaluates without a schema (Cedar runs in
"unscoped" mode).

## Performance

Cedar's WASM authorize is reported at sub-millisecond for small
policy sets (<10 rules) on small entity stores (<100 entities). For
v1 sharing checks, that's 4 rules, 3 entities. We expect
authorization to remain off the perf hot path; if it isn't, the
likely culprit is the entity store build (one Item lookup per
request) which we cache with the existing item read.

## Operational notes

- The WASM binary is loaded by `PolicyService`'s constructor; a
  startup failure surfaces in the API logs immediately. Production
  health-check probes route through the same module so a broken
  Cedar install won't pass health checks silently.
- Policy authoring UI is post-launch. Lens-level policies in v1
  are JSON-on-disk in the lens detail page (visible only to org
  admins).
- We do not validate policies against a Cedar schema in v1.
  `validate()` is available in the WASM bundle and is the obvious
  place to add a "save policy" guard once we have the schema.

## References

- [Cedar language spec](https://docs.cedarpolicy.com/)
- [@cedar-policy/cedar-wasm npm](https://www.npmjs.com/package/@cedar-policy/cedar-wasm)
- `apps/portal-api/src/policy/policy.service.ts` -- service entry point
- `apps/portal-api/src/policy/policy.service.spec.ts` -- behaviour
  reference for the default policies

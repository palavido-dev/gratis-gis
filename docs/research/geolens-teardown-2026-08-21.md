# GeoLens teardown

Read of `github.com/geolens-io/geolens` at v1.14.2, 2026-08-21, after
Matt flagged four of their screens as UI references. Apache 2.0, so
reading the code is fine and so is porting an idea; we keep our own
vocabulary either way.

Scale, for calibration: 405 Python files / 144k lines backend
(FastAPI + SQLAlchemy + PostGIS + procrastinate + pgvector), 934 TS
files / 251k lines frontend (React + Vite + TanStack Query + Zustand +
MapLibre). Roughly 395k lines against our roughly 120k. They are a
funded team with an enterprise edition; we are one person. Read every
"they have X and we don't" below with that in mind, because most of
the gap is headcount rather than insight.

The useful finding is the opposite of what I expected going in. On
the things a GIS portal is judged on, we are ahead. On the things
that keep a codebase honest over time, they are ahead, and those are
cheap to copy.

## 1. Take these five

Ordered by value per hour, all small.

### 1.1 A docs contract (do this first)

`docs-contract.json` plus `scripts/check_docs_contract.py`, about 110
lines of stdlib. A machine-readable file of cross-surface facts
(version, ports, the install one-liner, origins) that CI validates
against the *real* sources: version against `pyproject.toml`, ports
against defaults shell-parsed out of `install.sh`.

The half worth having is the `forbidden` regex list, scanned over
every README. Their entries are the insight, not the mechanism:

- `OGC-API-Compliant` is banned because there is no certification and
  the claim is not ours to make.
- A specific `localhost:8001/collections` example URL is banned
  because it omits the `/api` prefix and has the wrong port.
- `admin/admin on a fresh` is banned because the install generates a
  password.

Every one of those is a sentence that was true once.

**Checked 2026-08-22, and half of this section was wrong.** The claim
above that `docs/feature-services.md`, `web-maps.md`,
`sharing-granularity.md` and `data-model.md` "still use the retired
vocabulary" is false: all four contain zero instances. It was inherited
from a CLAUDE.md caveat that had itself gone stale after the docs were
cleaned. The retired terms survive only in `docs/handoff/` (gitignored),
`docs/marketing/` and `docs/research/`, which are quoting history, so a
naive forbidden-list scan over all markdown would be close to pure
noise and would need those scoped out.

The case for a contract is still real, but the evidence is different
and better: **two false claims surfaced in CLAUDE.md in a single
session** (the retired-vocabulary caveat above, and a line asserting
one workspace defines a `test` script when three do). Both were true
once. Neither is the kind of thing a forbidden regex catches; both are
facts that need validating against a real source. That argues for the
version/port/command half of GeoLens's contract rather than the
`forbidden` half that first looked like the prize.

### 1.2 An authorization test that walks the route table

Their `.pre-commit-config.yaml:57` rule sounds like the prize and
isn't: it is a per-file grep that fails a router file mentioning
`get_dataset(` without also mentioning `check_dataset_access`. It is
file-scoped rather than handler-scoped, it only sees that one literal
spelling, and its own description lists the blind spots.

The real guard is `backend/tests/test_rule1_structural.py`. It walks
the **live FastAPI route table**, parses the AST of each handler plus
one level of called helpers, resolves model classes by identity so an
aliased import is still caught, credits a guard only when its
returned filter is actually re-applied, and holds an allowlist that
is asserted exact in **both** directions, so removing a route from
the allowlist without removing the route fails too.

That is the shape our `SharingService.visibleWhere` needs. CLAUDE.md
already says the Prisma `where` is "maintained **by hand** to agree
with `canRead`. Change one, change the other", which is a comment
where a test belongs. Note they have the identical problem and say so
in a code comment naming the two issue numbers where the two paths
drifted apart, so this is a real failure mode and not a theoretical
one.

### 1.3 Source freshness as a pure function that is never stored

`backend/app/modules/catalog/datasets/domain/source_freshness.py`.
`last_refreshed_at` plus the ISO 19115 `update_frequency` vocabulary
gives `fresh` / `due` (past one period) / `overdue` (past two). Four
decisions worth copying wholesale:

- **Never persisted.** Their comment: storing it "would create a
  value whose only possible behaviour is to disagree with the ones it
  came from."
- `now` is a parameter, so thresholds are testable without freezing
  the clock.
- Refreshable origins are an **allowlist**, so an unclassified origin
  reads `unknown` rather than `overdue`. It withholds advice instead
  of naming an action that does not exist.
- Boundaries are strict, so a refresh exactly on cadence is not
  reported late.

Our housekeeping dashboard's stale-items panel is the same problem
and currently uses a flat age threshold.

### 1.4 The escape hatch must require an affirmative value

From `playwright.worktree-guard.ts`. Their guard blocks e2e runs
launched from a linked git worktree, because the dev stack
bind-mounts the *main* checkout, so the tests exercise code you did
not write, giving false failures and, worse, false passes.

Two things to take even though we have no second worktree:

- The detection is a filesystem fact rather than a heuristic. A
  linked worktree's `.git` is a **file**; main's is a **directory**.
  The comments document two rejected designs, including shelling out
  to `git rev-parse`, where a `safe.directory` rejection silently
  disabled the guard.
- `E2E_ALLOW_WORKTREE=0` does **not** bypass. Only values in an
  affirmative set do. Setting a variable to zero to mean "off" is a
  bug this rule kills.

**Checked 2026-08-22: we already do this everywhere, so there is
nothing to borrow.** The claim above that `REQUIRE_PG_SPECS` "is truthy
on any non-empty value" is wrong; it is `=== '1'`. Every other boolean
gate uses an explicit affirmative set: `isScriptsEnabled()` and
`isAdminTierLocked()` both accept only `'1' | 'true' | 'yes' | 'on'`,
and `docker-entrypoint.sh` tests `SKIP_MIGRATE == "true"`. The rule is
worth keeping in mind for the next flag; it is not outstanding work.

### 1.5 SSRF re-checked at connect time

`backend/app/platform/security.py:131`. They re-validate on every
redirect **and** install a custom httpx transport that re-checks the
resolved IP at connect time, which is what actually defeats DNS
rebinding. Our `safeFetch` re-checks after DNS resolution, which is
most of the way there, but the resolution it checks and the
connection the socket makes are two separate lookups. Worth an audit
against their shape, and worth checking our redirect path, which I
have not read recently.

Honourable mention: `frontend/src/lib/builder/raf-coalesce.ts` is
about 60 lines of keyed last-write-wins per animation frame, with an
honest docstring about its single-instance assumption. It kills
style-thrash on the map and would port in an afternoon.

## 2. What they do that we should not copy yet

Real capability, real cost, and none of it is why their demo looks
good.

- **Semantic search.** pgvector plus Reciprocal Rank Fusion over the
  full-text ranking, with a per-query embedding cache and a minimum
  query length of 4 characters because search-as-you-type was burning
  one paid embedding call per keystroke. Every failure path degrades
  silently to full-text. Well built, and it needs a model key, which
  a self-hosted portal with no outbound network cannot have. If we
  ever do this, the degradation path is the part to copy.
- **A refresh-run ledger.** `catalog.dataset_refresh_runs`, one row
  per run created at *dispatch* rather than at commit so a worker
  that dies mid-fetch still leaves a trace, with
  `feature_count_before/after`, a JSONB `schema_diff`, redacted error
  text, and `started_at`/`claimed_at`/`finished_at` so queue wait is
  measurable. A partial unique index is the admission gate, so a
  concurrent refresh gets a 409 atomically rather than by a check.
  This is the best-engineered thing in their backend and it is what
  the "Source refresh overdue" pill sits on.
- **Blue/green table swap on refresh.** Staging table, then
  `ALTER TABLE ... RENAME`, inside a SAVEPOINT with a 5s
  `lock_timeout` and one 15s retry for autovacuum contention. A
  failed refresh leaves the live table untouched. We do not have an
  equivalent because our refresh story is thinner, but the
  lock_timeout detail is the kind of thing you only learn in prod.
- **Ingest idempotency by attempt.** An `attempt_id` threaded through
  every task, and ogr2ogr only ever writes an attempt-owned staging
  table published under the attempt predicate, so a stale worker
  waking up late is a no-op rather than a corruption.
- **An egress matrix.** `EGRESS.md` lists every feature that makes an
  outbound call, its env var, its destination, and the air-gap
  workaround. For a self-hosted product sold to public sector buyers
  that is a genuinely differentiating document, and we have nothing
  like it.
- **Editions seam.** `is_enterprise()` / `require_enterprise()`
  returning **404 rather than 403**, so a paid feature does not
  announce its existence. Typed Protocols with community default
  implementations, an import-boundary test blocking public code from
  importing private packages, and Compose failing closed if the
  edition is set to enterprise without the overlay image. Not
  relevant to us today; the 404-not-403 instinct is.

## 3. Where we are ahead

Worth writing down so the comparison stays honest.

- **Standards.** They have OGC API Features Part 1, Records Part 1,
  CQL2, STAC, and DCAT. They have **no CSW, no WMS, no WFS, no OGC
  API Tiles, and no OGC API Styles**. We have all of those. Their
  conformance is self-declared, tested by about 18 pytest files. One
  detail is admirable though: they *removed* the Features Part 3
  `conf/filter` conformance classes after realising their per-dataset
  collections 400 on `filter`, because advertising a class tells
  spec-driven clients to send requests that always fail.
- **Sharing.** Theirs is one read bit: a four-level enum
  (public / internal / restricted / private) crossed with status, and
  grants are role-based rather than per-user. Write is owner-or-admin
  and nothing else. **No tiers, no groups beyond roles, no row-level
  scoping, no geographic clip on a share, no policy engine.** Our
  view/download/edit/admin tiers, own-rows scoping, polygon geo
  limits and Cedar are all things they do not have.
- **The tile endpoint takes no predicate.** Their MVT route accepts
  `sig`, `exp`, `scope` and `cols`, and nothing else. There is no
  `where`, no filter, no relate. The work I did today has no
  counterpart to copy from them, which also means nobody has checked
  it for me.
- **Tile signing is weak.** `sig` is an HMAC over `scope:exp` only.
  Not the user, not the visibility, not `cols`. `exp` is snapped to
  the next 15-minute boundary so every caller gets the *same*
  signature, which makes it a replayable bearer capability valid for
  15 to 30 minutes to anyone who obtains the URL, and it bypasses the
  visibility check entirely including unpublished drafts. All
  deliberate and documented, for cache-key stability. Our tiles go
  through the same authorization as every other read.
- **API keys carry the whole identity.** No per-key dataset scoping,
  and the deprecated `?api_key=` query lane is still accepted, which
  puts keys in access logs and Referer headers. Ours are
  method-scoped and never travel in a URL.
- **Audit has no tamper-evidence.** No hash chain, no append-only
  constraint, and `details` is mutable JSONB. Retention is a shell
  script rather than the application. The emission side is good
  though: each sink runs in its own SAVEPOINT so a bad audit row
  cannot roll back the mutation that caused it.
- **Multi-tenancy is scaffolding.** Their own comment: inert in
  single-tenant mode, no foreign-key enforcement, FK constraints and
  RLS "land in Phase 1208". Only tile signing reads the tenant scope.

## 4. The four screens Matt flagged

What is actually behind them.

**Catalog search.** A stored generated `tsvector` column, weighted
A/B/C over title/summary/lineage, plus trigram GIN indexes on
unaccented lowercase title and summary, plus a second `simple`
regconfig vector for non-English. The ILIKE half of the query is
deliberately written to match the functional trigram index, with a
comment explaining that the obvious spelling falls back to a seq
scan. Facet counts are a separate endpoint: one CTE materialising the
filtered id set, then five sequential GROUP BY queries, sequential
because their async session cannot execute concurrently on a shared
connection. The rail's counts stay stable when you click a pill
because the facet request strips `record_type` and `collection_id`
from its own params. Anonymous responses cache for 30s. The
"snappy" feel is a 300ms debounce plus TanStack Query's
`keepPreviousData`, not anything exotic.

**Layer config.** `LayerEditorPanel.tsx`, 630 lines, is a tab
orchestrator: `'style' | 'filter' | 'labels' | 'popup'`, with the
available set computed from layer capabilities so a heatmap has no
labels tab, and a proper roving-tabindex ARIA tablist. One component
per tab as siblings. `LayerStyleEditor` then dispatches through a
flat `Record<EditorDispatchKey, Component>` lookup table whose commit
message says it replaced "200+ LOC of nested ternaries". That lookup
table is the structural idea worth taking, more than the tabs.

The per-row badge on the layer list reads `column · N categories`
straight off `style_config`. Note it only fires for categorical
styles; there is no equivalent for class breaks, so a graduated layer
shows nothing.

**Legend.** `LegendEntries.tsx`, 264 lines of primitives:
`GeometrySwatch`, `CategoricalLegend`, `GraduatedColorLegend`,
`GraduatedRadiusLegend`, `GraduatedWidthLegend`, `HeatmapLegend`,
with range strings from a `breakLabel` helper producing `< X`,
`X – Y`, `≥ Z`. Two consumers share them, viewer and builder, and
both fall back to parsing the raw MapLibre expression when the style
config lacks colours. We already ship geometry-shaped swatches and
per-class rows; what we lack is the authored title and the
one-row-for-a-single-symbol collapse.

**3D extrusion.** Not a render mode: a *companion* layer.
`${layerId}-extrusion` of type `fill-extrusion` is added only when a
height column is set, and it takes its colour from the fill layer's
`fill-color`, so a categorical ramp carries into 3D for free. Height
binds as `['coalesce', ['to-number', ['get', col], 0], 0]` times a
scale. Defaults: min zoom 14, opacity cap 0.85,
`fill-extrusion-vertical-gradient: true`.

Their Manhattan seed sets `height_scale: 0.3048` because NYC ships
`height_roof` in feet, and buckets `construction_year` into era
**strings** rather than using a graduated renderer, with a comment
explaining why: the graduated legend abbreviates numbers, so 1900
renders as "1.9K". Terrain exists but is unrelated to extrusion, and
there is **no lighting config and no pitch default tied to 3D**. The
Manhattan camera is set explicitly in the seed script.

## 5. What is over-engineered, so we don't copy it by accident

- `processing/ingest/` is about 20k lines across 34 files, with five
  near-duplicate staging pipelines. One of them is dead in
  production and its own docstring admits it is test-only.
- The STAC router is 1854 lines in one file.
- `use-builder-save.ts` is 1397 lines covering canvas crop maths,
  attribution compositing, thumbnail and OG-image capture,
  blank-image standard-deviation detection, fork, and the layer diff.
  Four unrelated concerns.
- The map plugin registry is a Map, a cache and four modules of
  availability filtering, serving two builtins with no external
  consumers and no dynamic loading. A const array would do.
- One paragraph explaining that `origin_kind` on a run row differs
  from `origin` on a dataset appears verbatim in three files, about
  40 lines each time. If a distinction needs 120 lines of prose,
  rename the column.

Their comment-to-code ratio runs high in general, which is a habit
this repo shares, so the lesson is narrower than "write fewer
comments": a comment that has to be **repeated** is a naming problem
wearing a disguise.

## 6. Recommendation

Two tracks, and they do not compete for the same hours.

The UI work Matt already asked for (tabs over accordions, the
two-column layer panel, the legend title) is a straight port of ideas
we can see, and none of it needs their code.

The other track is the honesty tooling: the docs contract, the
route-table authorization test, and the affirmative-value rule for
env gates. That is maybe two days of work, it addresses failure modes
that have each bitten this repo more than once, and it is the part
that keeps mattering after the screenshots stop being interesting.

Everything else on their side is either headcount or a paid tier.

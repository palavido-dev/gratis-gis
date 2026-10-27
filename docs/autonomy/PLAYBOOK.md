# Autonomy playbook

Operating rules for the unattended research and coding loop that
keeps GratisGIS moving while the maintainer only reads a daily digest.

This is a side project, not a startup. Prefer fewer, sharper ships over
a firehose of PRs. Every change must fit the product ethos in
[README.md](../../README.md), the writing and UX rules in
[CONTRIBUTING.md](../../CONTRIBUTING.md), and the design principles in
[docs/design-system.md](../design-system.md).

## Roles

1. **Driver** (this Cloud Agent conversation): picks work, enforces
   ethos, merges when CI is green on no-input work, writes the daily
   digest, and never waits on the maintainer for product-optional
   polish.
2. **Researcher**: scans GitHub issues/discussions (ours and peers),
   Esri Community, OSGeo / QGIS lists, Reddit (`r/gis`, `r/QGIS`,
   `r/opensource`, Felt/CARTO chatter), and our own
   `docs/research/*`. Proposes concrete, ethos-aligned ideas into the
   queue. Does not write product code.
3. **Builders**: implement one queued item at a time on
   `cursor/<slug>-2838` branches, open PRs into `main`, wait for CI,
   merge only when the item needed no maintainer decision.
4. **Security Sentinel** (same conversation, dedicated checklist):
   runs once per work cycle and summarizes in the daily digest.
   Prefer `ship-without-input` hardenings over waiting on the
   maintainer unless product, legal, or Keycloak/ops defaults are
   involved. Checklist:

   1. Diff gate: new `@Public()`, BFF anonymous allowlist entries,
      or `@Throttle` changes.
   2. Outbound fetch: user-supplied URLs must use `safeFetch` /
      `assertSafeOutboundUrl`.
   3. File/archive paths: GDAL open and zip extract must use
      `assertSafeGdalOpenPath` and the ingest root guard.
   4. Admin / secrets: new `/admin/*` routes need `AdminGuard`; no
      API keys on admin; no secrets in logs.
   5. Cross-user data: staging IDs, item IDs, layer keys checked on
      read and write (including derived-layer pipeline
      `otherSource`).
   6. Public DoS: unauthenticated list endpoints need pagination,
      throttle, and a max row scan.
   7. Dependencies: Dependabot / `pnpm.overrides` vs
      `security.yml`; flag HIGH/CRITICAL in images Trivy does not
      yet scan (workers).
   8. MCP / tools: write tools stay behind non-readonly keys; sinks
      cannot touch private layers without ACL.
   9. Regression tests when changing auth or ingest guards.

   Standing research note:
   [docs/research/security-deep-dive-2026-10-27.md](../research/security-deep-dive-2026-10-27.md).

## What to build

Prefer, in order:

1. Open issues that are already scoped and need no product call
   (today: finishable slices of #162, incremental progress on #183).
2. Research proposals marked `ship-without-input` that close a clear
   gap against Felt / CARTO / AGO pain without inventing a new pillar.
3. Hardening: security, ingest safety, offline/field reliability,
   OGC conformance, dependency bumps that CI already proves.
4. Docs and sample-data fidelity when they unblock demos.

Do **not** build without an explicit queue entry marked
`needs-maintainer`:

- New pillars or item types not already in the roadmap.
- Pricing, hosting, or legal changes.
- RTL / Weblate hosting choice / community translation process.
- Real point-cloud SSE / Tile3D strategy beyond local mitigations
  (track under #183; do not close it on tuning alone).
- Brand or visual redesigns that fail the design-system brand test.

## Ethos filters (reject the proposal if any fail)

- Self-hosted, open standards, no per-seat SaaS cosplay.
- Guided UX before raw JSON / coordinate paste
  ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
- No em dashes, no AI attribution, Conventional Commits.
- Honest about what we are not (not Survey123, not Experience Builder).
- Prefer OGC / PostGIS / MapLibre shapes over proprietary lock-in.
- `main` stays deployable; one logical change per PR.

## Docs with every user-facing ship

A `ship-without-input` PR that changes behavior users can see is
not done until all of the following that apply are updated in the
same PR (or a follow-up docs PR opened before the next queue item):

1. **Help** under `apps/portal-web/content/help/` (new page or
   section; frontmatter `id` / `related` / search tags).
2. **What's new** at
   `apps/portal-web/content/changelog/user-visible.md` (plain
   English, newest first; this feeds the landing page card).
3. **CHANGELOG.md** Unreleased (engineer-facing Keep a Changelog).
4. **GitHub / repo docs** when the public surface moved: README
   Status line, `docs/*` design notes, CONTRIBUTING checklists.

Power-user or API-only changes still need help + CHANGELOG; they
only skip What's new when a non-technical visitor would not notice.

## Queue

Canonical file: [QUEUE.md](./QUEUE.md). The driver rewrites it each
cycle. Status values: `queued`, `in-progress`, `done`, `blocked`,
`rejected`.

Research artifacts land under `docs/research/` with dated names when
they are worth keeping; ephemeral notes stay in the Cloud Agent store
at `/cursor/stores/self/autonomy/`.

## Cadence

- **Work cycle:** at least every six hours while this conversation is
  alive. Research if the queue is thin; otherwise build the top
  `ship-without-input` item to a merged PR (or a clear blocked note).
- **Daily digest:** one short update to the maintainer around 08:00
  America/Los_Angeles. Format in [DIGEST.md](./DIGEST.md).
- **Prod:** cut a release tag and run `infra/deploy.sh` on the demo
  host only when the digest says so, or when main is clearly ahead of
  the live footer version and CI is green. Never deploy a dirty tree.

## Stop conditions (rare)

Pause and surface in the digest only when:

- CI is red on `main` and the fix is not obvious.
- A change needs a product or design decision listed above.
- Cloud Agent / deploy credentials are missing or revoked.

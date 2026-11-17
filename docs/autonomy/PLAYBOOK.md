# Autonomy playbook

Operating rules for the three-stream loop that keeps GratisGIS moving
while the maintainer decides what ships.

This is a side project, not a startup. Prefer fewer, sharper ships over
a firehose of PRs. Every change must fit the product ethos in
[README.md](../../README.md), the writing and UX rules in
[CONTRIBUTING.md](../../CONTRIBUTING.md), and the design principles in
[docs/design-system.md](../design-system.md).

## Three streams

Work is split into three agent streams. They do not share jobs. Hand-off
is through files in this folder and the morning decision list.

```text
Researcher  -->  Scoper  -->  morning yay/nay (Matthew)  -->  Developer
```

1. **Researcher** — gathers ideas and evidence. Does not rank for
   product fit beyond ethos filters, does not write product code, and
   does not open implementation PRs.
2. **Scoper** (spec / review) — objectively reviews Researcher output,
   rejects weak or ethos-breaking ideas, ranks the rest, and writes the
   morning decision list. Does not implement.
3. **Developer** — implements only items Matthew marked **yay**. Opens
   PRs, waits for CI, merges green approved work. Does not invent new
   queue items from research.

Matthew is the final product reviewer. Opening a public PR is not a
review. Other contributors' approvals are not his review, and they do
not merge autonomy PRs.

## Stream 1 — Researcher

**Job:** scan and propose. Output is research artifacts, not a ranked
build queue.

**Sources (non-exhaustive):** GitHub issues/discussions (ours and
peers), Esri Community, OSGeo / QGIS lists, Reddit (`r/gis`, `r/QGIS`,
`r/opensource`, Felt/CARTO chatter), and our own `docs/research/*`.

**Writes:**

- Dated notes under `docs/research/` when worth keeping.
- Cycle artifacts under `docs/autonomy/` (for example
  `research-cycle-N.json` + short summary).
- Ephemeral notes in the Cloud Agent store at
  `/cursor/stores/self/autonomy/` when they are not ready for the repo.

**Does not:**

- Rank items for the morning list (that is the Scoper).
- Mark anything as approved or start a Builder PR.
- Touch help / CHANGELOG / product code except to cite paths in research
  notes.

**Ethos filter (hard reject before hand-off):** self-hosted, open
standards, no per-seat SaaS cosplay; guided UX before raw JSON; honest
about what we are not; OGC / PostGIS / MapLibre over proprietary
lock-in; no em dashes; AI disclosure and Conventional Commits as in
CONTRIBUTING.

**Skip rule (do not propose implementation):** issues labeled
`good first issue`, `help wanted`, or `human-contributor`, or assigned
to a person. A helpful comment is allowed; an implementation proposal
for the Developer is not. Issue
[#183](https://github.com/palavido-dev/gratis-gis/issues/183) stays
comment-only.

## Stream 2 — Scoper (spec / review)

**Job:** second opinion on Researcher output. Be skeptical. Prefer
thin verticals over pillars. Prefer honesty and security over novelty.

**Reads:** latest research cycle, open issues (respecting the skip
rule), [QUEUE.md](./QUEUE.md), [PROPOSALS.md](./PROPOSALS.md), Security
Sentinel notes, README Status / ROADMAP.

**Writes:**

- Ranked morning decision list in [PROPOSALS.md](./PROPOSALS.md)
  (overwrite the pending section each morning).
- Queue rows under `awaiting-decision` in [QUEUE.md](./QUEUE.md) for
  every item on that list.
- Short rationale per item: why now, size, risk, alternatives rejected.

**Ranking rubric (higher first):**

1. Security / data integrity High or Medium.
2. Honesty / docs that prevent false claims.
3. Reliability of shipped surfaces (field, sync, ingest, OGC).
4. Small UX fixes on existing flows.
5. New capability that fits an existing pillar.
6. Nice-to-have polish last.

**Does not:**

- Implement or open product PRs.
- Mark items `approved` (only Matthew's yay does that).
- Expand a proposal into a new pillar without calling that out as
  needing an explicit product call.

**Standing rejects (keep rejecting unless Matthew reverses):** seat
pricing, brand redesigns that fail the design-system brand test, taking
`help wanted` / assigned issues, inventing item types not already on the
roadmap without a product call.

## Morning yay / nay (Matthew)

Around **08:00 America/Los_Angeles**, the Scoper posts the pending list
from [PROPOSALS.md](./PROPOSALS.md) into the autonomy chat (format in
[DIGEST.md](./DIGEST.md)). Matthew replies **yay** or **nay** per id
(short notes optional).

- **yay** → move the id to `approved` in QUEUE (ready for Developer).
- **nay** → move to `rejected` with the reason (or `blocked` if
  "later / needs more design").
- Silence is not approval. Do not start Developer work without an
  explicit yay.

After decisions are recorded, the morning message may include a one-line
prod / security status. It is not a free-form "what we shipped" novel.

## Stream 3 — Developer

**Job:** build approved items only.

**Picks:** top of `approved` in [QUEUE.md](./QUEUE.md), one logical
change at a time. Move to `in-progress` while working.

**Branching / PRs:** `cursor/<slug>-2838` (or `palavido-dev/<slug>-2838`
when that is the active Cloud Agent convention). One logical change per
PR into `main`. Wait for CI. Merge green PRs that implement an approved
id. Do not merge unrelated open PRs or anything marked for maintainer
review that is outside the approved id.

**Docs in the same commit (continuous):** every shippable PR updates
the docs that would otherwise go stale in the same branch:

1. Help under `apps/portal-web/content/help/` when behavior or honesty
   changed.
2. What's new at `apps/portal-web/content/changelog/user-visible.md`
   when a non-technical visitor would notice.
3. `CHANGELOG.md` Unreleased.
4. Repo docs when the public surface moved.
5. `QUEUE.md` (move the id to `done`).

**Security Sentinel** runs in the Developer stream at the start of each
build cycle (and summarizes in the next morning note). Prefer queuing
hardenings onto the Scoper's next list rather than shipping unapproved
product work. Checklist:

1. Diff gate: new `@Public()`, BFF anonymous allowlist entries, or
   `@Throttle` changes.
2. Outbound fetch: user-supplied URLs must use `safeFetch` /
   `assertSafeOutboundUrl`.
3. File/archive paths: GDAL open and zip extract must use
   `assertSafeGdalOpenPath` and the ingest root guard.
4. Admin / secrets: new `/admin/*` routes need `AdminGuard`; no API
   keys on admin; no secrets in logs.
5. Cross-user data: staging IDs, item IDs, layer keys checked on read
   and write (including derived-layer pipeline `otherSource`).
6. Public DoS: unauthenticated list endpoints need pagination,
   throttle, and a max row scan.
7. Dependencies: Dependabot / `pnpm.overrides` vs `security.yml`; flag
   HIGH/CRITICAL in images Trivy does not yet scan (workers).
8. MCP / tools: write tools stay behind non-readonly keys; sinks
   cannot touch private layers without ACL.
9. Regression tests when changing auth or ingest guards.

Standing research note:
[docs/research/security-deep-dive-2026-10-27.md](../research/security-deep-dive-2026-10-27.md).
Do not Nest-throttle MVT / OGC Tiles / storage / point-cloud / health /
portal-info.

**Does not:**

- Pull fresh research into the build queue without Scoper + yay.
- Ship "while we're here" product scope outside the approved id.
- Take `help wanted` / assigned issues.

## Queue

Canonical file: [QUEUE.md](./QUEUE.md). Sections:

| section | meaning |
| --- | --- |
| `awaiting-decision` | On the morning list; waiting for yay/nay |
| `approved` | Matthew said yay; Developer may take it |
| `in-progress` | Developer is building it |
| `blocked` | Cannot proceed (label policy, missing decision, external) |
| `rejected` | Matthew said nay, or Scoper rejected before listing |
| `done` | Shipped (or closed with a recorded result) |

Historical `ship-without-input` rows in `done` stay as history. New work
does not use that class: everything product-facing goes through
awaiting-decision → yay → approved.

## Cadence

- **Researcher:** refill when the Scoper says the proposal pipeline is
  thin, or on a regular research cycle. Hand off to Scoper; do not
  wait on Matthew for research itself.
- **Scoper:** review new research promptly; refresh
  [PROPOSALS.md](./PROPOSALS.md) for the next morning.
- **Morning (08:00 America/Los_Angeles):** Scoper posts the decision
  list ([DIGEST.md](./DIGEST.md)). Matthew replies yay/nay.
- **Developer:** while `approved` is non-empty, build the top item to a
  merged PR (or a clear blocked note). Idle when waiting on decisions.
- **Prod:** cut a release tag and run `infra/deploy.sh` on the demo
  host only when Matthew asks, or when an approved release item is in
  the queue and CI is green. Never deploy a dirty tree.

## Stop conditions (rare)

Pause and surface in the morning note only when:

- CI is red on `main` and the fix is not obvious.
- An approved item turns out to need a product call the Scoper missed
  (move back to `awaiting-decision` with the question).
- Cloud Agent / deploy credentials are missing or revoked.

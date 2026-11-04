# Morning proposals (Scoper-owned)

Ranked list for Matthew's yay/nay. The Scoper rewrites the **Pending
decision** section each morning from Researcher hand-offs. Format for
the chat post is in [DIGEST.md](./DIGEST.md). Process rules are in
[PLAYBOOK.md](./PLAYBOOK.md).

Do not implement from this file. Developer only takes ids that moved to
`approved` in [QUEUE.md](./QUEUE.md) after an explicit yay.

## Pending decision (2026-11-04)

| rank | id | size | risk | summary | why now |
| --- | --- | --- | --- | --- | --- |

No Researcher hand-off since cycle 17 (2026-10-31) drained into v1.1.0. Nothing ranked for yay/nay this morning.

Parked (not listed this morning): `recipe-dag` — PostGIS branching recipe graph; Analyze param shell shipped in v1.1.0, but the DAG remains too large until thinner recipe work is researched again.

Maintainer-owned (not listed): issue [#551](https://github.com/palavido-dev/gratis-gis/issues/551) TrueNAS Scale cannot add users or layer data — Matthew said he will look; not queued for the Developer loop unless yay'd later.

## Decided this week

| id | decision | when | note |
| --- | --- | --- | --- |
| analyze-param-manifests | yay | 2026-11-03 | Morning items 1–4 approved |
| Q-162b / R5-weblate-hosting | yay | 2026-11-03 | Chose Weblate; hosting deferred; git PRs until then |
| R2-comments-mentions / R5-comments-mentions | yay | 2026-11-03 | Shipped: email @mentions with abuse defaults |
| R1-presence-crdt / R5-presence-crdt | yay | 2026-11-03 | Thin signed-in Yjs markup co-edit; defaults locked |

## Scoper reject log (not shown at morning)

| id | when | reason |
| --- | --- | --- |

# Contributing to GratisGIS

Thanks for considering contributing! This doc explains how the project is
organized and how to propose changes.

## Project state

GratisGIS is at **v1.0.0**. The core portal, web maps, forms, App
Builder, field PWA, and the observation-log engine with Cedar policy
authorization are the supported surface (see the status section in the
[README](./README.md)). Dashboards ship as web-app layouts, including
KPI Dashboard and Operations Board. Dedicated document report templates
and store-listed native mobile apps are not built yet. The public
surface in [docs/VERSIONING.md](./docs/VERSIONING.md) follows semver;
internals under `packages/` may still move. The issue tracker reflects
near-term work from [ROADMAP.md](./ROADMAP.md).

## Branching & PRs

- `main` is always deployable.
- Feature work happens on branches named `feat/<short-slug>`; bug fixes on
  `fix/<short-slug>`.
- The automated loop in
  [docs/autonomy/PLAYBOOK.md](./docs/autonomy/PLAYBOOK.md) uses three
  streams (Researcher, Scoper, Developer). The Developer uses
  `cursor/<slug>-2838` (or `palavido-dev/<slug>-2838`) only for items
  Matthew marked yay. Use `feat/` or `fix/` for a change a person
  should review outside that queue.
- PRs require passing CI (lint, typecheck, test, build). Matthew is
  the final reviewer. Others may open pull requests; that is not a
  review. The Developer stream may merge a PR it opened for an
  approved queue item when CI is green. It does not merge a PR marked
  for maintainer review, and it does not treat another contributor's
  approval as Matthew's review.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(portal-api): add /groups/:id/members endpoint
fix(portal-web): don't crash on items with no thumbnail
docs: flesh out deployment guide
```

## Code style

- Prettier + ESLint are enforced. Run `pnpm format && pnpm lint`.
- TypeScript strict mode is non-negotiable; don't `any`-your-way-out.
- Shared contracts go in `packages/shared-types`. If a type is used by
  two or more apps, move it there.

## UX: guided before raw input

A hard product rule, not a suggestion. If a feature asks a user for a
non-trivial input (polygon, schema, list of values, URL, color, rows
of data), the **primary path must be visual, guided, or upload**:
draw on a map, pick from a list, upload a file, choose an existing
portal item, step through a wizard. Raw paste / typed-JSON / manual
coordinate entry is an *advanced fallback* behind a disclosure, not
the default way in. See the full rule in
[docs/design-system.md](./docs/design-system.md#principles) (rule 7).

Reviewers: if a PR adds a surface that lands on a textarea or a long
text input as the primary entry point, push back and ask for the
guided path first. The paste field can live in the PR, just not at
the front.

## How this project is built

Matthew designs, directs, and reviews, and he is the final say. Much
of the code is written with AI coding agents. That includes the
automated loop described in
[docs/autonomy/PLAYBOOK.md](./docs/autonomy/PLAYBOOK.md): a Researcher
proposes, a Scoper ranks a morning list, Matthew gives yay/nay on each
item, and a Developer implements approved items (opens PRs, merges on
green CI). Releases need an explicit ask or an approved release queue
item. Matthew makes the product, security-default, and licensing
calls.

AI-assisted contributions are welcome when the contributor takes
responsibility for the change and says so in the pull request
description.

## Writing style (code comments, docs, commits, PRs)

These rules apply everywhere we write prose for this project: code
comments, commit messages, PR descriptions, docs, and markdown files.

- **No em dashes.** Do not use the em dash character (U+2014), and do
  not use two consecutive hyphens as a substitute for one. Pick a comma,
  colon, period, or parenthesis based on what the sentence actually
  needs.
- **Say when an AI coding agent did the writing.** Put that in the pull
  request description, as described in
  [How this project is built](#how-this-project-is-built). You still
  own the change.
- **Plain, direct prose.** Short sentences over long ones. Concrete nouns
  over puffy abstractions. No "we're excited to announce" style.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/)
  and contain no em dashes and no marketing tone.

A pre-commit check may be added later to enforce the em dash rule
automatically; until then, self-policing is expected.

## Documentation with every behavior change

Keep docs continuously up to date. Ship documentation **in the
same PR (and preferably the same commits) as the code** — not as
a later follow-up. If a PR changes something a person can see or
call:

- Update or add help under `apps/portal-web/content/help/`
  (including rewriting pages that describe options the code does
  not implement).
- Add a plain-English entry at the top of
  `apps/portal-web/content/changelog/user-visible.md` when a
  non-technical visitor would notice (this feeds the landing-page
  What's new card and `/whats-new`). When cutting a version tag,
  add a `## [X.Y.Z] - YYYY-MM-DD` banner above that release's
  entries so the history page can group by version.
- Update `CHANGELOG.md` under Unreleased.
- Touch README / `docs/*` / package READMEs when the public
  surface or status line moved.

Skip What's new for pure internals; still update help and
CHANGELOG when an existing page or engineer note would be wrong.
Autonomy builders also move `docs/autonomy/QUEUE.md` in the same
PR when a queued item ships.

## Tests

- Unit tests live next to source (`foo.ts` → `foo.spec.ts`).
- The authorization algorithm (`items/sharing.service.ts`) must have
  high coverage. it's the bedrock.

## Where should my change go?

| Change | Location |
| --- | --- |
| Add a new item type | `packages/shared-types` + `prisma/schema.prisma` + docs |
| New backend endpoint | `apps/portal-api/src/<module>` |
| Change how sharing works | `apps/portal-api/src/items/sharing.service.ts` (review carefully!) |
| New shared UI component | `packages/ui` |
| New app (field-app, app-builder, …) | `apps/<name>` |
| Infra (Docker Compose, installer, deploy scripts) | `/infra` |

Dev and production infra both live in `/infra` (`docker-compose.yml`,
`docker-compose.prod.yml`, `install.sh`, `deploy.sh`). There is no
Helm chart. `/deploy` only holds a placeholder for a future
`get.gratisgis.org` one-liner; the script there exits without
installing anything. Stack changes do not go in `/deploy`.

## Licensing

GratisGIS is licensed under the GNU Affero General Public License,
version 3.0 or later (AGPL-3.0-or-later). See [LICENSE](./LICENSE) for
the full text.

By submitting a contribution (pull request, patch, doc edit, anything
touching this repository), you agree that your contribution is licensed
under the same AGPL-3.0-or-later terms as the rest of the project. No
separate Contributor License Agreement is required.

New source files should carry an SPDX header on the first line:

```
// SPDX-License-Identifier: AGPL-3.0-or-later
```

(Or the equivalent comment syntax for the file's language.) The
existing tree was swept in one pass; please do not remove headers when
editing.

# Morning decision digest

Post this in the autonomy Cloud Agent chat around **08:00
America/Los_Angeles**. The point is a ranked yay/nay list, not a
narrative status report. Keep it short. No questions unless something
is truly blocked (see PLAYBOOK stop conditions).

Source of truth for the pending rows:
[PROPOSALS.md](./PROPOSALS.md). After Matthew replies, the Scoper (or
Developer when recording decisions) updates [QUEUE.md](./QUEUE.md):
yay → `approved`, nay → `rejected` / `blocked`.

```text
GratisGIS decisions — YYYY-MM-DD (America/Los_Angeles)

Ranked for yay/nay (top first)
1. <id> — <one-line summary> [<size: S/M/L>] [<risk>]
   why: …
2. …
3. …

Reply with yay/nay per id (notes optional). Silence is not approval.

Approved backlog (Developer will take these)
- <id> … | none

Security sentinel
- … (clean | hits; hardenings proposed as ids above if any)

Prod
- gratisgis.org on vX.Y.Z

Blocked / needs you (non-proposal)
- none | …
```

## Rules

- Every numbered item must already appear under `awaiting-decision` in
  QUEUE and in PROPOSALS.
- Do not ask Matthew to re-decide items already in `approved` or
  `rejected` unless new evidence appeared.
- Cap the morning list at roughly **5–8** items. Park the rest for a
  later cycle rather than dumping a long backlog.
- Researcher findings that the Scoper rejected do not appear here;
  they can live in the research JSON under `rejected`.

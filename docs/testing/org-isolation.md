# Organization isolation tests

The API has a test suite that starts the real application against a
real database with two organizations, A and B, and calls every route
over HTTP. It checks that a user of org B cannot read, list, change,
delete or learn about org A's data.

The files live in `apps/portal-api/src/testing/isolation/`:

| File                          | What it holds                                                        |
| ----------------------------- | -------------------------------------------------------------------- |
| `routes.ts`                   | One entry per route: its class and how it is probed.                 |
| `known-gaps.ts`               | Routes that do not meet their check yet, per tenancy mode.           |
| `routes-coverage.spec.ts`     | Fails when a route is missing from `routes.ts`. Needs no database.   |
| `isolation.multi.pg.spec.ts`  | The probe with `GRATIS_TENANCY=multi`.                               |
| `isolation.single.pg.spec.ts` | The same probe in single mode, the self-hosted default.              |
| `topics.ts`                   | Cases that are not one route: clips, map extents, sockets and so on. |
| `harness.ts`, `seed.ts`       | Starting the app and creating the two orgs.                          |

## Running it

The two `*.pg.spec.ts` suites need PostgreSQL 17 with PostGIS. Point
`TEST_DATABASE_URL` at a server where the user may create databases.
Each suite creates its own database, applies the migrations, and drops
it at the end.

```bash
cd apps/portal-api
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/postgres \
  NODE_OPTIONS=--experimental-vm-modules npx jest src/testing/isolation
```

Without `TEST_DATABASE_URL` the two suites are skipped and say so in
their title. CI sets `REQUIRE_PG_SPECS=1`, which turns a skip into a
failure. The whole run takes well under a minute.

Sign-in does not need Keycloak. The suite signs its own tokens with a
key made for the run, and the real auth guard checks them, so `@Public`
handling, API keys and the claims sync are the real code. Object
storage and the Keycloak admin API are in-memory stand-ins, and the
app cannot make outside HTTP calls.

## Adding a route

When you add a controller route, `routes-coverage.spec.ts` fails and
prints the route. Add an entry for it to `ROUTES` in `routes.ts`:

```ts
'GET /api/items/:id/widgets': read(),
'POST /api/items/:id/widgets': write({ body: () => ({ name: 'x' }) }),
'GET /api/widgets': list(),
```

Pick the helper that matches what the route does:

- `read()`: reads one thing by id. Org B gets 404 for org A's id, and
  org A's admin gets a 2xx for the same request.
- `write()`: changes something by id. Org B gets 404 and nothing org A
  owns changes. Give a valid `body`, or the probe stops at validation.
- `list()`: lists or searches. The answer to org B holds none of org
  A's ids, names or text, and in multi mode none of org A's public
  items either: those stay readable by id but are never listed.
- `own()`: a write that only acts on the caller's own org, with no id
  from outside it.
- `pub()`: open to signed-out callers for public items only.
- `pubList()`: a public listing or feed named with `?org=<slug>`. With
  no org it answers 404 in multi mode; named for org A it holds none of
  org B's items.
- `op()`: install-wide powers behind `OperatorOrgGuard`.
- `none()`: no org data at all (health, versions, static lists).
- `skip(cls, reason)`: classified but not probed, with the reason.

Path parameters are filled from the seeded fixtures by name (`:id` is
org A's private data layer, `:mapId` its private map, and so on; see
`DEFAULT_PARAMS`). Use `params` to pick another fixture, for example
`params: { id: 'form:private' }`.

If the control call cannot succeed in the test setup (an outside
service, a file that is not in storage), set `control: 'skip'` and say
why in `reason`.

## When a route fails

Run the suite and read the failure: it says what org B got and what
was expected. If the route really lets org B see or change org A's
data, that is a bug. Fix the route, or, if the fix belongs to other
work, add the route to `known-gaps.ts` with the area that owns the fix
and a neutral one-line note. Do not describe how to exploit a gap in
the repository.

A known gap must keep failing. When a fix makes it pass, the suite
fails until you remove the entry, so the list only gets shorter.

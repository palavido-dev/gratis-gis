# Local development setup

Step-by-step guide for getting GratisGIS running on a developer
workstation. The instructions assume macOS on Apple Silicon (M1
through M4) since that's the most common dev target, but the same
flow works on Intel Macs, Linux, and Windows with WSL2 with only
the prereq install commands changing.

By the end of this guide you'll have:

- Postgres + PostGIS, Keycloak, MinIO, and pg\_tileserv running in
  Docker
- The portal-api (NestJS) and portal-web (Next.js) running in
  watch mode
- Two seeded test users you can sign in as
- A handful of seeded items to poke at

If you'd rather follow a guided tour of the product after you're
running, see [walkthrough.md](./walkthrough.md).


## 1. Prerequisites

You need four things on the host machine:

| Tool | Why | Recommended install on macOS |
| --- | --- | --- |
| Docker Desktop 4.30+ | Runs the infra containers | Download from docker.com (Apple Silicon build) |
| Node.js 20 LTS or newer | Runs portal-api / portal-web | `brew install node@20` or [Volta](https://volta.sh) / nvm |
| pnpm 9+ | Package manager (the repo is a pnpm workspace) | `corepack enable && corepack prepare pnpm@latest --activate` |
| Git | Cloning + commits | `xcode-select --install` includes it, or `brew install git` |

Docker Desktop should be configured with at least:

- 4 CPU cores (the default 2 makes Postgres + Keycloak feel
  sluggish)
- 8 GB RAM (4 GB works but tight if you also run Nominatim)
- 60 GB disk (the planet Nominatim import alone wants ~80 GB; if
  you skip it you only need ~10 GB)

On Apple Silicon, leave the **"Use Rosetta for x86/amd64 emulation
on Apple Silicon"** option checked under Settings → General. A few
of the images we pull (notably `pramsey/pg_tileserv` and the
default `mediagis/nominatim`) only publish amd64 builds; without
Rosetta they fail to start with a `no matching manifest` error.
The other infra images (`postgis/postgis`, `quay.io/keycloak/keycloak`,
`minio/minio`) all have native arm64 builds and run at full
speed.


## 2. Clone and install

```bash
git clone git@github.com:palavido-dev/gratis-gis.git
cd gratis-gis

pnpm install
```

`pnpm install` walks the workspace and pulls dependencies for all
five packages: `apps/portal-api`, `apps/portal-web`,
`packages/shared-types`, `packages/form-schema`, `packages/ui`.
First-time install is a few minutes; subsequent installs are
seconds.


## 3. Start the infra containers

```bash
pnpm infra:up
```

This is a thin wrapper around `docker compose -f infra/docker-compose.yml up -d`.
It boots:

- Postgres 16 + PostGIS 3 on port `5432`
- Keycloak 26 on port `8080` (admin console at `/admin`)
- MinIO on port `9000` (S3) and `9001` (web console)
- pg\_tileserv on port `7800`
- Nominatim (geocoder) on port `8081`

The first run pulls images (a few hundred MB total, plus the much
larger Nominatim data download if you leave it on; see below).
Subsequent runs are seconds.

Tail logs while you wait:

```bash
pnpm infra:logs
```

When everything is healthy, you'll see Keycloak finish importing
its realm and Postgres become ready for connections.


### 3a. About Nominatim

Nominatim is the self-hosted geocoder. It defaults to importing
the **entire planet** OSM extract on first boot, which takes 1 to
3 days on a Mac Mini and ~80 GB of disk. You almost certainly
don't want this for development.

Two options:

**Option A: skip Nominatim entirely.** Comment out the `nominatim`
service in `infra/docker-compose.yml`, or just don't touch it and
let it spin (the rest of the stack starts fine while it imports
in the background; you only lose address geocoding).

**Option B: use a small extract.** Create an `infra/.env` file
(gitignored) with a tiny region:

```bash
NOMINATIM_PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf
NOMINATIM_REPLICATION_URL=https://download.geofabrik.de/europe/monaco-updates/
NOMINATIM_SHM_SIZE=1gb
```

Monaco imports in a few minutes. Replace with your country / state
of interest later.

See [infra/NOMINATIM.md](../infra/NOMINATIM.md) for the full
sizing matrix.


## 4. Run database migrations and seed

```bash
pnpm --filter @gratis-gis/portal-api db:migrate
pnpm --filter @gratis-gis/portal-api db:seed
```

Migrations apply the Prisma schema (auth tables, items, sharing,
folders, etc.). The seed script creates:

- Org **Acme Corp** (`acme`)
- User **Mateo García** (username `mateo`, role `contributor`)
- User **Bob Example** (username `bob`, role `admin`)
- Group **Field Team** with both users as members
- A couple of example items so the items page isn't empty

These match the users that the Keycloak realm import already set
up, so the app side and the auth side line up out of the box.

> Note: `pnpm dev` also runs `prisma migrate deploy` on portal-api
> startup, so you can skip the explicit `db:migrate` step in
> day-to-day work. The seed script does **not** run automatically;
> you only need to run it once per fresh database (or after
> `pnpm infra:reset`, which nukes the volumes).


## 5. Start the dev servers

```bash
pnpm dev
```

Turbo runs the api and web watchers in parallel:

- portal-api: <http://localhost:4000> (Swagger at `/docs`)
- portal-web: <http://localhost:3000>
- Keycloak admin: <http://localhost:8080> (admin / admin)
- MinIO console: <http://localhost:9001> (gratisgis / devpassword)

Open <http://localhost:3000> in a browser. You'll be redirected to
Keycloak's sign-in page.


## 6. Sign in

Two test accounts are seeded on both sides:

| Username | Password | Role | Why use this one |
| --- | --- | --- | --- |
| `bob` | `devpassword` | Org admin | Sees every item in Acme; can manage users / branding / housekeeping |
| `mateo` | `devpassword` | Contributor | Sees only what's shared with him; the realistic "everyday user" view |

Sign in as Bob first to take the admin tour, then sign out and
sign in as Mateo to see what a non-admin's portal looks like.

If you need to add more users, create them in Keycloak under
realm `gratis-gis`. The portal-api auto-syncs Keycloak users into
its own `user` table on first login; you don't have to seed them
twice.


## 7. Daily workflow

```bash
# Start fresh after a system reboot
pnpm infra:up
pnpm dev

# Pull in someone else's changes
git pull
pnpm install         # in case dependencies changed
pnpm dev             # migrations apply on api boot

# Reset everything (nukes data!)
pnpm infra:reset
pnpm --filter @gratis-gis/portal-api db:seed

# Quality gates before committing
pnpm typecheck
pnpm lint
pnpm test
```


## 8. Optional: email notifications

The portal can send email notifications for share-created events
(more triggers in follow-up phases). Off by default. To turn it on,
add the following to your `apps/portal-api/.env`:

```bash
NOTIFICATIONS_ENABLED=true
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_USER=mailbox@example.org
SMTP_PASS=your-password
SMTP_FROM="GratisGIS <noreply@example.org>"
SMTP_SECURE=false           # true on port 465 (SMTPS), false elsewhere

# Optional: portal-name + base URL used in email subjects + deep-link
# bodies. Defaults: "GratisGIS" and http://localhost:3000.
PORTAL_NAME="Acme GIS Portal"
PORTAL_BASE_URL=https://gis.acme.example.org
```

For local dev without a real mail provider, point at MailHog or a
similar capture tool:

```bash
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_USER=
SMTP_PASS=
SMTP_FROM=test@localhost
NOTIFICATIONS_ENABLED=true
```

The worker drains the queue every 30 seconds; failed sends retry
with exponential backoff (60s, 5m, 30m, 2h, 12h) up to 5 attempts
before staying in the `failed` state for admin inspection.

When `NOTIFICATIONS_ENABLED` is unset or `false`, the platform
short-circuits: every `notify()` call is a no-op, no rows accumulate,
no SMTP attempts. Flip the flag back on and existing infrastructure
picks up where it left off.


## 9. Common gotchas

**"Port 5432 is already in use"** — you have another Postgres
running on the host. Stop it (`brew services stop postgresql`) or
change the port in `infra/docker-compose.yml`.

**"Port 8080 is already in use"** — Keycloak's port. macOS itself
sometimes binds 8080; check with `lsof -i :8080`.

**Sign-in loops back to the Keycloak page** — the portal-web's
`NEXTAUTH_URL` and Keycloak's redirect URIs need to agree. The
defaults assume `http://localhost:3000`; if you're running behind
a different hostname, update both the realm export and the env.

**`pnpm install` fails with "ENOTFOUND" or SSL errors** — your
corporate network may be MITM-ing TLS. Set
`NODE_EXTRA_CA_CERTS` to your org's root CA.

**Containers exit immediately after `pnpm infra:up`** — check
`pnpm infra:logs`. Most often Postgres rejected the volume because
of a previous failed init; `pnpm infra:reset` clears it.

**Apple Silicon: `no matching manifest for linux/arm64/v8`** —
make sure Rosetta emulation is enabled in Docker Desktop (Settings
→ General). pg\_tileserv and Nominatim are amd64-only.

**Apple Silicon: containers feel slow** — make sure you didn't
accidentally pull the amd64 versions of the multi-arch images. A
fresh `pnpm infra:reset` + `pnpm infra:up` will pull arm64 builds
where available.

**`db:seed` errors with "user already exists"** — you ran the seed
twice without resetting. The seed is idempotent on uuids but
Keycloak's realm import will fail re-import on a duplicate user.
For a clean reseed, drop the database (`pnpm infra:reset`) and
re-run.


## 10. What lives where

```
gratis-gis/
├── apps/
│   ├── portal-api/        NestJS backend (port 4000)
│   └── portal-web/        Next.js frontend (port 3000)
├── packages/
│   ├── shared-types/      TS types both apps depend on
│   ├── form-schema/       Form definition + validators
│   └── ui/                Shared React components
├── docs/                  Architecture + this guide
├── infra/                 Docker compose, Keycloak realm, init SQL
└── deploy/                Production deployment notes
```

The pieces you'll touch most often:

- **`apps/portal-web/src/app/items/...`** — the frontend pages for
  every item type
- **`apps/portal-api/src/items/...`** — the backend item / sharing
  / admin services
- **`apps/portal-api/prisma/schema.prisma`** — DB schema; create a
  new migration with `pnpm --filter @gratis-gis/portal-api prisma migrate dev`
- **`packages/shared-types/src/...`** — types shared across api +
  web (item types, sharing shapes, etc.)


## 11. Where to go next

- [walkthrough.md](./walkthrough.md): a guided tour of every
  feature for someone coming from an ArcGIS Online / Enterprise
  background
- [data-model.md](./data-model.md): how items, groups, sharing,
  and folders fit together
- [auth-model.md](./auth-model.md): Keycloak + JWT + RBAC details
- [editing-and-collection.md](./editing-and-collection.md): how
  the Editor item type powers data collection
- [sharing-granularity.md](./sharing-granularity.md): per-user,
  per-row, per-column sharing design

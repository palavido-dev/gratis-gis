# Deployment

GratisGIS runs on one Linux host with Docker Compose. The public demo
runs the exact stack described here on a small VPS, so everything below
is the tested path, not aspiration.

## Requirements

- A Linux server you can SSH into. 2 CPU cores and 4 GB RAM work for a
  small organization (the demo runs on that); 4 cores and 8 GB give
  comfortable headroom and unlock the heavier analysis tiers. 20 GB or
  more of free disk.
- Docker Engine with the compose v2 plugin, plus git, curl, and
  openssl. The installer checks and tells you what is missing; it does
  not install Docker for you.
- Three DNS A records pointing at the server: the portal hostname, an
  auth hostname, and a storage hostname (for example `gis.example.org`,
  `auth.gis.example.org`, `storage.gis.example.org`). Certificates come
  from Let's Encrypt automatically once the records resolve.

## Install

One command:

```bash
curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
```

It clones the repo to `/opt/gratis-gis` (override with `GRATIS_DIR`),
runs the guided setup, deploys, and prints where to sign in.

The same flow by hand:

```bash
git clone https://github.com/palavido-dev/gratis-gis /opt/gratis-gis
cd /opt/gratis-gis
./infra/setup.sh
./infra/deploy.sh
```

`setup.sh` asks for your domain, the Let's Encrypt email, and an
organization name, derives the auth and storage hostnames (overridable),
generates every secret, and writes `infra/.env.prod` (mode 600). It
prints the initial credentials once: the portal sign-in
(`admin` plus a generated password that Keycloak forces you to change
on first login) and the Keycloak admin console password. Save them.

Non-interactive use: `./infra/setup.sh --domain gis.example.org
--acme-email you@example.org --yes`.

`deploy.sh` builds the images, starts the stack, runs database
migrations, and reconciles the Keycloak realm. First build takes a
while; later deploys reuse cache.

## Health checks

```bash
./infra/doctor.sh
```

Read-only diagnostics: dependencies, cores, memory, disk, DNS, the env
file, per-container health, and the public endpoint. It also reports
which analysis capability tiers the hardware honestly supports
(browser-tier analysis always works because it runs on the visitor's
machine; heavier server tiers get a recommendation based on cores,
memory, and GPU presence). Exit code 0 means no failures.

## What runs

Docker Compose starts: the portal API (two replicas) and web UI, a
background worker, PostgreSQL with PostGIS, Keycloak 26 (identity),
MinIO (object storage), pg_tileserv (vector tiles straight from
PostGIS), Caddy (reverse proxy with automatic HTTPS), a one-shot
migration container, and two Chromium instances used for print
rendering. Internal services are only reachable on the compose network;
Caddy is the only thing listening on 80/443.

## Upgrades

```bash
cd /opt/gratis-gis
./infra/deploy.sh
```

The deploy script fetches the latest main, rebuilds, applies database
migrations, and swaps containers. Run one deploy at a time and let it
finish.

## Backups

Portal admins can create and download backup archives from the Backup
page in the portal's admin area (database plus uploaded files). For
host-level backups, snapshot the Docker volumes for PostgreSQL and
MinIO while the stack is stopped, plus your `infra/.env.prod`. Keep
`.env.prod` safe either way: `CREDENTIAL_ENCRYPTION_KEY` cannot be
regenerated without losing encrypted credentials.

## Optional pieces

- Geocoding: a self-hosted Nominatim can back the portal's geocoder;
  see `infra/NOMINATIM.md`.
- The maintenance and golden-snapshot scripts in `infra/` exist for the
  public demo's nightly reset and are not part of a normal deployment.

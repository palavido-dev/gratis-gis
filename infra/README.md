# Infra

Local development infrastructure for GratisGIS. Everything runs in Docker so
you don't have to install Postgres, Keycloak, etc. on your host.

## Services

| service | port(s) | credentials (dev only!) |
| --- | --- | --- |
| PostgreSQL + PostGIS | 5432 | `gratisgis` / `devpassword` |
| Keycloak | 8080 (admin) | `admin` / `admin` |
| MinIO | 9000 (S3), 9001 (console) | `gratisgis` / `devpassword` |
| pg\_tileserv | 7800 | - |
| Nominatim (geocoder) | 8081 | see [NOMINATIM.md](./NOMINATIM.md) |

Keycloak is pre-seeded with:

- Realm: `gratis-gis`
- Clients: `portal-web`, `portal-api`, `field-app`
- Users: `admin` / `contributor` / `viewer` in org `acme`; password matches the username (dev-only)

## Usage

```bash
pnpm infra:up     # start everything
pnpm infra:logs   # tail logs
pnpm infra:down   # stop
pnpm infra:reset  # nuke volumes and restart fresh
```

## Production

This compose file is **dev-only**. Do not deploy it as-is. Production
deployments should:

- Use external, backed-up Postgres (RDS, Cloud SQL, or self-hosted with HA)
- Run Keycloak with a real database (Postgres), HTTPS, and admin hardening
- Back MinIO by real object storage or replace with AWS S3 / Cloudflare R2
- Front everything with a reverse proxy (Caddy/Traefik/Nginx)
- After Keycloak boots and the realm is imported, run
  `bash infra/keycloak/patch-user-profile-schema.sh` once. The
  realm-export JSON does not include the user-profile schema, so a
  fresh import starts with `org` / `org_role` undeclared. Without
  the patch, Keycloak 26 silently drops those attributes on every
  user create and new sign-ins 401 with "JWT is missing required
  org claim" (the same failure mode that bit prod when the realm
  was first imported, fixed manually then; #71 makes it
  reproducible). Idempotent: safe to run on every deploy.

### Postgres tuning

`docker-compose.prod.yml` passes the server settings as `-c` flags on
the `postgres` service so they are versioned and a fresh install gets
the same server. They are sized for the demo host (4 vCPU, 7.6 GB,
SSD, Postgres sharing the box with the application); the comment
block above the `command:` says what each one is for and which three
to scale with RAM. `pg_stat_statements` is preloaded and its
extension created in `init-prod-db.sql`, so on a live box

    SELECT calls, round(mean_exec_time) AS ms, rows, left(query, 80)
    FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20;

lists where the time goes. Temp files over 10 MB and lock waits over
a second are logged. Changing a memory flag needs a container
recreate (`docker compose up -d postgres`), which the deploy script
does when the compose file changed; expect ten to twenty seconds
without a database while the API replicas reconnect.

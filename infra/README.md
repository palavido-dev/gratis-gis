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

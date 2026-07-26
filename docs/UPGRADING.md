# Upgrading between releases

This guide is for self-hosters running the single-host Docker Compose
stack from a git checkout, as installed by `infra/install.sh` or the
manual flow in [deployment.md](./deployment.md). Starting with v0.9.0,
releases are git tags named `vX.Y.Z`, listed in
[CHANGELOG.md](../CHANGELOG.md) and on the GitHub releases page.

Until v1.0.0, a minor release (0.9 to 0.10) may include breaking
changes; each one is called out in its changelog section. Read the
section for the release you are moving to before you start. The
policy is in [VERSIONING.md](./VERSIONING.md).

## 1. Back up first

Before any upgrade:

1. In the portal, open the admin area's Backup page and create a
   backup archive (database plus uploaded files). Download it off the
   host.
2. Keep a copy of `infra/.env.prod` somewhere safe.
   `CREDENTIAL_ENCRYPTION_KEY` cannot be regenerated without losing
   encrypted credentials.
3. Optionally, for extra safety on big jumps: stop the stack and
   snapshot the PostgreSQL and MinIO Docker volumes at the host level.

See the Backups section of [deployment.md](./deployment.md) for
details on both backup surfaces.

## 2. Upgrade

```bash
cd /opt/gratis-gis
./infra/deploy.sh
```

The deploy script takes the shared deploy lock, fetches from origin
(tags included), resolves the target ref, hard-resets the checkout to
it, echoes which ref and commit it is deploying, rebuilds the images,
and rolls the stack. Run one deploy at a time and let it finish; the
lock makes a second concurrent run exit early.

Ref resolution:

- Default: the newest stable release tag (`vX.Y.Z`). Pre-release tags
  such as `v1.0.0-rc.1` are never picked automatically.
- `GG_REF` overrides the default with any tag, branch, or commit sha:

```bash
GG_REF=v0.9.0 ./infra/deploy.sh   # pin an exact release
GG_REF=main ./infra/deploy.sh     # old behavior: track main
```

- If the repository has no release tags yet, the script warns and
  falls back to `main`.

To see which releases exist, check the GitHub releases page, or run
`git fetch origin` followed by `git tag -l 'v*'` in the checkout.

Skipping releases (for example v0.9.0 straight to v0.11.0) is
supported: migrations apply in order regardless of which tags you
stopped at. Still read every skipped release's changelog section.

## 3. How migrations run

There is no separate migration step; the deploy applies pending
database migrations automatically. Mechanically:

- The production compose file (`infra/docker-compose.prod.yml`)
  defines a one-shot `portal-migrate` service that runs
  `prisma migrate deploy` against the database and exits. The API
  replicas and workers declare a dependency on it completing
  successfully, and they skip their own migration pass
  (`SKIP_MIGRATE=true`), so pending migrations apply exactly once per
  deploy.
- As a fallback for setups without the one-shot service, the
  portal-api container entrypoint
  (`apps/portal-api/docker-entrypoint.sh`) applies migrations itself
  at boot whenever `SKIP_MIGRATE` is unset.

A failed migration aborts the boot: the migrate container exits
nonzero and the API containers never start, which surfaces in
`docker compose ps` and the log tail the deploy script prints. That is
deliberate; a crash loop is easier to see than a silently
half-migrated schema.

Migrations are forward-only. Down migrations are not provided.

## 4. Rollback

Two situations, depending on whether the new release's migrations ran.

**The new release did not migrate the schema** (the release notes list
no migrations, or the deploy failed before `portal-migrate` ran):
redeploy the previous tag and you are done.

```bash
GG_REF=v0.9.0 ./infra/deploy.sh
```

**The new release migrated the schema**: because down migrations are
not provided, rolling back the code is not enough; you also have to
restore the data. In order:

1. Redeploy the previous tag with `GG_REF` as above. The older
   release may fail to boot against the newer schema, or boot and
   misbehave; either way, do the restore step.
2. Restore the backup you took before the upgrade. The admin Backup
   page can preview and restore an archive (this is destructive and
   asks for confirmation), or restore the host-level volume snapshots
   if you took those.

Anything written between the upgrade and the restore is lost with the
restore. If users worked on the new release before you decided to roll
back, export what they need first.

When a rollback keeps failing, or you are unsure whether the schema
moved, open an issue with the output of `./infra/doctor.sh` and the
deploy log rather than experimenting on the production database.

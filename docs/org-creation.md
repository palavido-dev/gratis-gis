# How an organization is created

Developer notes. This is not user help.

Sign-in follows one of two rule sets, chosen in
`apps/portal-api/src/common/tenancy.ts`. The default is `single`.

Two code paths can write a local `user` row from Keycloak data:

- `AuthSyncService.upsertFromClaims` (`src/auth/auth-sync.service.ts`),
  on every request that carries a Keycloak JWT.
- `KeycloakSyncService.reconcileAll` (`src/admin/keycloak-sync.service.ts`),
  at boot, on the hourly housekeeping run and from "Sync now".

The org comes from the Keycloak user attribute `org`, which reaches the
token as the `org` claim. It is normally the org's slug. Accounts
invited before the slug fix carry the org's id instead, so a value
shaped like a UUID is looked up by id first, then by slug.

## Single mode (the default)

- The first sign-in whose `org` claim matches no org creates it. The
  install's own org (`DEFAULT_ORG_SLUG`, `gratis-gis` by default) is
  named `DEFAULT_ORG_NAME`. Any other org starts with its slug as its
  name.
- The org is read first and created only on a miss, so a steady-state
  request writes nothing.
- On the first sign-in to an org in each API process, the built-ins are
  seeded: basemaps, app templates, themes and print templates.
- A user whose `org` attribute changes is moved to the new org on their
  next sign-in, and by the next `reconcileAll` run. Their items stay in
  the old org.
- `reconcileAll` never creates an org. A realm user whose org has no
  local row is skipped and counted in `skippedUnknownOrg`.

## Strict mode

A sign-in never creates an org and never moves a user to another org.
Orgs and their built-ins are created outside the sign-in path.

On sign-in (`upsertFromClaims`):

- Unknown org (no org with that slug, or no org with that id): 401
  `This account is not attached to an organization.` Nothing is written.
  The slug is logged at warn level, at most once a minute per slug.
- Existing user whose row is in another org than the claim names: 401
  with the same message, and an error in the log. The row is not
  changed. The message is the same as for an unknown org, so the answer
  never confirms that another org exists.
- New user in a known org: the row is created as in single mode.
- Built-ins are not seeded on sign-in.
- An update to an existing row never writes `org_id`. If a racing
  request created the row in another org between the read and the
  write, the request is refused.
- `assertOrgUsable(org)` runs on the uncached path. It is empty for
  now.

Steady state costs the same queries as single mode: one org read and
one user read on a cache miss, none on a cache hit.

The principal cache is keyed by the token's `sub`. The `org` claim is
part of the entry's fingerprint, so a token with a different `org`
misses the cache, takes the path above and is refused. The old entry
is dropped before the rebuild.

In the realm mirror (`reconcileAll`):

- A realm user whose org has no local row is skipped, as in single mode.
- A realm user whose local row is in another org is not moved and not
  updated. It is counted in `skippedOrgMismatch` and logged at error
  level. A disable made in Keycloak still reaches that row.
- Each page of realm users costs one extra read (the local rows for
  those usernames). Single mode does not make it.

## Credentials that are not a user's JWT

- API keys resolve to a stored user and its stored org. They carry no
  `org` claim and never reach this path.
- The server-side print credential resolves to the job's stored user.
- `portal-api-admin` is a confidential client that portal-api uses to
  call Keycloak's admin API. Its access tokens have `azp` set to
  `portal-api-admin`, which the default `JWT_ALLOWED_AZP` list refuses
  before any of the above runs. An operator who adds it to the list
  (the demo snapshot tooling does) makes it sign in like a user: its
  `org` attribute, which `infra/deploy.sh` sets to `DEFAULT_ORG_SLUG`,
  picks its org, and in strict mode the same two rules apply to it.

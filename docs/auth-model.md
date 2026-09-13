# Auth Model

## Identity provider: Keycloak

Keycloak is the source of truth for authentication. It handles sign-up,
sign-in, password reset, 2FA, social login, and SSO. GratisGIS apps never
see passwords.

### Realm + Clients

Realm: `gratis-gis`

Clients:

| client-id | kind | used by |
| --- | --- | --- |
| `portal-web` | public (PKCE) | Next.js portal frontend |
| `portal-api` | bearer-only | NestJS API (validates JWTs) |
| `qgis-plugin` | public (PKCE, native redirect, `offline_access`) | QGIS plugin; reconciled by `infra/deploy.sh` |
| `field-app` | public (PKCE, native redirect `gratisgis://auth-callback`, `offline_access`) | Android field app (`docs/mobile-field-app.md`). Redirect list is reconciled by `deploy.sh` / `restore-golden.sh` to the native scheme only |

`portal-api` checks issuer and signature only, not `aud`, so a token
from any realm client is accepted. If audience checking is ever added,
every client above has to be in the accepted set.

## Token Flow

1. User clicks "Sign in" in `portal-web`.
2. `next-auth` redirects to Keycloak's authorization endpoint (PKCE).
3. On return, `next-auth` exchanges the code for an access + refresh token.
4. `portal-web` server components forward the access token to `portal-api`
   as `Authorization: Bearer <jwt>`.
5. `portal-api` validates the JWT signature against Keycloak's JWKS and
   extracts claims.

## Required JWT Claims

| claim | meaning |
| --- | --- |
| `sub` | Keycloak user id: becomes `user.id` |
| `preferred_username` | → `user.username` |
| `email` | → `user.email` |
| `name` | → `user.full_name` |
| `org` (custom) | Organization slug: mapped to `user.org_id` at first login |
| `org_role` (custom) | `viewer` \| `contributor` \| `admin` |

Org assignment and org-role are set in Keycloak via user attributes; the
portal-api `auth.service` looks them up and upserts the local `User` row on
each login.

## Authorization in the API

NestJS uses a global `JwtAuthGuard` (backed by `passport-jwt`). Each request
gets a typed `AuthUser` injected:

```ts
type AuthUser = {
  id: string;        // user.id
  orgId: string;
  orgRole: 'viewer' | 'contributor' | 'admin';
  groupIds: string[]; // cached per request, resolved from DB
};
```

Access decisions are delegated to `sharing.service.canRead(user, item)` etc.,
implementing the algorithm in `data-model.md`.

## API keys (machine-to-machine)

A 5 minute access token is unusable for a script, so unattended
clients (cron, notebooks, CI, the MCP server) authenticate with a
personal API key instead. Users mint keys at Profile -> API keys;
they are sent as an ordinary `Authorization: Bearer <token>` to
portal-api, which Caddy routes without passing through the web tier.

- Format `ggk_<43 chars base64url>`: a scheme marker plus 32 bytes of
  entropy. The marker lets the auth guard route the credential, lets
  secret scanners match a fixed prefix, and tells a human what they
  are holding.
- Stored as SHA-256, never encrypted and never recoverable. The token
  is shown once at creation. A database dump yields no usable keys.
  This is deliberately unlike `item_credential`, whose secrets must
  be decrypted to forward upstream.
- A key resolves to the same AuthUser its owner gets from a JWT, so
  sharing, geo limits, and capabilities run through one code path.
- Two key-only restrictions, enforced in the auth layer:
  `/admin/*` is refused for any key (AdminGuard checks role, so an
  admin's leaked key would otherwise carry user management and
  backup/restore), and a `read_only` key is refused on any unsafe
  HTTP method. Keys also cannot mint or revoke keys, since minting a
  credential from a credential is an escalation path.
- Unlike the JWT path, key resolution checks `deleted_at` and
  `auto_disable_at` itself: a long-lived key never revisits Keycloak,
  so it would otherwise outlive the account that owns it.

## Session Security

- Access token TTL: 5 minutes
- Refresh token TTL: 1 day (web). Native clients (`qgis-plugin`,
  `field-app`) request `offline_access` and get Keycloak offline
  sessions instead, which idle out after 30 days (Keycloak's default
  `offlineSessionIdleTimeout`; the realm template does not override it).
- Per-device revocation is per offline session: each native sign-in is
  its own offline session, listed and revocable per user in the Keycloak
  admin console and Admin REST API. There is no device-id claim and no
  portal-side device registry.
- CSRF: `portal-web` uses `next-auth`'s built-in CSRF protection for its
  own routes; API calls carry bearer tokens (not cookies), so no CSRF
  concern on the API.
- CORS: portal-api answers cross-origin browsers per route
  (`src/common/cors.ts`). `/api/public/*` and `/health` allow any
  origin for GET/HEAD/OPTIONS, because the open-data endpoints exist to
  be loaded into other sites' map pages. Every other route allows only
  the origins in `CORS_ALLOWED_ORIGINS`, empty by default: the portal
  UI is same-origin behind Caddy in prod and goes through the BFF in
  dev, so nothing first-party needs an entry. Credentials are never
  allowed, so a cookie cannot ride a cross-origin call even if one
  were ever introduced.

## Offline Auth (field app)

The field app holds its access and offline refresh tokens in
Keystore-backed storage plus the last-synced user snapshot. While
offline it reads `exp` and the identity claims from the access token
without verifying the signature: the token arrived from Keycloak over
TLS, and an attacker who can tamper with the token store could replace
a cached JWKS in the same write, so on-device verification would
protect nothing. The server is the verifier. A past `exp` means
"refresh when next online"; queued work is unaffected until then.

## Future

- SAML realm aliases for enterprise SSO
- Audit log for admin actions

# Portal session length

The portal cookie lasts 365 days unless the operator sets a shorter
window. Existing cookies are not deleted when the setting changes, and
nothing here calls Keycloak's revoke endpoint. A shorter cookie does
not mean the identity server has forgotten the user. The realm's own
session limits still apply on the next token refresh.

Set these on `portal-web` and restart that service. Leave them unset
to keep the current behavior.

| Variable | Meaning |
| --- | --- |
| `GRATIS_SESSION_MAX_AGE_SECONDS` | Lifetime of a new portal cookie. Minimum 15 minutes, maximum 365 days. Unset, empty, or out of range keeps 365 days. |
| `GRATIS_SESSION_IDLE_SECONDS` | If set, a cookie that is presented after this much inactivity is treated as signed out. Unset means there is no idle check. Minimum 15 minutes, maximum 365 days: a value outside that range is clamped to it, and a value that is not a whole number of seconds uses 15 minutes. Both log a warning. A cookie that has never recorded activity is not signed out on the first request after an upgrade. |

Keycloak access-token lifetime is separate. The portal refreshes it
while the cookie is still accepted. Idle timeout on the portal cookie
does not revoke that refresh token at Keycloak.

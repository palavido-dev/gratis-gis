# Auth provider admin UI - design doc

## Why this exists

Today, configuring how users sign in to a GratisGIS portal means
opening the Keycloak admin console at `:8081/admin/master/console/`,
navigating to the realm, drilling into "Identity providers" or
"Authentication", and editing flows / mappers / clients. That admin
console is excellent for what it is, but:

1. It is a separate app on a separate domain. Admins have to leave
   GratisGIS, sign in with separate credentials, and learn a UI that
   looks nothing like the rest of the portal. This violates the
   "don't make admins jump between apps" ethos that drove the
   in-portal SMTP card (#137) and the housekeeping/notifications
   surfaces.
2. It exposes every Keycloak primitive (flows, executions, required
   actions, authentication policies, conditional sub-flows, ACR
   levels). 90% of what a small org's admin actually needs to do is:
   "let my staff sign in with our existing Microsoft/Google account",
   plus a small handful of policy toggles. The Keycloak surface
   buries those tasks under three or four levels of abstraction.
3. It does not match GratisGIS's design language. Buttons, modals,
   error messaging, tone of voice are all different. Admins coming
   in from the rest of the portal feel like they fell into a
   different product.

This doc proposes a Settings -> Security surface inside the portal
that covers the auth-config tasks a small-org admin actually
performs, with Keycloak still doing the heavy lifting underneath.
Power users can still drop down to the Keycloak console for the
edge cases; the in-portal UI is the "happy path" for the 90%.

The reference comparison is ArcGIS Online's organization settings
Security tab (`/home/organization.html?tab=security`). AGO has spent
years finding the right level of abstraction for non-developer org
admins. Their surface is the closest analogue to what we want.

## Source survey: what AGO's Security surface offers

I walked through every section of AGO's `Settings -> Security` tab
on a real org so this proposal is anchored in something concrete.
The right-rail section list is:

* Policies (anonymous access, allow-cross-org sign-in, allow profile
  edit, allow new built-in accounts, public sharing rules, social
  links toggle).
* Sign-in policy (password policy + lockout settings).
* Logins (the meat: SAML / OIDC / built-in / social, ordered by drag
  handles, each row toggleable on/off).
* Certificates and keys (Beta) (manage SP-side certs used to sign
  SAML requests / decrypt assertions).
* Multifactor authentication (org-wide enable, designated admins
  for MFA recovery, adoption stats).
* Email verification (force prompt for unverified members).
* Access notice (terms-of-service the admin can show on first
  sign-in for org members and / or all users).
* Information banner (top/bottom strip for maintenance / classified
  notices).
* Trusted servers (servers we'll forward web-tier creds to).
* Allow origins (CORS allow-list for the REST API).
* Allowed email links (domain allow-list for outgoing email content).
* Allow portal access (other portals that can use our enterprise
  logins).
* Apps (Approved apps + Blocked Esri apps).
* Regional data hosting (read-only, set at purchase).

The screen is dense (meant for an org admin who already knows
SAML/OIDC vocabulary), but each section is a small, contained card
with a clear concern. The "Logins" section in particular is what
most non-power-user admins touch first. Its pattern: a list of
sign-in methods, drag to reorder (which controls how they appear on
the sign-in page), per-method on/off switch, "Configure login" button
that opens a modal with the method's full config. New methods are
added via a small set of buttons at the top: "New OpenID Connect
login" being the most prominent.

### Per-method configuration depth (observed, not guessed)

**OIDC modal fields (top to bottom):**

* Login button label (display text).
* Let new members join: Automatically | Upon invitation from an
  Admin (segmented control).
* Registered client ID.
* Authentication method: Client secret OR Public/Private key
  (radio + nested field).
* Provider scopes/permissions.
* Provider issuer ID.
* OAuth 2.0 authorization endpoint URL.
* Token endpoint URL.
* JWKS URL.
* User profile endpoint URL (recommended).
* Logout endpoint URL (optional).
* Send access token in header (toggle).
* Use PKCE enhanced Authorization Code Flow (toggle).
* Send locale parameter (toggle) + Specify locale.

**SAML modal fields (top to bottom):**

* Name (display).
* Join policy (Automatically | By invitation).
* Metadata source: URL | File upload | Parameters specified here
  (3-way segmented control). This is the killer detail. Most IdPs
  publish a metadata XML; admins should never have to copy-paste
  individual URLs and certs when the IdP gives them a metadata URL
  or a downloadable XML.
* Login URL (Redirect).
* Login URL (POST).
* Certificate (textarea, base64 PEM body).
* Show / Hide advanced settings (collapsed by default):
    * Allow Encrypted Assertion (toggle).
    * Enable signed request (toggle).
    * Primary SAML certificate (cert dropdown referencing the
      Certificates-and-keys store).
    * Secondary SAML certificate (rotation slot).
    * Propagate logout to IdP (toggle).
    * Update profiles on sign in (toggle).
    * Enable SAML based group membership (toggle).
    * Logout URL (optional).
    * Entity ID (computed from org slug, read-only).
    * Link to download the service provider metadata (so the admin
      can register US in their IdP).

The "advanced settings" collapse is the entire reason this UI works
for novices. The default-visible surface is just enough to copy from
an IdP's "set up SAML" page. Everything else lives behind one extra
click.

## Mapping AGO's surface to GratisGIS

Not all of AGO's Security tab is relevant to us today. Some of it
maps to features we don't have (Open Data, Hub email links, ArcGIS
Pro app launcher). Triage:

| AGO section                | Build now? | Notes                                           |
|----------------------------|------------|-------------------------------------------------|
| Policies (anonymous, etc.) | Phase 2    | We have most as separate toggles already        |
| Sign-in policy / password  | Phase 1    | Maps directly to Keycloak password policies     |
| Logins (SAML / OIDC)       | **Phase 1** | The headline feature                            |
| Certificates and keys      | Phase 2    | SAML SP certs; we can ship without rotation     |
| MFA                        | Phase 2    | Keycloak has it; we just expose the org toggle  |
| Email verification         | Phase 1    | Already half-built via the SMTP work            |
| Access notice              | Phase 3    | Nice-to-have, not auth-critical                 |
| Information banner         | Phase 3    | Already covered by branding work                |
| Trusted servers            | Skip       | Maps to Esri's web-tier auth, not us            |
| Allow origins (CORS)       | Phase 2    | Useful for embedded portals                     |
| Allowed email links        | Skip       | Hub-specific; we send notifications differently |
| Allow portal access        | Skip       | Esri-portal federation                          |
| Apps (Approved / Blocked)  | Skip       | Esri app launcher                               |
| Regional data hosting      | Skip       | Procurement-time, not admin-time                |

Phase 1 = "what an admin needs to stop using the Keycloak console
for daily work". Phases 2 and 3 are follow-ons.

## Proposed surface (Phase 1)

Add a new section to `Settings -> Security` (which today doesn't
exist as a page; the admin nav already has Branding, Notifications,
Housekeeping, Members, Sharing). Three cards, in this order:

### Card 1: Sign-in methods

The headline card. List every configured sign-in method as a row,
in the order it appears on the sign-in page. Each row:

* Drag handle on the left (reorder = changes sign-in-page order).
* Method icon (Microsoft / Google / SAML / OIDC / built-in).
* Display name + summary line ("SAML, configured for example.com").
* On/off toggle.
* "Configure" button (opens the per-method modal).
* Kebab menu: Test sign-in, Remove.

Above the list, a short toolbar:

* "Add sign-in method" dropdown -> SAML, OpenID Connect, Built-in
  (always offered if not already present), Google preset, Microsoft
  preset, GitHub preset.
* "Preview sign-in page" link (open in new tab).

The presets matter. "Google preset" pre-fills the OIDC issuer URL,
authorization / token / JWKS endpoints, and the recommended scopes
(`openid profile email`). The admin only has to paste in their
client ID and secret. Same for Microsoft Entra (formerly Azure AD)
and GitHub. AGO has the equivalent but limits it to social logins
on a fixed list; we should let the SAML/OIDC presets cover the
common identity providers (Entra, Okta, Auth0, Google Workspace).

### Card 2: Sign-in policy

Mirrors AGO's Sign-in policy card. Two sub-sections:

**Password policy** (only relevant if built-in sign-in is enabled):

* Minimum length (default 8).
* Must contain at least one letter.
* Must contain at least one number.
* Must contain at least one special character.
* Must not contain the username.
* "Use built-in defaults" reset button.

**Lockout policy** (org-wide, applies to built-in accounts):

* Failed sign-in attempts before lockout (default 5).
* Lockout duration in minutes (default 15).

### Card 3: Account lifecycle

Things adjacent to auth that are too small to deserve their own
card:

* "Require email verification before sign-in" (toggle).
* "Members can edit their own profile" (toggle).
* "New users default to..." (link to existing /admin/users settings).

This card grows over time. Phase 1 is just the email-verification
toggle, which we already have plumbing for from #137 / #139.

## Per-method modal designs

### Built-in (the simplest)

Just a name, an "Enabled" toggle, and a description of what it is.
No other config. AGO calls this "ArcGIS login" and only lets you
flip it on/off; we follow suit.

### SAML modal

Pattern adapted from AGO's, simplified:

```
Add SAML sign-in
================
Display name:        [_______________________]
                     (shown on the sign-in page)

How users join:      ( ) Automatically on first sign-in
                     (o) Only by admin invitation

Configure from:      ( ) Metadata URL  (most IdPs)
                     ( ) Metadata file (XML)
                     (o) Manual entry

  (if Manual entry is selected:)
  Login URL (Redirect): [_______________________]
  Login URL (POST):     [_______________________]
  IdP signing cert:     [textarea, PEM]

> Show advanced settings (collapsed)
  Sign requests with our cert: [toggle, default off]
  Encrypt assertions:           [toggle, default off]
  Propagate logout to IdP:      [toggle, default on]
  Update profile on sign-in:    [toggle, default on]
  SAML group attribute:         [optional field]
  Custom logout URL:            [optional field]

  Service-provider metadata URL: <copy link>
  Entity ID:                     gratis-gis://<org-slug>

[Cancel]                                    [Save]
```

The "Configure from" 3-way is taken straight from AGO. Picking
"Metadata URL" lets the admin paste their IdP's published metadata
URL and we fetch + parse it server-side; we extract the login URLs,
Entity ID, and signing cert and pre-fill them. Picking "Metadata
file" lets them upload the XML the IdP gave them. "Manual entry"
is the escape hatch.

### OIDC modal

Same approach, with presets across the top:

```
Add OpenID Connect sign-in
==========================
Provider:            [ Custom | Microsoft Entra | Google | Okta | Auth0 | GitHub ]

Display name:        [_______________________]
How users join:      ( ) Automatically  (o) By invitation

Client ID:           [_______________________]
Client secret:       [********** ] (or "Use public key" radio)

> Endpoints (auto-filled by preset; editable for Custom)
  Issuer URL:                [_______________________]
  Authorization endpoint:    [_______________________]
  Token endpoint:            [_______________________]
  JWKS URL:                  [_______________________]
  Userinfo endpoint:         [_______________________]
  Logout endpoint:           [_______________________]

> Advanced
  Scopes:                    [openid profile email]
  Use PKCE:                  [toggle, default on]
  Send token in header:      [toggle, default off]

[Cancel]                                    [Save]
```

A preset like "Microsoft Entra" knows the URL pattern for the well
-known endpoints (a single tenant ID is usually all the admin has
to type) and pre-fills everything. Selecting "Custom" expands the
endpoints section and lets them paste the issuer URL; we attempt
discovery via `<issuer>/.well-known/openid-configuration` and
fill in the rest.

### Social presets

Google / Microsoft / GitHub social-login presets behave like OIDC
modals with the issuer fixed to the provider and the only required
fields being client ID + secret. UI-wise they look like OIDC but
with a friendlier first-screen ("Paste your Google OAuth client
ID and secret. We'll handle the rest.") and a help link to the
provider's developer console.

## How this maps to Keycloak underneath

Each in-portal "sign-in method" maps to one Keycloak Identity
Provider in our realm. The portal-api service uses the existing
KeycloakAdminService to:

* `GET /realms/{realm}/identity-provider/instances` for the list.
* `POST .../instances` to create.
* `PUT .../instances/{alias}` to update.
* `DELETE .../instances/{alias}` to remove.
* `PUT /realms/{realm}` for password policy (`passwordPolicy`
  string) and lockout (`bruteForceProtected`,
  `failureFactor`, `waitIncrementSeconds`, `maxFailureWaitSeconds`).

The "metadata URL" / "file" / "manual" 3-way for SAML maps to
Keycloak's `POST /realms/{realm}/identity-provider/import-config`
endpoint, which accepts either a URL (`fromUrl`) or an uploaded
file and returns a parsed config object the portal then PUTs into
a new instance. We never reinvent the SAML XML parser.

The OIDC discovery happens the same way:
`POST /realms/{realm}/identity-provider/import-config` with
`{ providerId: 'oidc', fromUrl: '<issuer>/.well-known/openid-configuration' }`.

For the social-login presets, Keycloak ships with first-class
providers (`google`, `github`, `microsoft`) that need only client
ID/secret, so the modal can be even simpler than the generic OIDC
form.

The reorder feature maps to the per-IdP `displayOrder` config
property; the on/off toggle maps to `enabled`.

The KeycloakAdminService already has `ensureManageRealm()` from
#139 which auto-grants the realm-management role our admin client
needs to manage IdPs (`manage-identity-providers` is included in
`manage-realm`), so the privilege side is already handled.

## Schema additions

No portal-side schema changes for Phase 1. Everything we need
already exists in Keycloak; we just call its admin API. We may
optionally cache the IdP list in our own DB to avoid hitting
Keycloak on every Settings page render, but that's a perf
optimisation, not a structural change.

For Phase 2 (certificates and keys, MFA admin assignments), we'd
want a couple of small tables, but defer until then.

## What we deliberately DON'T expose

Per the "AGO's Security tab is overwhelming" complaint, the
following are intentionally hidden from the v1 surface even
though Keycloak supports them:

* Authentication flows / executions / sub-flows. (Power users still
  use the Keycloak console.)
* Required actions (Update Password, Configure OTP, etc.).
* Mapper details (we ship sensible defaults: email -> email,
  given_name -> firstName, family_name -> lastName, groups
  attribute -> Keycloak groups).
* Browser flow conditional auth.
* Session / token timeouts (defaults are fine; ops concern).
* Realm-level themes (covered by our branding work).
* Client (relying-party) management. We have one client per portal
  app; that's a deploy-time concern.

A "Open in Keycloak admin console" deep link in the page's empty
state and at the bottom of the modal acts as the official escape
hatch for power users. Pattern: button labeled "Advanced
configuration in Keycloak" with a help-icon tooltip "Most admins
won't need this. The Keycloak console exposes the full set of
auth flows, mappers, and required actions."

## Phasing

* **Phase 1a - schema-free read API**: portal-api endpoint that
  proxies the Keycloak IdP list and the realm password / brute-
  force policy. Surface is read-only, just to prove the wiring.
* **Phase 1b - Sign-in methods card (read-only list)**: render the
  sign-in methods we read from Keycloak, with on/off toggle and
  reorder via drag (PUT back to Keycloak). No "Add" yet.
* **Phase 1c - SAML modal + metadata import**: Add SAML sign-in
  flow end-to-end. Start with metadata URL because it's the
  fastest path; manual entry can land later in the same modal.
* **Phase 1d - OIDC modal + presets**: Custom OIDC + Microsoft
  Entra + Google + GitHub presets.
* **Phase 1e - Sign-in policy card**: password policy + lockout
  toggles wired to Keycloak realm settings.
* **Phase 1f - Account lifecycle card**: email-verification toggle
  (we already have the wiring from #137).

Phase 2 (later, in priority order):

* MFA org-wide toggle + designated admins.
* SP certificate management (rotation, signed-request keypair).
* Approved CORS origins (allow-list editor).
* Anonymous-access and profile-edit policy toggles.

Phase 3 (nice-to-have):

* Access notice / terms-of-service prompt.
* Information banner.

## Open questions

1. Where in the admin nav does this live? Options: a new
   `Settings` top-level admin page that hosts Security as one of
   several tabs, or a standalone `/admin/security` route. Lean
   toward the latter for now, with a left-rail link grouping it
   with other admin surfaces.
2. Do we expose the "Sign-in page preview" as a new route or just
   open the existing `/api/auth/signin` page? The latter is
   simpler and what AGO does.
3. How do we want to handle the case where an admin removes the
   last sign-in method? Lock them out is bad. Refuse to remove the
   last one? Force-reenable built-in? Soft-warn and require
   confirmation. Lean toward refuse-with-explanation.
4. Should drag-to-reorder be desktop-only, with a kebab "Move up
   / Move down" fallback for keyboard / mobile? Yes, same pattern
   we use for layer reorder.
5. Do we ever expose mapping rules (which OIDC claim becomes which
   user attribute)? Probably yes in Phase 2, hidden behind
   "Advanced" inside each method modal. Phase 1 ships with
   hard-coded "email/given_name/family_name/groups" defaults that
   match every major IdP.

## Status

Pre-implementation. Awaits Matt's read-back to confirm:

* Phase 1 scope (Sign-in methods + Sign-in policy + Account
  lifecycle) is the right cut.
* The 3-card structure of Settings -> Security matches what he
  wants.
* The presets list (Microsoft Entra, Google, GitHub, Okta, Auth0)
  covers the IdPs he expects most users to bring.
* The "Open in Keycloak console" escape hatch is the right pattern
  for power users vs. trying to surface every flow / mapper.

No code lands until then.

# Site cutover: project site at gratisgis.org, demo at demo.gratisgis.org

Runbook for moving the public demo portal from `gratisgis.org` to
`demo.gratisgis.org` and serving the project website (`apps/site`)
at `gratisgis.org` from GitHub Pages.

Nothing here happens on merge. The site workflow builds on every
change but does not deploy until step 1 is done.

What moves and what stays:

| Host | Before | After |
| --- | --- | --- |
| `gratisgis.org` | Portal on the VPS (Caddy) | Project site on GitHub Pages |
| `www.gratisgis.org` | Caddy 301 to apex | GitHub Pages, redirects to apex |
| `demo.gratisgis.org` | Not used | Portal on the VPS (Caddy) |
| `auth.gratisgis.org` | Keycloak on the VPS | No change |
| `storage.gratisgis.org` | MinIO on the VPS | No change |

Plan for a quiet hour. Avoid 04:00 UTC: the nightly demo reset
(`gg-reset-demo.timer`) restores the Keycloak database from the golden
snapshot and would undo a half-done Keycloak change.

## Order of work

1. Turn on Pages (no traffic moves yet).
2. Add the `demo` DNS record.
3. Move the portal to `demo.gratisgis.org` (env, Caddy, Keycloak, redeploy).
4. Point the apex and `www` at GitHub Pages.
5. Search Console, then the repo references.

Doing the portal first means the old address keeps working (through a
Caddy redirect) until DNS for the apex has moved.

## 1. Turn on GitHub Pages

1. Repo **Settings > Pages**. Under **Build and deployment**, set
   **Source** to **GitHub Actions**.
2. Verify the domain for the account first, so nobody else can claim
   it on Pages: **Profile (or org) Settings > Pages > Add a domain**,
   enter `gratisgis.org`, and add the TXT record it shows
   (`_github-pages-challenge-palavido-dev.gratisgis.org`). Wait for
   **Verified**.
3. Repo **Settings > Secrets and variables > Actions > Variables**:
   add `SITE_DEPLOY` with value `true`. This opens the deploy job in
   `.github/workflows/site.yml`.
4. **Actions > Site > Run workflow** on `main`. The deploy job should
   finish green and print a `github.io` URL. The page will look broken
   there (it expects to be at a domain root). That is expected until
   the custom domain is set in step 4.

## 2. DNS for the demo

At the DNS host for `gratisgis.org`:

| Name | Type | Value |
| --- | --- | --- |
| `demo` | A | VPS IPv4 (same as the current apex A record) |
| `demo` | AAAA | VPS IPv6, only if the apex has one today |
| `www.demo` | A | VPS IPv4. Optional. See the Caddy note below. |

Wait until `dig +short demo.gratisgis.org` returns the VPS address.

## 3. Move the portal to demo.gratisgis.org

### 3a. Env file

On the VPS, back up and edit `infra/.env.prod`:

```bash
cd /opt/gratis-gis
sudo cp infra/.env.prod "infra/.env.prod.bak.$(date +%Y%m%d%H%M)"
```

| Variable | New value |
| --- | --- |
| `PORTAL_DOMAIN` | `demo.gratisgis.org` |
| `PUBLIC_URL` | `https://demo.gratisgis.org` |
| `PORTAL_BASE_URL` | Remove it if set. Compose derives it from `PORTAL_DOMAIN`. |

Leave `AUTH_DOMAIN`, `STORAGE_DOMAIN`, `KEYCLOAK_HOSTNAME` and
`KEYCLOAK_ISSUER` alone.

`PUBLIC_URL` feeds `NEXTAUTH_URL`, `NEXT_PUBLIC_PORTAL_URL` (canonical
and sitemap URLs, baked in at image build), the MinIO CORS origin and
`STORAGE_ALLOWED_ORIGINS`. So the web image has to be rebuilt, not just
restarted. `deploy.sh` does that.

### 3b. Caddy

`infra/Caddyfile` serves `{$PORTAL_DOMAIN}` and `www.{$PORTAL_DOMAIN}`.
After 3a those become `demo.gratisgis.org` and `www.demo.gratisgis.org`.

- `www.demo.gratisgis.org` has no DNS unless you added the optional
  record in step 2. Without it Caddy keeps retrying a certificate for
  that name and logs errors. Either add the record, or change the
  Caddyfile `www.{$PORTAL_DOMAIN}` block (a repo change).
- Add a temporary block so the old address redirects while DNS for
  the apex still points at the VPS. This is a real 301, so it is the
  best redirect we get. It stops mattering once step 4 propagates.

```caddyfile
gratisgis.org, www.gratisgis.org {
    redir https://demo.gratisgis.org{uri} 301
}
```

Put it in `infra/Caddyfile` on a branch, or in the server copy for the
day. Remove it after step 4 has settled (a few days). Once the apex
points at Pages, Caddy cannot renew a certificate for it, and a stale
block only produces log noise.

### 3c. Keycloak (portal-web client)

The realm import only runs when the realm is created, and `deploy.sh`
does not reconcile the `portal-web` client. Change it by hand at
`https://auth.gratisgis.org/admin/` > realm `gratis-gis` > **Clients**
> `portal-web`:

- **Valid redirect URIs**: add `https://demo.gratisgis.org/*`.
- **Valid post logout redirect URIs**: add `https://demo.gratisgis.org/*`.
- **Web origins**: add `https://demo.gratisgis.org`.

Keep the `https://gratisgis.org` entries until the rollback window has
passed. Then remove them, so a page on the Pages host can never be a
valid redirect target.

Leave `field-app` and `qgis-plugin` alone. They use native schemes and
loopback redirects, not the portal host.

### 3d. Redeploy and re-take the golden snapshot

```bash
cd /opt/gratis-gis
sudo ./infra/deploy.sh
sudo ./infra/doctor.sh
```

Then check, signed out and signed in:

- `https://demo.gratisgis.org` loads the landing page with the demo
  banner.
- Sign in as a tester account. The redirect returns to `demo.`.
- Open a map and a public dashboard. Tiles and uploads load (CORS on
  `storage.` follows `PUBLIC_URL`).
- `https://gratisgis.org/items/...` 301s to `demo.` (the 3b block).

Then re-take the golden snapshot, or the 04:00 UTC reset restores the
old Keycloak client settings:

```bash
sudo ./infra/snapshot-golden.sh
```

Run it right after a reset or a clean check, because it captures
whatever is in the portal at that moment (it purges tester-owned
items first).

## 4. Point the apex and www at GitHub Pages

1. At the DNS host, replace the apex records:

   | Name | Type | Value |
   | --- | --- | --- |
   | `@` | A | `185.199.108.153` |
   | `@` | A | `185.199.109.153` |
   | `@` | A | `185.199.110.153` |
   | `@` | A | `185.199.111.153` |
   | `@` | AAAA | `2606:50c0:8000::153` |
   | `@` | AAAA | `2606:50c0:8001::153` |
   | `@` | AAAA | `2606:50c0:8002::153` |
   | `@` | AAAA | `2606:50c0:8003::153` |
   | `www` | CNAME | `palavido-dev.github.io` |

   Remove the old apex A/AAAA records for the VPS. Leave `auth`,
   `storage` and `demo` pointing at the VPS. If there is a CAA record,
   it must allow `letsencrypt.org` (both Caddy and Pages use it).
2. Repo **Settings > Pages > Custom domain**: enter `gratisgis.org`,
   save, and wait for the DNS check to pass. GitHub then adds `www`
   as a redirect to the apex.
3. Once the certificate is issued, tick **Enforce HTTPS**.
4. Re-run **Actions > Site** on `main`, so the deploy is served at the
   custom domain.

Check:

- `https://gratisgis.org` shows the project site.
- `https://www.gratisgis.org` redirects to the apex.
- `https://gratisgis.org/items/anything` lands on the same path on
  `demo.` (see the next section).
- `https://gratisgis.org/sitemap-index.xml` and `/robots.txt` load.

## Old deep links (gratisgis.org/items/...)

GitHub Pages cannot send server redirects. The realistic option, and
what `apps/site` ships, is a script in `404.html`. Pages serves that
file for any unknown path. The script checks the first path segment
against the portal's top-level routes (`PORTAL_PATH_PREFIXES` in
`apps/site/src/lib/site.ts`: `items`, `maps`, `field`, `forms`, `help`,
`signin`, `api` and the rest) and sends the browser to the same path,
query and hash on `demo.gratisgis.org`. Anything else gets the normal
not-found page, which also links to the demo.

What this does and does not cover:

- People clicking old links in a browser: covered.
- Search engines: not covered. They see a 404 status, drop the old
  URLs over a few weeks, and do not pass ranking to `demo.`. The demo
  is sample content, so this is an acceptable loss. The demo has its
  own sitemap, so its pages get re-indexed under `demo.`.
- Programs (QGIS connections, OGC clients, the Python client, scripts)
  using `https://gratisgis.org/api/...`: not covered. They get an HTML
  404. They have to be pointed at `demo.gratisgis.org`.
- Shared map and form links in old emails: covered, the same as any
  browser link.

If real 301s matter later, the alternative is to keep the apex on the
VPS and have Caddy serve the built site plus redirect rules. That
gives up GitHub Pages hosting, which was the point of the move.

Keep `PORTAL_PATH_PREFIXES` in step with `apps/portal-web/src/app`
when a new top-level route is added.

## Mobile field app

Checked `docs/mobile-field-app.md` and `clients/android` for
`https://gratisgis.org/*`:

- There are no Android App Links and no `assetlinks.json` today. Nothing
  needs to move to Pages.
- The `field-app` Keycloak client already uses only
  `gratisgis://auth-callback`. Its old `https://gratisgis.org/*`
  redirect was removed on 2026-09-13 (see the doc), and `deploy.sh`
  keeps it that way.
- `clients/android/.../FieldApplication.kt` has
  `DEFAULT_PORTAL_URL = "https://gratisgis.org"`. It needs to become
  `https://demo.gratisgis.org`. Sideloaded builds with the old default
  will fail discovery after the cutover until the user changes the
  portal URL or installs a new build.
- If App Links are added later, `/.well-known/assetlinks.json` must be
  served by the portal host (`demo.`). If they ever need the apex,
  put the file in `apps/site/public/.well-known/`. Pages serves it,
  because the workflow deploys the built folder directly (no Jekyll).

## Search Console

1. Add a **Domain** property for `gratisgis.org` (DNS TXT record). It
   covers the apex, `www` and `demo` in one place.
2. Submit `https://gratisgis.org/sitemap-index.xml`.
3. Submit the portal's own sitemap at
   `https://demo.gratisgis.org/sitemap.xml`.
4. Do not use the Change of Address tool. It is for moving a whole
   domain, and the apex is staying.
5. Watch **Pages > Not found (404)** for a few weeks. Old portal URLs
   showing there is expected.

## Repo references to update at cutover

`git grep -n 'gratisgis\.org'` lists about 150 lines. Email addresses
(`matthew@`, security contact) do not change. `auth.` and `storage.`
do not change. The ones that point at the portal on the apex:

Change at cutover:

- `README.md`: "Try it" link and text. Left on `gratisgis.org` in this
  PR on purpose: `demo.` does not resolve until step 2, and the
  current link works until step 4.
- `infra/.env.prod.example`: `PORTAL_DOMAIN`, `PUBLIC_URL`, header
  comment.
- `infra/docker-compose.prod.yml`: the `gratisgis.org` fallbacks for
  `PORTAL_DOMAIN`, `PUBLIC_URL`, `PORTAL_BASE_URL`,
  `NEXT_PUBLIC_PORTAL_URL`, the MinIO CORS origin and
  `STORAGE_ALLOWED_ORIGINS`.
- `infra/Caddyfile`: the `www.{$PORTAL_DOMAIN}` block (step 3b) and
  header comments.
- `apps/portal-web/src/lib/portal-url.ts`: the fallback canonical
  origin. Also the `Dockerfile` comment that names it.
- `apps/portal-web/src/app/opengraph-image.tsx`: the printed host name.
- `infra/bootstrap.sh`: the "this is the public demo" warning should
  also match `demo.gratisgis.org`.
- `.github/workflows/prod-smoke.yml`: `E2E_BASE_URL` and the job name.
  Without this the daily smoke run tests the project site and fails.
- `e2e/playwright.config.ts`: the comment naming the deployed demo.
- `clients/android/.../FieldApplication.kt`: `DEFAULT_PORTAL_URL`.
- `clients/python/pyproject.toml`: the Documentation URL (the 404
  redirect covers browsers, but the link should be direct).
- `clients/python/src/gratisgis/client.py`, `apps/portal-mcp/README.md`,
  `apps/portal-web/content/help/reference/mcp-server.md`,
  `apps/portal-api/src/notifications/templates.ts`: example base URLs.
- `SECURITY.md`: "public preview at gratisgis.org". Scope line already
  covers subdomains.
- `.github/ISSUE_TEMPLATE/bug_report.md`: public test instance URL.
- Docs that say the demo is at `gratisgis.org`: `docs/sample-data.md`,
  `docs/walkthrough-water-quality-dashboard.md`, `docs/osm-toolset.md`,
  `infra/systemd/README.md`, `infra/snapshot-golden.sh` comment,
  `docs/discoverability.md` (the GitHub homepage can stay on the apex,
  which is now the project site).

Leave as is:

- `CITATION.cff` `url`: the apex is the right project URL.
- `apps/portal-api/src/public/ogc/problem-json.filter.ts` and
  `docs/ogc-api-strategy.md`: `https://gratisgis.org/errors/<slug>`
  are problem-type identifiers, not links anything fetches. Optional
  later: add an `/errors/` page to the site.
- `CHANGELOG.md`, `apps/portal-web/content/changelog/user-visible.md`,
  `docs/mobile-field-app.md`, `docs/autonomy/DIGEST.md`: history.
- `deploy/` and `CONTRIBUTING.md` mentions of `get.gratisgis.org`:
  unrelated placeholder.
- Test fixtures and specs (`*.spec.ts`, `qr-golden.json`): any host
  works there.

## Rollback

Pages and the portal move are independent, so roll back the part that
broke.

Site problem, portal fine:

1. Revert the bad commit on `main`. The workflow redeploys the
   previous build.
2. To take the site down entirely, set `SITE_DEPLOY` to `false` and
   remove the custom domain in **Settings > Pages**.

Portal back to the apex:

1. DNS: put the apex A/AAAA records back to the VPS and `www` back to
   whatever it was (CNAME or A to the VPS). Remove the custom domain
   in **Settings > Pages** so Pages stops answering for it.
2. On the VPS, restore the env backup from 3a:
   `sudo cp infra/.env.prod.bak.<stamp> infra/.env.prod`.
3. Remove the temporary Caddy redirect block from 3b.
4. `sudo ./infra/deploy.sh` (rebuilds the web image with the old
   `PUBLIC_URL`), then `sudo ./infra/doctor.sh`.
5. Keycloak needs no change, because the old entries were kept in 3c.
6. If a new golden snapshot was taken in 3d, take another one after
   the rollback so the nightly reset matches.

# GratisGIS on a home NAS

Paste one file. The stack creates its own passwords. The admin
password is printed once, on the first start, and is not written to
a file. You do not need a domain name, a git checkout, or to move
the TrueNAS website off ports 80 and 443.

This is for TrueNAS SCALE 25.10 or newer, and for Dockge. The same
file is `infra/docker-compose.nas.yml`.

Images are `ghcr.io/palavido-dev/gratis-gis/*` (linux/amd64), tag
`edge`. They exist after the publish workflow has run on `main`.

## Install

1. In TrueNAS, open **Apps**, then **Discover Apps**.
2. Open the **three dots** next to **Custom App**. Choose **Install via YAML**.
3. Name the app `gratis-gis`.
4. Copy this whole file and paste it into the box.

   https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/docker-compose.nas.yml

   Leave the file as it is when port 8080 is free. When 8080 is
   already taken (an IP camera is a common case), change one line
   near the top before you save:

```yaml
  GRATIS_HTTP_PORT: &GRATIS_HTTP_PORT "${GRATIS_HTTP_PORT:-8085}"
```

   That line is the port on the NAS. The address in the log,
   Keycloak, and the sign-in redirects follow it. Leave every
   other `8080` in the file alone. That number is the port inside
   the container.

5. Click **Save**. The first start downloads the images. Wait until
   the app is running. Then open the **bootstrap** logs. They look
   like this:

```
========== GratisGIS ==========
Open this address:  http://192.168.1.20:8080
User:               admin
Password:           (a long random password)
This log contains the admin password. Do not post it publicly.
```

Open that address from a computer on your home network. Sign in as
`admin`. Keycloak asks you to choose your own password.

The password appears in the bootstrap log only on that first start.
Copy it before you change it. A later restart does not print it
again, and it is not saved as a file on the volume. Do not post the
first-start log on a forum, in a GitHub issue, or in a screenshot.
If you already changed the password, you do not need that log.

Dockge works the same way: create a stack, paste the same file,
leave the env box empty, deploy. Then read the bootstrap logs.

## If the log asks you to set GRATIS_BASE_URL

The stack could not see a LAN address that opens from another
computer. It skips network addresses (those end in `.0`), broadcast
addresses (those end in `.255`), and Docker or TrueNAS bridge
addresses. In the YAML you pasted, set your NAS address and start
the app again:

```yaml
GRATIS_BASE_URL: http://192.168.1.20:8080
```

Use your NAS IP. Use the same port as `GRATIS_HTTP_PORT` (`8080`,
or `8085` if you changed that line). Uploads use `GRATIS_S3_PORT`
on that same IP (8900 unless you changed it).

Keep the existing volumes when Keycloak never became healthy. Delete
the app's volumes and start again when you already signed in at the
old address, or when you want new passwords. A new boot volume
prints a new password.

## Away from home (optional)

**Tailscale HTTPS is the recommended way to open the portal from a
phone or a laptop that is not on the same LAN.** In the Tailscale
admin page, turn on MagicDNS and HTTPS certificates. The NAS gets a
name like `mynas.tail1234.ts.net`. Use Tailscale Serve so that name
is HTTPS in the browser and proxies to the portal's HTTP port on
the NAS. Set this before the first start, or on an install that
already signed in at the LAN address:

```yaml
GRATIS_BASE_URL: https://mynas.tail1234.ts.net
```

Uploads go to a second port (8900 by default), which is plain HTTP
too. Add a second Serve listener for it, HTTPS on port 8900 to
`http://127.0.0.1:8900`, and set the upload address to match:

```yaml
GRATIS_S3_URL: https://mynas.tail1234.ts.net:8900
```

Without it the portal tells browsers to upload to
`https://mynas.tail1234.ts.net:8900`, where nothing answers HTTPS,
and uploads and stored images fail. The bootstrap log warns about
this.

Leave the portal itself on plain HTTP. Serve terminates TLS. Do not
turn on Funnel, and do not forward ports 8080 or 8900 on your router.
The sign-in cookie is then marked Secure, because the address you
open starts with `https://`.

Restart after you set `GRATIS_BASE_URL`. Keep the volumes. The next
start rewrites Keycloak's redirect address. You do not delete
`pgdata`, `miniodata`, or `boot`, and you do not create a new admin
password. Sign in again at the Tailscale name.

If you open a Tailscale name or `100.x` address while sign-in is
still the LAN address, the sign-in page does not send the browser
to that LAN IP. It shows the `GRATIS_BASE_URL` line for the name
you opened. Keycloak itself answers `/auth` only for the configured
host, so a login link cannot bounce you to the other address.

The default install is still `http://192.168.x.x:8080` on your LAN.
That does not need Tailscale, and it does not need a certificate.
Plain `http://100.x.x.x:8080` on the tailnet reaches the portal.
Tailscale encrypts that path. Sign-in still uses the address in
`GRATIS_BASE_URL` (the LAN address until you change it). Set
`GRATIS_BASE_URL` to `http://100.x.x.x:8080` when that is the address
you sign in from. The browser shows `http`, and the sign-in cookie
is not marked Secure. Use the HTTPS name above when the tailnet is
shared with other people.

**Cloudflare Tunnel.** Point one hostname at `http://<nas-ip>:8080`
and a second hostname at `http://<nas-ip>:8900`. Before the first
start set `GRATIS_BASE_URL` to the `https://` website name and
`GRATIS_S3_URL` to the `https://` upload name. The tunnel must pass
the original Host header or uploads fail signature checks. Tailscale
is the simpler of the two.

## A real public domain (optional)

Set `GRATIS_MODE` to `public`, `GRATIS_BASE_URL` to
`https://gis.example.org`, and `GRATIS_ACME_EMAIL` to your email.
In the Caddy service, replace the `ports` list with `"80:80"` and
`"443:443"`. Move the TrueNAS web UI off 80 and 443 first, and point
`gis`, `auth.gis`, and `storage.gis` at the NAS. That is the same
shape as the VPS install in [deployment.md](./deployment.md).

## Address search and My location

Address search calls this portal, then the public OpenStreetMap
Nominatim service when this stack has no local geocoder. The NAS
must be able to reach the internet for that. It is not GPS, and it
works on the plain HTTP address. Set `NOMINATIM_PUBLIC_FALLBACK=0`
(see Optional settings below) to keep searches off the public
service, or `NOMINATIM_URL` to use your own Nominatim.

**My location** is the browser's GPS. Browsers refuse it on
`http://192.168.x.x` and on `http://100.x`. Use the Tailscale HTTPS
name above, or `localhost`. The portal does not bypass that rule.

## Optional settings

The compose file passes these to the containers. Empty keeps the
default. In Dockge, add them to the env box, one `NAME=value` per
line. In TrueNAS, add them to the app's environment. Then restart.

- `NOTIFICATIONS_ENABLED=true` turns on email notifications. Enter
  the SMTP server on **Admin -> Notifications**.
- `PORTAL_NAME` is the name used in email.
- `NOMINATIM_URL` and `NOMINATIM_PUBLIC_FALLBACK=0` control address
  search (above).
- `GRATIS_SESSION_MAX_AGE_SECONDS` and `GRATIS_SESSION_IDLE_SECONDS`
  set the portal cookie lifetime (docs/operations/session.md).
- `RECYCLE_BIN_RETENTION_DAYS` (30), `GRATIS_ADMIN_AUDIT_RETENTION_DAYS`
  (400), `HOUSEKEEPING_STALE_ITEM_DAYS` (90) and
  `HOUSEKEEPING_STALE_USER_DAYS` (180) change retention.
- `BACKUP_RETENTION_COUNT` keeps that many backup archives.
- `TILE_CACHE_DISK_MAX_BYTES` caps the map tile cache on disk (1 GiB
  by default, in bytes). `TILE_CACHE_DISK_MAX_FILES` caps the number
  of files (100,000). This stack keeps tiles in the `tile-cache`
  volume, so maps load quickly after a restart or an update. Set it to
  `0` to keep tiles in memory only. Deleting the volume is safe; tiles
  are rebuilt as maps ask for them.
- `METRICS_TOKEN` turns on Prometheus metrics at `portal-api:4000/metrics`
  for a Prometheus on the stack's network
  (docs/operations/metrics.md).

Links in email use the address in the bootstrap log.

## What this stack does not do

- It speaks plain HTTP on your LAN. There is no certificate warning.
  That is the default, and it stays that way. Do not publish ports
  8080 or 8900 to the internet. For a phone or a laptop that is not
  on that LAN, use Tailscale HTTPS above. If you set
  `GRATIS_TLS: internal` without Tailscale's certificate, Caddy
  makes a private certificate and the browser warns until you trust
  that certificate.
- The sign-in page uses Keycloak's own theme.
- One API container and one Chromium. `GRATIS_ANALYSIS` at the top
  of the file defaults to `on`, which runs lidar and terrain
  processing and needs about 2.5 GB of RAM plus scratch disk. Set
  it to `off` on a small box. The portal then answers those requests
  with 503.
- pg_tileserv is not in this file. The portal draws its own vector
  tiles on the API. Nothing in the app calls pg_tileserv, so maps
  do not need it.
- Admin backups are written to a Docker volume (`portal-api-backups`)
  so they survive recreating the API container. An archive restores
  only on this same install. See [deployment.md](./deployment.md).
- The sign-in address is the one printed on first start, until you
  set `GRATIS_BASE_URL` and restart. That restart updates Keycloak
  in place. Keep the volumes. `GRATIS_HTTP_PORT` at the top of the
  file is how you move the web port. Change it before the first
  successful start, or set `GRATIS_BASE_URL` to the same host with
  the new port and restart.
- The Keycloak master realm and its admin API are not reachable
  from the browser.

Passwords are random for each install. They are stored on the
Docker volume named `boot`. The portal admin password is printed
once, on the first start, and then only lives in Keycloak after you
change it. Keep `boot` and the database volume when you are only
updating the stack.

If you forgot the portal password, do not delete volumes. Deleting
`pgdata` or `miniodata` erases the maps and files. Deleting `boot`
creates new secrets and the old database can no longer sign in or
decrypt stored credentials. Reset the existing user instead.

From a checkout of this repository, on the NAS host:

```bash
GG_KEYCLOAK_CONTAINER=<keycloak container name> \
  ./infra/reset-portal-password.sh admin
```

The container name is the one `docker ps` shows for Keycloak, often
`gratis-gis-keycloak-1`. The script prints a new password once. It
uses `kcadm` inside that container. It does not publish the Keycloak
master realm, and it does not delete data. Then sign in and change
the password.

A paste-only install can copy `infra/reset-portal-password.sh` from
the same GratisGIS version the stack is running and run that command
next to the Docker engine.

## Updates

Admins open **Updates** in the admin section. The page shows the
version that is running, the version that is available, and the
changelog, including any line that starts with `Breaking:`. It does
not change the install.

The first step is **Create backup**. The archive stays on the
`portal-api-backups` volume if the API container is recreated, and
the page links to the download. An archive restores only on this
install.

When the compose file itself is out of date, copy the new
`docker-compose.nas.yml` for your channel, paste it over the app
(TrueNAS Edit, or the Dockge stack), and Save. Keep
`GRATIS_HTTP_PORT` if you changed it. When only the images are
newer, Stop then Start the app in TrueNAS, or click Update in
Dockge.

`edge` is the default image channel and tracks `main`. A commit
reaches `edge` only after CI and the security checks pass on it. For the
newest stable release, set `GG_IMAGE_TAG=latest` before the first
start, or in Dockge's env box. A tag such as `v1.2.3` pins that
release.

Set `UPDATE_CHECK=off` to stop the page from calling GitHub.

## Showcase dashboards

On the items page, **Load showcase dashboards** adds the storm
events dashboard, the water-quality dashboard, and Elkins in 3D.
It keeps the items you already have. Lidar processing has to be
`on` (the default) if you later derive a new hillshade. The
buildings in Elkins in 3D already carry their heights. See
[sample-data.md](./sample-data.md).

## Updating

Paste the new file over the same app and start it again. Pasting
keeps every existing volume. Compose creates any volume the new file
adds, empty, on the next start.

Compose file revision 2 adds the `gg-staging` volume that
portal-api and portal-worker share. On revision 1, creating a data
layer from a file left the layer empty with "Source file expired
before the import started". The Updates page says the compose file
is out of date until you paste the current revision. No data moves.

Revision 3 passes the optional settings (see Optional settings
above) to the containers, uses the portal address in email links,
and leaves scheduled jobs to portal-api.

Keep the volumes when the first start never became healthy (Keycloak waiting,
Silo exiting). The saved passwords stay, and Keycloak imports the
realm on the first start that succeeds.

Keep the volumes when the Users page says Keycloak returned 403.
The next start grants the API's service account the roles that page
needs. Do not delete `pgdata`, `miniodata`, or `boot`. Leave
`quay.io/keycloak/keycloak:26.0` as the Keycloak image. If you
changed that image to `latest`, set it back to `26.0` before the
restart only when that volume has not already been migrated by a
newer Keycloak.

A changed sign-in address does not need new volumes. Keep `boot`,
`pgdata`, and `miniodata`. Delete those volumes only when you mean
to throw the portal away and start empty. That is not a password
reset. In Dockge the volumes are `boot`, `pgdata`, `miniodata`,
`caddy-data`, `portal-api-backups`, `pointcloud-scratch`, and
`gg-staging`. `portal-api-backups` holds admin backup archives, so
delete it too when you start empty. In TrueNAS, deleting the app with its volumes does the
same thing.

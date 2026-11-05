# GratisGIS on a home NAS

Paste one file. The stack creates its own passwords and prints them
in the logs. You do not need a domain name, a git checkout, or to
move the TrueNAS website off ports 80 and 443.

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

The bootstrap log contains the admin password. Keep it to yourself.
Do not post it on a forum, in a GitHub issue, or in a screenshot.

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

**Tailscale.** You already have it on the NAS. In the Tailscale
admin page, copy the NAS address that starts with `100.`. Before
the first start, set:

```yaml
GRATIS_BASE_URL: http://100.x.x.x:8080
```

Open that address from any device on your Tailnet. Do not turn on
Funnel, and do not forward ports 8080 or 8900 on your router.
Tailscale encrypts the connection. The browser still shows `http`.

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

## What this stack does not do

- It speaks plain HTTP on your LAN. There is no certificate warning.
  Do not publish ports 8080 or 8900 to the internet. If you set
  `GRATIS_TLS: internal`, Caddy makes a private certificate and the
  browser warns until you trust that certificate.
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
- The address chosen on the first successful start is kept. A later
  address, after you have signed in, means deleting the app volumes
  and starting again. `GRATIS_HTTP_PORT` at the top of the file is
  how you move the web port before that first successful start.
- The Keycloak master realm and its admin API are not reachable
  from the browser.

Passwords are random for each install. They are printed in the
bootstrap logs and stored on the Docker volume named `boot`. Copy
the portal password somewhere safe. Deleting that volume creates
new passwords and an empty database.

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

`edge` is the default image channel and tracks `main`. For the
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

Paste the new file over the same app and start it again. Keep the
volumes when the first start never became healthy (Keycloak waiting,
Silo exiting). The saved passwords stay, and Keycloak imports the
realm on the first start that succeeds.

Keep the volumes when the Users page says Keycloak returned 403.
The next start grants the API's service account the roles that page
needs. Do not delete `pgdata`, `miniodata`, or `boot`. Leave
`quay.io/keycloak/keycloak:26.0` as the Keycloak image. If you
changed that image to `latest`, set it back to `26.0` before the
restart only when that volume has not already been migrated by a
newer Keycloak.

Delete the volumes when you already signed in and the log says the
address changed, or when you want new passwords. In Dockge that is
the stack's volumes (`boot`, `pgdata`, `miniodata`, `caddy-data`).
In TrueNAS, delete the app with its volumes, then install again.

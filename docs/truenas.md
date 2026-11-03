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
4. Copy this whole file and paste it into the box. Do not edit it.

   https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/docker-compose.nas.yml

5. Click **Save**. The first start downloads the images. Wait until
   the app is running. Then open the **bootstrap** logs. They look
   like this:

```
========== GratisGIS ==========
Open this address:  http://192.168.1.20:8080
User:               admin
Password:           (a long random password)
```

Open that address from a computer on your home network. Sign in as
`admin`. Keycloak asks you to choose your own password.

Dockge works the same way: create a stack, paste the same file,
leave the env box empty, deploy. Then read the bootstrap logs.

## If the address is 127.0.0.1

The stack could not see your NAS address. In the YAML you pasted,
set this line and start the app again (delete the app's volumes
first if it already saved the wrong address):

```yaml
GRATIS_BASE_URL: http://192.168.1.20:8080
```

Use your NAS IP. Keep port **8080**. Uploads use port **8900** on
that same IP.

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
In the Caddy service, replace the `8080` port with `80:80` and
`443:443`. Move the TrueNAS web UI off 80 and 443 first, and point
`gis`, `auth.gis`, and `storage.gis` at the NAS. That is the same
shape as the VPS install in [deployment.md](./deployment.md).

## What this stack does not do

- It speaks plain HTTP on your LAN. There is no certificate warning.
  Do not publish ports 8080 or 8900 to the internet. If you set
  `GRATIS_TLS: internal`, Caddy makes a private certificate and the
  browser warns until you trust that certificate.
- The sign-in page uses Keycloak's own theme.
- One API container and one Chromium. Point-cloud processing and
  pg_tileserv are not in this file. The portal still serves its own
  vector tiles.
- The address chosen on first start is kept. A new address means
  deleting the app volumes and starting again.
- The Keycloak master realm and its admin API are not reachable
  from the browser.

Passwords are random for each install. They are printed in the
bootstrap logs and stored on the Docker volume named `boot`. Copy
the portal password somewhere safe. Deleting that volume creates
new passwords and an empty database.

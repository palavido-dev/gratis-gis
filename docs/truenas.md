# Install on TrueNAS, or on any Docker host

This is the supported way to run GratisGIS on a home server. The
same files work on TrueNAS SCALE, on Dockge, on Portainer, and on a
normal Linux computer. You do not compile the apps yourself unless
the published images are not available yet.

The public demo still uses `infra/deploy.sh` and builds on the
server. That path is unchanged. This page is for everyone else.

## Which TrueNAS option to use

TrueNAS SCALE 25.10 ("Goldeye") runs Apps with Docker Compose. These
are the realistic choices. The recommendation is the first row.

| Option | Beginner | A stack of many containers | Env file and image builds | Disk permissions | Updates | Work for us |
| --- | --- | --- | --- | --- | --- | --- |
| TrueNAS **Install via YAML**, pointing at files on a pool dataset | Official screen. You paste about ten lines, not the whole stack. | Yes. One app holds the whole stack. | The env file stays on disk. No build. Images are pulled. | Default is Docker volumes on the apps pool. You do not chmod a dataset. | Restart the app to pull. Keep the checkout and update it when the compose file changes. | One compose file and one bootstrap script. |
| Dockge | Fine if you already installed it. Same files as the row above. | Yes. It is a Compose editor. | It has an env box. Leave that box empty. Secrets stay in `infra/.env.prod`. | Same Docker daemon as TrueNAS apps. | Dockge has a pull / restart button. | None beyond the same files. Dockge is a third-party app. |
| Portainer | Heavier than Dockge. | Yes, as a stack. | Paste the same short include file. A Portainer "git stack" still needs `GRATIS_DIR` set to the real checkout path. | Same. | Redeploy the stack. | Same files. |
| A TrueNAS catalog app (click to install) | Easiest, if it existed. | The catalog wraps one app at a time. | The catalog form would have to grow every secret we add. | The wizard can set ACLs. | A second release, reviewed by the catalog, every time we ship. | Too much. Not in this repo. |
| `docker compose` in the TrueNAS shell | You live in a terminal. | Yes, if the checkout is on a pool dataset. | Full control. `deploy.sh` also hard-resets git, which is a poor fit here. | You must not use `/opt` or the boot drive. | You remember to pull and restart. The Apps screen may not show the stack. TrueNAS does not support this as the way to run Docker. | Lowest, but the appliance can replace root-disk files on upgrade. |
| Incus / LXC container, a VM, or Jailmaker | A VM means installing Linux first. | Inside a VM, the normal VPS install works. | Builds work inside the VM. | The VM disk is a zvol. Sharing a dataset with it is extra work. | Same as a VPS, inside the VM. | Jailmaker is unmaintained. TrueNAS 25.10 Containers are experimental and the docs say not to use them for something you need to keep. A VM is the escape hatch when you want `infra/install.sh` unchanged and you can spare the RAM. |

Use **Install via YAML**. Dockge is a good second choice when it is
already installed. Both consume the same checkout. Do not use
Jailmaker on 25.10. Do not put the only copy of the stack on the
boot drive.

## Before you start

You need:

- TrueNAS SCALE 25.10 or newer, with an apps pool already chosen
  (Apps has been opened at least once). 8 GB of RAM can boot the
  stack. 16 GB is more comfortable, because ZFS wants memory too.
  A few tens of GB of free disk.
- A domain name you control, with three DNS names pointing at the
  NAS. Example: `gis.example.org`, `auth.gis.example.org`,
  `storage.gis.example.org`. A dynamic-DNS hostname is fine if you
  can make three names (the extra two can be CNAMEs) and your
  router forwards ports 80 and 443 to the NAS.
- Ports 80 and 443 free on the NAS. TrueNAS itself uses them for
  its website. Move that website first (next section). The stack
  does not support other ports: the sign-in addresses have no port
  number in them.

One name is not enough. The website, the sign-in service, and file
uploads each have their own name. That is the same layout as the
public demo.

The stack does not ship with a password. The bootstrap script makes
random ones and prints them once. Postgres, Keycloak, and MinIO are
not published on the network. Only the web proxy (Caddy) listens,
on 80 and 443. The Keycloak master realm and the Keycloak admin
HTTP API stay blocked at that proxy, same as the public site.

## 1. Move the TrueNAS website off ports 80 and 443

1. Open System Settings, then General Settings.
2. Find the web interface ports (the labels are the HTTP port and
   the HTTPS port). They are 80 and 443.
3. Change HTTP to `81` and HTTPS to `8443`. Save.
4. Open `https://<nas-ip>:8443` and sign in again. Use this new
   address from now on. If you skip this, the GratisGIS proxy cannot
   start, and the error is that port 80 or 443 is already in use.

## 2. Put the code on a pool dataset

Use a dataset on your data pool, for example `/mnt/tank/gratis-gis`.
Do not use `/opt`, `/root`, or `/home`. A TrueNAS update can replace
files on the boot drive.

In the shell (System Settings, then Shell), as root:

```bash
mkdir -p /mnt/tank/gratis-gis
cd /mnt/tank/gratis-gis
```

If `git` is installed:

```bash
git clone --depth 1 https://github.com/palavido-dev/gratis-gis.git .
```

The TrueNAS shell often has no `git`. This works instead:

```bash
curl -fsSL -o /tmp/gratis-gis.tar.gz \
  https://github.com/palavido-dev/gratis-gis/archive/refs/heads/main.tar.gz
tar -xzf /tmp/gratis-gis.tar.gz --strip-components=1
```

Replace `/mnt/tank` with your pool name.

## 3. Generate secrets

```bash
cd /mnt/tank/gratis-gis
./infra/bootstrap.sh --domain gis.example.org --acme-email you@example.org --yes
```

Use your domain and a real email. The script:

- writes `infra/.env.prod` (mode 600) with long random secrets
- writes `CHROMIUM_TOKEN` and `SCRIPT_EXECUTOR_TOKEN`, which Compose
  requires even when you never print a map and never run user scripts
- checks that no secret is empty, `GENERATE`, or a known weak value
- writes the Keycloak realm file `infra/keycloak/import/realm-gratis-gis.json`
- writes `infra/truenas-include.yaml`, which is the short text you
  paste in the next step

Copy the two passwords it prints. The portal user is `admin`.
Keycloak will ask you to change the portal password on first login.

Run it again only with `--rerender` (keeps secrets, rewrites the
realm) or, on a brand-new install you are willing to throw away,
`--force`. `--force` makes a new encryption key. Old encrypted
rows cannot be read after that.

## 4. Start it from TrueNAS

1. Apps, Discover Apps.
2. Open the three-dot menu beside Custom App.
3. Choose Install via YAML.
4. Name the app `gratis-gis` (lowercase, no spaces).
5. Paste the contents of `infra/truenas-include.yaml`. It looks like
   this, with your path filled in:

```yaml
name: gratis-gis-prod
include:
  - path: /mnt/tank/gratis-gis/infra/docker-compose.nas.yml
    env_file:
      - /mnt/tank/gratis-gis/infra/.env.prod
services: {}
```

6. Save.

`services: {}` is required. TrueNAS 25.10.0 rejects an include that
has no `services` key. The real services come from the included file.

Do not paste `infra/docker-compose.prod.yml`. That file builds from
folders that exist only in a full checkout, and it is the file that
fails with `CHROMIUM_TOKEN is missing` when the env box is empty.

There is no env box on this screen. The env file path inside the
snippet is how the secrets get in. Leave them out of the YAML you
paste. The snippet does not contain passwords.

The first start downloads several images. Give it time. When the app
is running, open `https://gis.example.org`.

Certificates can take a few minutes. Caddy retries until the three
DNS names point at this NAS and ports 80 and 443 are forwarded.

## If you already use Dockge

Dockge is fine. You do not have to remove it. Do not paste the
production compose file into it, and do not type secrets into
Dockge's env box.

1. Run sections 1 to 3 above so the checkout and `infra/.env.prod`
   exist.
2. In Dockge, create a stack named `gratis-gis`.
3. Paste `infra/truenas-include.yaml` as the compose file.
4. Leave the env box empty.
5. Deploy.

Dockge stores that short file in its stacks dataset. The stack
itself still lives in the checkout. If you delete Dockge later, the
containers keep running; Dockge is only a window onto Compose.

## Any other Docker host

A Linux server or a home server with Docker Engine and the Compose
plugin:

```bash
git clone --depth 1 https://github.com/palavido-dev/gratis-gis.git /opt/gratis-gis
cd /opt/gratis-gis
./infra/bootstrap.sh --domain gis.example.org --acme-email you@example.org --yes
docker compose -f infra/docker-compose.nas.yml --env-file infra/.env.prod up -d
```

Portainer: paste `infra/truenas-include.yaml` as the stack, the same
way as Dockge. Set `GRATIS_DIR` in `infra/.env.prod` if you move the
checkout. It must be the absolute path of the repository root.

The VPS installer (`infra/install.sh` / `infra/deploy.sh`) is still
the right tool when you want the server to build images from source
and to track release tags by itself.

## When the images are not published yet

`docker-compose.nas.yml` pulls:

- `ghcr.io/palavido-dev/gratis-gis/postgres`
- `ghcr.io/palavido-dev/gratis-gis/portal-api`
- `ghcr.io/palavido-dev/gratis-gis/portal-web`
- `ghcr.io/palavido-dev/gratis-gis/pointcloud-worker`
- `ghcr.io/palavido-dev/gratis-gis/script-runner` (only if you later
  enable the `scripts` profile)

The tag in `infra/.env.prod` is `GG_IMAGE_TAG`. The default is
`edge` (built from the `main` branch). A release tag looks like
`v1.2.3`. Images are linux/amd64.

They exist only after
[`.github/workflows/publish-images.yml`](../.github/workflows/publish-images.yml)
has succeeded on `main` or on a release tag. Until then, the pull
fails with "not found". Build on the machine instead. This uses the
checkout you already have. It needs a lot of disk and RAM, and the
first build is slow.

```bash
cd /mnt/tank/gratis-gis
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod up -d --build
```

`./infra/bootstrap.sh` must have been run first, so the realm file
and `CHROMIUM_TOKEN` exist. Do not run `./infra/deploy.sh` on
TrueNAS. That script fetches git and hard-resets the checkout, and
the shell often has no git.

If the pull says "denied" or "unauthorized", the package was
published as private. A repository admin opens each package, then
Package settings, then Change visibility, then Public. That is once
per image. The workflow tries to do it and fails the job if GitHub
rejects the call.

The prebuilt web image is built with the open-source project section
turned on and the public-demo banner turned off. Sign-in follows
`PUBLIC_URL` and the auth domain at runtime. The SEO canonical URL
inside that image stays the upstream default unless you build
`portal-web` yourself with `NEXT_PUBLIC_PORTAL_URL` set.

## Disk and permissions

By default, Postgres, MinIO, and Caddy store data in named Docker
volumes on the apps pool. You do not create a dataset for them and
you do not change an owner id.

Use a dataset only when you want ZFS snapshots of the raw files.
Postgres inside the container is uid **999**, not the TrueNAS apps
user (uid **568**). An Apps-preset dataset grants group 568 and
still refuses uid 999. For a Postgres dataset:

```bash
./infra/bootstrap.sh --force \
  --domain gis.example.org --acme-email you@example.org --yes \
  --pgdata /mnt/tank/gratis-gis-pg
```

`--force` rotates every secret. On an install that already has data,
do not do that. Create the directory, `chown 999:999` it, and set
`GG_PGDATA` in the existing env file instead. Mode `700` is enough.
Do not chmod `777`.

MinIO in this stack runs as root. Prefer the named volume. If you
set `--minio-data`, that directory is owned by root and mode `700`.

The checkout directory must be readable by root (TrueNAS runs the
app as root). The realm file is mode `640` and owned by root when
bootstrap runs as root, because Keycloak's user can read the root
group. Do not share the checkout, and do not share `infra/.env.prod`,
over SMB or NFS.

## Updates

Keep `infra/.env.prod`. Back it up somewhere that is not the NAS
boot drive. `CREDENTIAL_ENCRYPTION_KEY` cannot be rebuilt. Without
it, stored credentials cannot be decrypted.

```bash
cd /mnt/tank/gratis-gis
git pull
```

Without git, download a new tarball the same way as section 2, but
do not delete `infra/.env.prod` or `infra/keycloak/import/`.

```bash
./infra/bootstrap.sh --rerender
```

That rewrites the realm file from the current template and does not
change secrets. Then restart the `gratis-gis` app in the Apps
screen. `GG_PULL_POLICY=always` makes that restart pull the image
tag. Moving from `edge` to a release tag is an edit of
`GG_IMAGE_TAG` in the env file, then the same restart.

The first boot imports the Keycloak realm. Later edits to the realm
template do not modify a realm that already exists. The VPS
`deploy.sh` script reconciles a few clients after that. The NAS
path does not run that reconcile. A new install gets the realm as
rendered. An existing install keeps its realm.

## When it fails

**`CHROMIUM_TOKEN is missing` or `required variable CHROMIUM_TOKEN`.**
The env file was empty or was never passed in. You pasted
`docker-compose.prod.yml`, or Dockge's env box was empty and the
include snippet was not used. Run `./infra/bootstrap.sh` and paste
`infra/truenas-include.yaml`. Do not invent a short token. The
script's value is already in `infra/.env.prod`.

**`SCRIPT_EXECUTOR_TOKEN is missing`.** Same cause. Compose reads
this variable even though user scripts are off. bootstrap.sh sets it.

**Port 80 or 443 is already allocated.** The TrueNAS website is
still on that port. Do section 1, then start the app again.

**Image not found.** The publish workflow has not produced that tag.
Use the build command in the previous section, or wait until `edge`
exists and restart.

**Image pull denied.** The GHCR package is still private. An admin
makes it public (see above).

**Sign-in returns 401, "JWT is missing required org claim".**
Keycloak 26 drops `org` and `org_role` on user create unless the
realm user-profile schema declares them. The realm file does not
carry that schema. Caddy blocks the Keycloak admin API, so do not
point the older patch script at the public auth name. After the
app is up, from the checkout, with the Keycloak admin password
bootstrap printed:

```bash
KC_ADMIN_PASS='the-keycloak-admin-password' \
  python3 infra/keycloak/patch-user-profile-via-docker.py
```

It talks to Keycloak on the Docker network, not through Caddy. It
is safe to run more than once.

**Postgres exits with a permission error** after you set `GG_PGDATA`.
The directory is not writable by uid 999. `chown 999:999` that
directory only. Do not chown your whole pool.

**The three DNS names do not resolve.** Caddy cannot get a
certificate. Sign-in will not work until they do. A name that exists
only in your PC's hosts file is not enough for Let's Encrypt.

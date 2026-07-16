# Host-side systemd units

Units that live on the prod host alongside the docker-compose stack.
They are NOT part of any compose service; install them at the systemd
level on the box.

## gg-docker-cleanup.timer

Runs daily at 03:30 UTC and prunes:

  - Buildx cache trimmed to ~2 GB via `--reserved-space` (preserves
    the newest layers for a fast incremental rebuild; sweeps the
    rest).
  - All dangling and unreferenced docker images.

This exists because every `docker compose build` of portal-api or
portal-web produces ~2 GB of new layers, and Docker doesn't garbage-
collect them on its own. Without this timer the host disk fills up
within a couple of weeks of active development. It came up multiple
times in 2026-04 / 2026-05 before getting wired in properly.

Note (2026-07-15): the retention was originally `--keep-storage
10GB`, but that flag was deprecated + renamed to `--reserved-space`
in Docker 29 and had stopped reclaiming, and 10 GB was too generous
for the 75 GB box, so a deploy still filled the disk. Lowered to
`--reserved-space 2GB`. If a deploy build still hits "no space left",
the cause is usually NOT build cache: check `du -shx /opt/* /var/lib/
docker/volumes/*` and `find / -xdev -type f -size +500M` for large
one-off artifacts (e.g. old DB migration dumps) that this timer
deliberately does not touch.

The compose stack uses `restart: unless-stopped`, so every legitimate
image stays referenced by a running container -- `image prune -af`
only touches leftovers. Safe to run while the stack is live.

## Install on a new host

```sh
sudo cp infra/systemd/gg-docker-cleanup.service /etc/systemd/system/
sudo cp infra/systemd/gg-docker-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gg-docker-cleanup.timer
systemctl list-timers gg-docker-cleanup.timer
```

## Run once on demand

```sh
sudo systemctl start gg-docker-cleanup.service
journalctl -u gg-docker-cleanup.service -n 50
```

## gg-reset-demo.timer (#138)

Resets the gratisgis.org public test instance to a captured golden
state every day at 04:00 UTC. Used while the portal is in public-
testing mode so testers can do anything they want during the day
and get a clean slate at the next reset.

### One-time setup

```sh
# 1. Set up the demo content the way testers should land in every
#    day: WV parcels imported, example maps + forms + dashboards
#    created, the three test users provisioned, no junk.

# 2. Capture the golden state.
sudo bash /opt/gratis-gis/infra/snapshot-golden.sh

# 3. Test the restore once, manually, so you know it works before
#    the cron starts using it.
sudo PORTAL_PUBLIC_TESTING=1 /opt/gratis-gis/infra/restore-golden.sh

# 4. Install the unit files.
sudo cp infra/systemd/gg-reset-demo.service /etc/systemd/system/
sudo cp infra/systemd/gg-reset-demo.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gg-reset-demo.timer

# 5. Confirm the timer is armed.
systemctl list-timers gg-reset-demo.timer
```

### Operations

```sh
# Live log of the most recent reset attempt.
journalctl -u gg-reset-demo.service -n 200 --no-pager
# Durable log file the script tees to itself.
sudo tail -F /var/log/gg-reset-demo.log
# Re-capture the golden state (after deliberately curating new
# demo content).
sudo bash /opt/gratis-gis/infra/snapshot-golden.sh
# Trigger an immediate reset (without waiting for 04:00 UTC).
sudo systemctl start gg-reset-demo.service
# Turn the timer off (once public testing wraps up).
sudo systemctl disable --now gg-reset-demo.timer
```

### Safety properties

- `restore-golden.sh` refuses to run unless `PORTAL_PUBLIC_TESTING`
  is truthy. The unit sets it via `Environment=`. Operators running
  by hand must pass it explicitly.
- The script aborts before any destructive step if snapshot
  artifacts under `/var/lib/gratis-gis-golden/` are missing or
  empty.
- TLS / ACME state (`caddy-data`, `caddy-config`) is never touched.
- `Restart=no`. A failed reset leaves the unit in `failed` and
  visible via `systemctl status`; next scheduled run does NOT try
  again on top of a broken stack.
- Downtime ~30 - 60 seconds. Caddy stays up, so users hit a polite
  502 page rather than connection-refused.

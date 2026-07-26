#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Routine prod-host maintenance. Reclaims disk that accumulates as a
# normal side-effect of `docker compose build` runs (the deploy
# pipeline) and tidies log scratch. Idempotent and safe to run
# after every deploy.
#
# Usage:
#   ./infra/maintenance.sh           # run everything below
#   ./infra/maintenance.sh --dry-run # report what would happen
#
# What this DOES touch:
#   - Docker build cache (the big one; every `docker compose build`
#     leaves intermediate layers behind that pile up to 50+ GB
#     within a few weeks of active deploys)
#   - Dangling Docker images (untagged images from previous builds
#     that the latest deploy superseded)
#   - /tmp/deploy-*.log (the per-deploy stdout we capture; useful
#     during a deploy, useless a day later)
#   - /var/cache/apt (apt's downloaded .deb cache; not strictly
#     prod's but tidy)
#
# What this DOES NOT touch:
#   - Postgres data (volumes are mounted, not part of the image
#     layer chain)
#   - MinIO data (same)
#   - Backup archives (those have their own retention via the
#     backup module's `retentionDays` config)
#   - Container logs (Docker's json-file driver rotates these;
#     don't fight it)
#   - Anything under /opt/gratis-gis (the repo + node_modules
#     are tiny anyway)
#
# Recommended cadence: weekly on a quiet hour, or after any deploy
# where the build cache materially grew. Cron line is in the
# README's "Operations" section.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  echo "DRY RUN: nothing will be removed"
fi

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] would run: $*"
  else
    "$@"
  fi
}

echo "=== Disk before ==="
df -h /
echo ""
echo "=== Docker disk before ==="
docker system df
echo ""

# 1. Docker build cache. The biggest fish. Each `docker compose
#    build` writes intermediate layers; left untouched they
#    routinely hit 50 GB on an actively-deploying host.
#    `prune -af`: -a all (not just dangling), -f no confirm.
echo "=== Pruning Docker build cache ==="
run docker builder prune -af

# 2. Dangling images. After a successful deploy, the previous
#    image tag is still a dangling image (untagged, but holds
#    layers). Cleaning these recovers a few GB per stale build.
echo ""
echo "=== Pruning dangling Docker images ==="
run docker image prune -f

# 3. Deploy logs in /tmp. Each `nohup ./infra/deploy.sh > /tmp/...`
#    leaves a transcript behind. They don't auto-clean; sweep them.
#    Tail stays available via `docker compose logs` for the
#    services themselves, so we're not losing forensic value.
echo ""
echo "=== Removing /tmp deploy logs ==="
if [[ $DRY_RUN -eq 1 ]]; then
  ls -la /tmp/deploy-*.log 2>/dev/null || echo "  none found"
else
  rm -f /tmp/deploy-*.log
  echo "  removed"
fi

# 4. APT package cache. Not prod's primary issue but a tidy
#    is cheap. Doesn't affect any installed package; just clears
#    the .deb files apt downloaded during the last install.
echo ""
echo "=== Cleaning APT cache ==="
run apt-get clean

# 5. journald. Keep the last 7 days of host journal. Doesn't
#    touch container logs (those are Docker's responsibility).
echo ""
echo "=== Vacuuming journald (>7 days) ==="
run journalctl --vacuum-time=7d

echo ""
echo "=== Disk after ==="
df -h /
echo ""
echo "=== Docker disk after ==="
docker system df

# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=bash
# Post-rollout checks for infra/deploy.sh. Sourced, not run. Every
# function takes the compose command as its trailing arguments, so the
# test (infra/lib-deploy.test.sh) can drive them with a fake `docker`.

# Remove containers of this compose project whose service is no longer
# in the compose file, in any profile.
#
# `docker compose up -d --remove-orphans` should already do this, but
# Docker Compose v5.3.1 on the demo host only warned about the retired
# pg_tileserv container ("Found orphan containers") and left it running
# through the 1.4.0 deploy. So the deploy checks for itself.
#
# Safe by construction:
#   - the service list comes from `compose config` with every profile
#     enabled, so a profile service that is merely off (scripts) is
#     never touched;
#   - one-off `compose run` containers are skipped;
#   - if the service list is empty (config failed), nothing is removed.
#
# Usage: gg_sweep_orphans <project> <compose command...>
gg_sweep_orphans() {
  local project="$1"
  shift
  local services
  if ! services="$("$@" --profile '*' config --services)" || [[ -z "$services" ]]; then
    echo "WARN: could not list compose services; skipping the orphan check." >&2
    return 0
  fi
  local name service oneoff removed=0
  while IFS=$'\t' read -r name service oneoff; do
    [[ -z "$name" ]] && continue
    [[ "$oneoff" == "True" ]] && continue
    if ! grep -qxF -- "$service" <<<"$services"; then
      echo "Removing retired container $name (service '$service' is no longer in the compose file)"
      docker rm -f "$name" >/dev/null
      removed=$((removed + 1))
    fi
  done < <(docker ps -a \
    --filter "label=com.docker.compose.project=${project}" \
    --format '{{.Names}}	{{.Label "com.docker.compose.service"}}	{{.Label "com.docker.compose.oneoff"}}')
  if [[ "$removed" -eq 0 ]]; then
    echo "No retired containers."
  fi
}

# Make the running Caddy read the Caddyfile that is on disk.
#
# The compose file bind-mounts the single file ./Caddyfile. A git
# checkout replaces that file with a new inode, and a single-file bind
# mount keeps pointing at the old one, so Caddy keeps serving the old
# config: after the 1.4.0 deploy the demo still capped uploads at 1 GB
# although the repo said 51GiB. `compose up` does not notice because
# the compose file itself did not change. Compare what the container
# sees with the host file and restart Caddy when they differ. A restart
# re-resolves the bind mount; `caddy reload` would not, it would read
# the same stale file.
#
# Usage: gg_sync_caddyfile <container> <host Caddyfile> <compose command...>
gg_sync_caddyfile() {
  local container="$1" host_file="$2"
  shift 2
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
    echo "Caddy is not running; nothing to sync."
    return 0
  fi
  local want have
  want="$(sha256sum "$host_file" | cut -d' ' -f1)"
  have="$(docker exec "$container" sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1)"
  if [[ "$have" == "$want" ]]; then
    echo "Caddy is serving the current Caddyfile."
    return 0
  fi
  echo "Caddy is serving an older Caddyfile; restarting it to pick up the new one."
  "$@" restart caddy
  have="$(docker exec "$container" sha256sum /etc/caddy/Caddyfile 2>/dev/null | cut -d' ' -f1)"
  if [[ "$have" != "$want" ]]; then
    echo "WARN: Caddy still sees a different Caddyfile after the restart. Check the bind mount." >&2
    return 1
  fi
  echo "Caddy now serves the current Caddyfile."
}

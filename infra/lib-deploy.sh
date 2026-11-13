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

# Make the running Keycloak serve the login theme that is on disk.
#
# The theme directories are bind-mounted, so a checkout changes the
# files Keycloak can see, but Keycloak does not serve them: it caches
# themes in memory until a restart, and it keeps a gzip copy of every
# static resource under data/tmp/kc-gzip-cache, which a restart does
# not clear. After the 1.6.0 deploy the sign-in page kept the old logo
# even after a restart, because logo.svg.gz from July was still being
# served. `compose up` does not notice either, since the compose file
# did not change.
#
# The container records a digest of the theme files it last loaded in
# data/tmp. When that differs from the host files, drop the gzip cache
# and restart Keycloak so both caches start from the current files. A
# container with no record and no gzip cache was just created and has
# read nothing stale, so it only gets the record. Restarting is a short
# sign-in outage; sessions live in the database and survive it.
#
# Usage: gg_sync_keycloak_themes <container> <host themes dir> <compose command...>
gg_sync_keycloak_themes() {
  local container="$1" themes_dir="$2"
  shift 2
  local stamp=/opt/keycloak/data/tmp/gg-theme-digest
  local cache=/opt/keycloak/data/tmp/kc-gzip-cache
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
    echo "Keycloak is not running; nothing to sync."
    return 0
  fi
  local want have
  want="$(cd "$themes_dir" && find . -type f -print0 | LC_ALL=C sort -z \
    | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1)"
  have="$(docker exec "$container" cat "$stamp" 2>/dev/null || true)"
  if [[ "$have" == "$want" ]]; then
    echo "Keycloak is serving the current login theme."
    return 0
  fi
  if [[ -z "$have" ]] && ! docker exec "$container" test -d "$cache"; then
    docker exec "$container" sh -c 'printf %s "$1" > "$2"' _ "$want" "$stamp"
    echo "Keycloak has cached no theme files yet; recorded the current theme."
    return 0
  fi
  echo "Keycloak may be serving an older login theme; clearing its cache and restarting it."
  docker exec "$container" rm -rf "$cache"
  "$@" restart keycloak
  local tries="${GG_KC_HEALTH_TRIES:-36}" status=""
  while (( tries-- > 0 )); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    sleep "${GG_KC_HEALTH_SLEEP:-5}"
  done
  if [[ "$status" != "healthy" ]]; then
    echo "WARN: Keycloak is not healthy after the restart (status: ${status:-unknown})." >&2
    return 1
  fi
  docker exec "$container" sh -c 'printf %s "$1" > "$2"' _ "$want" "$stamp"
  echo "Keycloak now serves the current login theme."
}

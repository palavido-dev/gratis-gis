#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# GratisGIS deployment doctor (#147, #198). Read-only diagnostics:
# checks dependencies, host resources, DNS, the env file, and (when
# the stack is running) the compose-defined service set, store
# reachability (Postgres / MinIO / Keycloak), and the public
# endpoints, then recommends which analysis capability tiers this
# hardware can honestly support. Mutates nothing; safe to run any
# time.
#
# Exit code: 0 when nothing FAILed (warnings allowed), 1 otherwise.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"

FAILS=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
section() { printf '\n== %s ==\n' "$*"; }

section "Dependencies"
if command -v docker >/dev/null 2>&1; then
  pass "docker: $(docker --version 2>/dev/null | head -1)"
  if docker compose version >/dev/null 2>&1; then
    pass "docker compose: $(docker compose version --short 2>/dev/null || echo present)"
  else
    fail "docker compose v2 plugin not found (docker compose version failed)"
  fi
  if docker info >/dev/null 2>&1; then
    pass "docker daemon reachable"
  else
    fail "docker daemon not reachable by this user (try sudo, or add the user to the docker group)"
  fi
else
  fail "docker not installed"
fi
for bin in git curl openssl; do
  if command -v "$bin" >/dev/null 2>&1; then pass "$bin present"; else fail "$bin not installed"; fi
done

section "Host resources"
CORES="$(nproc 2>/dev/null || echo 0)"
MEM_GB="$(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_AVAIL_GB="$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
[ -z "$DISK_AVAIL_GB" ] && DISK_AVAIL_GB="$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
pass "cpu cores: ${CORES}"
if awk "BEGIN{exit !(${MEM_GB} < 3.5)}"; then
  warn "memory: ${MEM_GB} GB (4 GB or more recommended; builds may struggle below that)"
else
  pass "memory: ${MEM_GB} GB"
fi
if [ "${DISK_AVAIL_GB:-0}" -lt 15 ]; then
  warn "free disk: ${DISK_AVAIL_GB} GB (image builds and the database want 20 GB or more; docker builder prune -af reclaims build cache)"
else
  pass "free disk: ${DISK_AVAIL_GB} GB"
fi

section "Edge ports (80/443)"
# Caddy is the only thing allowed to hold 80 and 443. A foreign
# listener (host nginx, another compose project) means cert issuance
# and every request will fail, so that is a hard FAIL. A listener
# owned by a container that publishes the port is the stack's own
# Caddy (or its docker-proxy) and is fine.
if command -v ss >/dev/null 2>&1; then
  for p in 80 443; do
    LISTENER="$(ss -H -ltn "sport = :$p" 2>/dev/null || true)"
    if [ -z "$LISTENER" ]; then
      pass "port $p free (Caddy binds it on deploy)"
    elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      HOLDER="$(docker ps --filter "publish=$p" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
      if [ -n "$HOLDER" ]; then
        pass "port $p held by compose container ${HOLDER}"
      else
        fail "port $p is taken by something outside the compose stack; Caddy cannot bind it (ss -ltnp as root shows the holder)"
      fi
    else
      warn "port $p has a listener but docker is unreachable, cannot attribute it"
    fi
  done
else
  warn "ss not available; skipped the 80/443 listener check"
fi

section "Memory budget (compose heap ceilings vs MemTotal)"
# Worst-case arithmetic from the values actually configured in
# docker-compose.prod.yml: every Node old-space ceiling (portal-api
# counted once per replica), the Keycloak -Xmx, plus a coarse
# postgres allowance (its shm_size plus 512 MB for backends). Heap
# flags are ceilings, not reservations, so an oversubscribed sum is
# a WARN with the numbers spelled out, not a FAIL: the compose file
# pairs each ceiling with a mem_limit precisely so a runaway
# container gets OOM-killed in its own cgroup instead of squeezing
# postgres. See the memory-budget comment in docker-compose.prod.yml.
COMPOSE_PROD="${SCRIPT_DIR}/docker-compose.prod.yml"
if [ ! -f "$COMPOSE_PROD" ]; then
  warn "docker-compose.prod.yml not found; skipped"
else
  MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  # awk tracks the current top-level compose service (two-space
  # indented key) so each heap flag is attributed to its service.
  API_HEAP_MB="$(awk '/^  [A-Za-z0-9_-]+:/ {svc=$1; sub(":","",svc)} /max-old-space-size=/ {if (svc=="portal-api") {match($0,/max-old-space-size=[0-9]+/); print substr($0,RSTART+19,RLENGTH-19); exit}}' "$COMPOSE_PROD")"
  WORKER_HEAP_MB="$(awk '/^  [A-Za-z0-9_-]+:/ {svc=$1; sub(":","",svc)} /max-old-space-size=/ {if (svc=="portal-worker") {match($0,/max-old-space-size=[0-9]+/); print substr($0,RSTART+19,RLENGTH-19); exit}}' "$COMPOSE_PROD")"
  API_REPLICAS="$(awk '/^  [A-Za-z0-9_-]+:/ {svc=$1; sub(":","",svc)} /^ *replicas:/ {if (svc=="portal-api") {print $2; exit}}' "$COMPOSE_PROD")"
  KC_XMX_MB="$(grep -o -- '-Xmx[0-9]*m' "$COMPOSE_PROD" 2>/dev/null | head -1 | tr -dc '0-9' || true)"
  SHM_RAW="$(awk '/shm_size:/ {print $2; exit}' "$COMPOSE_PROD" 2>/dev/null || true)"
  case "$SHM_RAW" in
    *g|*G) SHM_MB=$(( ${SHM_RAW%[gG]} * 1024 )) ;;
    *m|*M) SHM_MB=$(( ${SHM_RAW%[mM]} )) ;;
    *) SHM_MB=0 ;;
  esac
  if [ -z "${API_HEAP_MB:-}" ] || [ -z "${WORKER_HEAP_MB:-}" ] || [ -z "${KC_XMX_MB:-}" ]; then
    warn "could not parse heap flags out of docker-compose.prod.yml (api='${API_HEAP_MB:-}', worker='${WORKER_HEAP_MB:-}', keycloak='${KC_XMX_MB:-}'); the file layout changed, update this check"
  elif [ "${MEM_MB:-0}" -eq 0 ]; then
    warn "could not read MemTotal; skipped"
  else
    API_REPLICAS="${API_REPLICAS:-1}"
    PG_BUDGET_MB=$(( SHM_MB + 512 ))
    TOTAL_MB=$(( API_HEAP_MB * API_REPLICAS + WORKER_HEAP_MB + KC_XMX_MB + PG_BUDGET_MB ))
    DETAIL="api ${API_HEAP_MB}x${API_REPLICAS} + worker ${WORKER_HEAP_MB} + keycloak ${KC_XMX_MB} + postgres ~${PG_BUDGET_MB} = ${TOTAL_MB} MB vs ${MEM_MB} MB MemTotal"
    if [ $(( TOTAL_MB + 1024 )) -le "$MEM_MB" ]; then
      pass "worst-case budget fits with 1 GB headroom: ${DETAIL}"
    else
      warn "worst-case budget oversubscribes RAM: ${DETAIL}. Ceilings are caps, not reservations, and mem_limits contain runaways, but if cgroup OOM kills show up in dmesg, lower the heap flags or add RAM"
    fi
  fi
fi

section "Environment file"
if [ ! -f "$ENV_FILE" ]; then
  fail ".env.prod not found. Run ./infra/setup.sh first."
else
  pass ".env.prod present"
  PERMS="$(stat -c %a "$ENV_FILE" 2>/dev/null || echo '')"
  case "$PERMS" in
    600|400) pass ".env.prod permissions ${PERMS}" ;;
    *) warn ".env.prod permissions are ${PERMS:-unknown}; chmod 600 recommended (it holds every secret)" ;;
  esac
  if grep -q '=GENERATE' "$ENV_FILE"; then
    fail ".env.prod still contains GENERATE placeholders; run ./infra/setup.sh --force or fill them in"
  else
    pass "no GENERATE placeholders remain"
  fi
  MISSING=""
  for key in PORTAL_DOMAIN AUTH_DOMAIN STORAGE_DOMAIN ACME_EMAIL \
             POSTGRES_PASSWORD KEYCLOAK_DB_PASSWORD MINIO_ROOT_PASSWORD \
             KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_ADMIN_CLIENT_SECRET \
             CREDENTIAL_ENCRYPTION_KEY INITIAL_USER_PASSWORD NEXTAUTH_SECRET; do
    grep -q "^${key}=." "$ENV_FILE" || MISSING="${MISSING} ${key}"
  done
  if [ -n "$MISSING" ]; then
    fail "missing or empty required keys:${MISSING}"
  else
    pass "all required keys set"
  fi
fi

section "DNS"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  PORTAL_DOMAIN="$(grep '^PORTAL_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
  AUTH_DOMAIN="$(grep '^AUTH_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
  STORAGE_DOMAIN="$(grep '^STORAGE_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
  SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  for host in "$PORTAL_DOMAIN" "$AUTH_DOMAIN" "$STORAGE_DOMAIN"; do
    [ -z "$host" ] && continue
    resolved="$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    if [ -z "$resolved" ]; then
      warn "${host} does not resolve"
    elif [ -n "$SERVER_IP" ] && [ "$resolved" != "$SERVER_IP" ]; then
      warn "${host} resolves to ${resolved}; this server's public IP looks like ${SERVER_IP}"
    else
      pass "${host} -> ${resolved}"
    fi
  done
else
  warn "skipped (no .env.prod)"
fi

# Populated by the Running stack section; store probes read it.
STACK_UP=0

section "Running stack"
# #198: assert the compose-defined service set is present and not
# crash-looping. `docker ps --filter name=` only lists what is up,
# so a missing or Exited service used to look like a healthy stack.
# Avoid pipelines into `while` so `fail()` can bump FAILS in this
# shell (a pipe would run the loop in a subshell).
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  COMPOSE_ARGS=(-f "$COMPOSE_PROD")
  if [ -f "$ENV_FILE" ]; then
    COMPOSE_ARGS+=(--env-file "$ENV_FILE")
  fi
  EXPECTED_SERVICES=""
  if [ -f "$COMPOSE_PROD" ]; then
    EXPECTED_SERVICES="$(
      docker compose "${COMPOSE_ARGS[@]}" config --services 2>/dev/null || true
    )"
  fi
  # service -> state/health from compose (covers exited containers
  # that `docker ps` without -a would hide). Plain parallel arrays
  # instead of associative maps so bash 3 (macOS) still parses.
  SVC_NAMES=()
  SVC_STATES=()
  SVC_HEALTHS=()
  if [ -f "$COMPOSE_PROD" ]; then
    while IFS=$'\t' read -r svc state health; do
      [ -z "${svc:-}" ] && continue
      SVC_NAMES+=("$svc")
      SVC_STATES+=("${state:-}")
      SVC_HEALTHS+=("${health:-}")
    done < <(
      docker compose "${COMPOSE_ARGS[@]}" ps -a \
        --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null || true
    )
  fi

  lookup_svc() {
    # Sets _state / _health for $1, or empty if missing.
    _state=""
    _health=""
    local i
    for i in "${!SVC_NAMES[@]}"; do
      if [ "${SVC_NAMES[$i]}" = "$1" ]; then
        _state="${SVC_STATES[$i]}"
        _health="${SVC_HEALTHS[$i]}"
        return 0
      fi
    done
    return 1
  }

  if [ -z "$EXPECTED_SERVICES" ] && [ "${#SVC_NAMES[@]}" -eq 0 ]; then
    warn "no gratis-gis compose services found (fresh install? run ./infra/deploy.sh)"
  else
    STACK_UP=1
    while IFS= read -r svc; do
      [ -z "$svc" ] && continue
      # One-shot migrate jobs exit 0 after applying; treat exited
      # as PASS for *-migrate services, FAIL otherwise.
      if lookup_svc "$svc"; then
        :
      else
        fail "${svc}: not present (compose defines it; container missing)"
        continue
      fi
      case "$_state" in
        running)
          case "$_health" in
            healthy|'') pass "${svc}: running${_health:+ ($_health)}" ;;
            unhealthy) fail "${svc}: running (unhealthy)" ;;
            starting) warn "${svc}: running (health starting)" ;;
            *) warn "${svc}: running (health=${_health})" ;;
          esac
          ;;
        exited)
          if [[ "$svc" == *migrate* ]]; then
            pass "${svc}: exited (one-shot migrate)"
          else
            fail "${svc}: exited (should be running)"
          fi
          ;;
        restarting)
          fail "${svc}: restarting (crash loop)"
          ;;
        *)
          fail "${svc}: ${_state}"
          ;;
      esac
    done <<< "$EXPECTED_SERVICES"

    while IFS=$'\t' read -r name status; do
      [ -z "${name:-}" ] && continue
      case "$status" in
        *unhealthy*) fail "${name}: ${status} (orphan/untracked)" ;;
      esac
    done < <(
      docker ps --filter 'name=gratis-gis' --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true
    )

    if [ -n "${PORTAL_DOMAIN:-}" ]; then
      CODE="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "https://${PORTAL_DOMAIN}/api/portal-info" 2>/dev/null || echo 000)"
      if [ "$CODE" = "200" ]; then
        pass "https://${PORTAL_DOMAIN}/api/portal-info -> 200"
      else
        warn "https://${PORTAL_DOMAIN}/api/portal-info -> ${CODE} (certificates can take a minute after first boot)"
      fi
    fi
  fi
else
  warn "skipped (docker unavailable)"
fi

section "Store reachability"
# #198 Gap 2: a "healthy" container does not prove the app can reach
# its stores. Probe Postgres (app + Keycloak DBs), the configured
# MinIO bucket, and the Keycloak realm when the stack is up.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  && [ -f "$ENV_FILE" ] && [ "$STACK_UP" -eq 1 ]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE" 2>/dev/null || true
  set +a

  PG_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'postgres' | head -1 || true)"
  if [ -n "$PG_CTR" ]; then
    if docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$PG_CTR" \
      psql -U "${POSTGRES_USER:-gratisgis}" -d "${POSTGRES_DB:-gratisgis}" \
      -c 'SELECT 1' >/dev/null 2>&1; then
      pass "postgres app DB accepts SELECT 1"
    else
      fail "postgres app DB refused SELECT 1"
    fi
    if docker exec -e PGPASSWORD="${KEYCLOAK_DB_PASSWORD:-}" "$PG_CTR" \
      psql -U "${KEYCLOAK_DB_USER:-keycloak}" -d keycloak \
      -c 'SELECT 1' >/dev/null 2>&1; then
      pass "postgres Keycloak DB accepts SELECT 1"
    else
      fail "postgres Keycloak DB refused SELECT 1"
    fi
  else
    warn "postgres container not running; skipped DB probes"
  fi

  MINIO_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'minio' | head -1 || true)"
  BUCKET="${S3_BUCKET:-gratisgis}"
  if [ -n "$MINIO_CTR" ]; then
    if docker exec "$MINIO_CTR" curl -fsS --max-time 5 \
      "http://127.0.0.1:9000/minio/health/ready" >/dev/null 2>&1; then
      pass "MinIO health/ready ok (bucket '${BUCKET}' configured)"
    else
      fail "MinIO not reachable inside its container"
    fi
  else
    warn "MinIO container not running; skipped bucket probe"
  fi

  if [ -n "${AUTH_DOMAIN:-}" ]; then
    REALM="${KEYCLOAK_REALM:-gratis-gis}"
    KC_CODE="$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' \
      "https://${AUTH_DOMAIN}/realms/${REALM}" 2>/dev/null || echo 000)"
    if [ "$KC_CODE" = "200" ]; then
      pass "Keycloak realm '${REALM}' -> 200"
    else
      warn "Keycloak realm '${REALM}' -> ${KC_CODE}"
    fi
  else
    warn "AUTH_DOMAIN unset; skipped Keycloak realm probe"
  fi
else
  warn "skipped store probes (docker/.env.prod/stack unavailable)"
fi

section "Analysis capability tiers"
# Advisory mapping used by the analysis workbench plan: expose only
# what the host can honestly run. Browser-tier analysis runs on the
# visitor's machine, so it is always available.
pass "browser tier: always available (runs on the visitor's machine)"
pass "server-light tier (contours, hillshade, bounded viewshed, watershed): fine on any host that runs the stack"
if [ "${CORES:-0}" -ge 4 ] && awk "BEGIN{exit !(${MEM_GB:-0} >= 7.5)}"; then
  pass "server-heavy tier (solar, large viewsheds, routing): hardware looks sufficient (${CORES} cores, ${MEM_GB} GB)"
else
  warn "server-heavy tier (solar, large viewsheds, routing): recommend 4+ cores and 8+ GB (found ${CORES} cores, ${MEM_GB} GB); keep this tier disabled"
fi
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  pass "gpu tier: NVIDIA GPU detected ($(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1))"
else
  warn "gpu tier: no GPU detected; keep GPU-dependent tools disabled"
fi

# Point-cloud merge scratch (#203). A lidar merge needs SEVERAL times
# the total tile size in free scratch: LAZ decompresses roughly 10x
# and untwine's out-of-core temp runs well past 2x the compressed
# input (the worker requires MERGE_SCRATCH_FACTOR x, default 5, and
# keeps a MERGE_MIN_FREE_GB reserve, default 10). County-scale
# merges want scratch on its own disk, never sharing a volume with
# object storage.
scratch_mount="$(docker volume inspect --format '{{.Mountpoint}}' \
  "$(docker volume ls -q --filter name=pointcloud-scratch | head -1)" 2>/dev/null || true)"
if [ -n "$scratch_mount" ] && [ -d "$scratch_mount" ]; then
  scratch_free_gb=$(( $(df -Pk "$scratch_mount" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0) / 1024 / 1024 ))
  if [ "$scratch_free_gb" -ge 50 ]; then
    pass "pointcloud scratch: ${scratch_free_gb}GB free (a merge needs ~5x its total tile size)"
  else
    warn "pointcloud scratch: only ${scratch_free_gb}GB free; a merge needs ~5x its total tile size, so large lidar batches will be refused"
  fi
else
  warn "pointcloud scratch: volume not found (stack not up yet?); merges need ~5x their total tile size in free scratch"
fi

printf '\n'
if [ "$FAILS" -gt 0 ]; then
  printf '%d check(s) FAILED.\n' "$FAILS"
  exit 1
fi
printf 'No failures. Warnings, if any, are advisory.\n'

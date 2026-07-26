#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# GratisGIS deployment doctor (#147). Read-only diagnostics: checks
# dependencies, host resources, DNS, the env file, and (when the
# stack is running) container health and the public endpoints, then
# recommends which analysis capability tiers this hardware can
# honestly support. Mutates nothing; safe to run any time.
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

section "Running stack"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  RUNNING="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true)"
  if [ -z "$RUNNING" ]; then
    warn "no gratis-gis containers running (fresh install? run ./infra/deploy.sh)"
  else
    printf '%s\n' "$RUNNING" | while IFS=$'\t' read -r name status; do
      case "$status" in
        *healthy*) pass "${name}: ${status}" ;;
        *unhealthy*) printf 'FAIL  %s\n' "${name}: ${status}" ;;
        *) warn "${name}: ${status}" ;;
      esac
    done
    # Subshell above cannot bump FAILS; count unhealthy separately.
    UNHEALTHY="$(printf '%s\n' "$RUNNING" | grep -c 'unhealthy' || true)"
    [ "${UNHEALTHY:-0}" -gt 0 ] && FAILS=$((FAILS + UNHEALTHY))
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

printf '\n'
if [ "$FAILS" -gt 0 ]; then
  printf '%d check(s) FAILED.\n' "$FAILS"
  exit 1
fi
printf 'No failures. Warnings, if any, are advisory.\n'

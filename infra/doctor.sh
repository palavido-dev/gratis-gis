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
#
# Usage: ./infra/doctor.sh [--deep]
#   --deep  also run the expensive storage-key integrity sample
#           (dangling pointers + orphan byte estimate). Default
#           run stays fast enough to be habitual (#198).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
DEEP=0
for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=1 ;;
    -h|--help)
      printf 'Usage: %s [--deep]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s (try --help)\n' "$arg" >&2
      exit 2
      ;;
  esac
done

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
  COMPOSE_CONFIG_OK=0
  if [ -f "$COMPOSE_PROD" ]; then
    EXPECTED_SERVICES="$(
      docker compose "${COMPOSE_ARGS[@]}" config --services 2>/dev/null || true
    )"
    if [ -n "$EXPECTED_SERVICES" ]; then
      COMPOSE_CONFIG_OK=1
    else
      # Fallback when .env.prod is missing / incomplete: compose
      # config refuses to interpolate. YAML top-level keys only —
      # used when *some* containers are already up (partial stack).
      EXPECTED_SERVICES="$(
        awk '
          /^services:/ { in_svc=1; next }
          /^[a-zA-Z]/ { in_svc=0 }
          in_svc && /^  [a-z0-9_-]+:[[:space:]]*$/ {
            name=$1; sub(":", "", name); print name
          }
        ' "$COMPOSE_PROD"
      )"
      EXPECTED_SERVICES="$(
        printf '%s\n' "$EXPECTED_SERVICES" | grep -vE '^(script-runner|script-executor)$' || true
      )"
    fi
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
  RUNNING_N="$(docker ps --filter 'name=gratis-gis' -q 2>/dev/null | wc -l | tr -dc '0-9')"
  RUNNING_N="${RUNNING_N:-0}"

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

  if [ "$RUNNING_N" -eq 0 ] && [ "$COMPOSE_CONFIG_OK" -eq 0 ]; then
    # Fresh box / no .env.prod: don't FAIL every compose service.
    warn "no gratis-gis containers running (fresh install? run ./infra/deploy.sh)"
  elif [ "$COMPOSE_CONFIG_OK" -eq 0 ] && [ "$RUNNING_N" -gt 0 ]; then
    # Partial leftovers without a usable .env.prod: report what is
    # up, but do not invent FAILs for every compose service.
    warn "compose config unavailable (missing/incomplete .env.prod); checking running containers only"
    STACK_UP=1
    while IFS=$'\t' read -r name status; do
      [ -z "${name:-}" ] && continue
      # Check unhealthy before healthy: the former is a substring of
      # the latter in docker's "Up … (unhealthy)" status text.
      case "$status" in
        *unhealthy*) fail "${name}: ${status} (remediation: docker compose logs, or docker rm -f ${name})" ;;
        *\(healthy\)*) pass "${name}: ${status}" ;;
        *Restarting*|*restarting*) fail "${name}: ${status} (crash loop)" ;;
        *) warn "${name}: ${status}" ;;
      esac
    done < <(
      docker ps --filter 'name=gratis-gis' --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true
    )
  elif [ -z "$EXPECTED_SERVICES" ] && [ "${#SVC_NAMES[@]}" -eq 0 ]; then
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
        fail "${svc}: not present (compose defines it; container missing; remediation: docker compose up -d ${svc})"
        continue
      fi
      case "$_state" in
        running)
          case "$_health" in
            healthy|'') pass "${svc}: running${_health:+ ($_health)}" ;;
            unhealthy) fail "${svc}: running (unhealthy; remediation: docker compose logs ${svc})" ;;
            starting) warn "${svc}: running (health starting)" ;;
            *) warn "${svc}: running (health=${_health})" ;;
          esac
          ;;
        exited)
          if [[ "$svc" == *migrate* ]]; then
            pass "${svc}: exited (one-shot migrate)"
          else
            fail "${svc}: exited (should be running; remediation: docker compose up -d ${svc})"
          fi
          ;;
        restarting)
          fail "${svc}: restarting (crash loop; remediation: docker compose logs ${svc})"
          ;;
        *)
          fail "${svc}: ${_state}"
          ;;
      esac
    done <<< "$EXPECTED_SERVICES"

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
    DISC_URL="https://${AUTH_DOMAIN}/realms/${REALM}/.well-known/openid-configuration"
    DISC_BODY="$(curl -fsS --max-time 10 "$DISC_URL" 2>/dev/null || true)"
    if [ -n "$DISC_BODY" ]; then
      pass "Keycloak OIDC discovery for realm '${REALM}' ok"
      JWKS_URI="$(printf '%s' "$DISC_BODY" | sed -n 's/.*"jwks_uri"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      if [ -n "$JWKS_URI" ] && curl -fsS --max-time 10 "$JWKS_URI" >/dev/null 2>&1; then
        pass "Keycloak JWKS fetchable"
      else
        fail "Keycloak JWKS unreachable (remediation: check keycloak logs and https://${AUTH_DOMAIN}/; #195-class identity decay)"
      fi
    else
      fail "Keycloak OIDC discovery failed for realm '${REALM}' (remediation: confirm keycloak is healthy and AUTH_DOMAIN DNS/certs are valid)"
    fi
  else
    warn "AUTH_DOMAIN unset; skipped Keycloak realm probe"
  fi
else
  warn "skipped store probes (docker/.env.prod/stack unavailable)"
fi

section "Schema migrations"
# #198 Gap 4: surface prisma migrate status so a half-applied
# migration cannot hide behind a "healthy" API container.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [ "$STACK_UP" -eq 1 ]; then
  API_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'portal-api' | grep -v worker | head -1 || true)"
  if [ -n "$API_CTR" ]; then
    MIG_OUT="$(docker exec "$API_CTR" \
      /app/node_modules/.bin/prisma migrate status \
      --schema=/app/prisma/schema.prisma 2>&1 || true)"
    if printf '%s' "$MIG_OUT" | grep -qiE 'Database schema is up to date|No pending migrations'; then
      pass "prisma migrate status: up to date"
    elif printf '%s' "$MIG_OUT" | grep -qiE 'pending|Following migration|have not yet been applied'; then
      fail "prisma migrate status: pending migrations (remediation: docker compose run --rm portal-migrate, or prisma migrate deploy)"
    elif printf '%s' "$MIG_OUT" | grep -qiE 'failed|P3009|P3018'; then
      fail "prisma migrate status: failed migration (remediation: inspect _prisma_migrations; may need migrate resolve --applied)"
    else
      warn "prisma migrate status: could not parse output (container may lack the CLI)"
    fi
  else
    warn "portal-api not running; skipped migrate status"
  fi
else
  warn "skipped migrate status (stack down)"
fi

section "Identity realm"
# #198 Gap 5: expected clients present; users missing org attribute.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 \
  && [ -f "$ENV_FILE" ] && [ "$STACK_UP" -eq 1 ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE" 2>/dev/null || true
  set +a
  REALM="${KEYCLOAK_REALM:-gratis-gis}"
  KC_INTERNAL="http://keycloak:8080"
  # Token via the admin-cli against the master realm, from a container
  # on gratis-net (portal-api). Falls back to WARN if creds missing.
  API_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'portal-api' | grep -v worker | head -1 || true)"
  if [ -n "$API_CTR" ] && [ -n "${KEYCLOAK_ADMIN:-}" ] && [ -n "${KEYCLOAK_ADMIN_PASSWORD:-}" ]; then
    TOKEN="$(docker exec "$API_CTR" curl -fsS --max-time 10 -X POST \
      "${KC_INTERNAL}/realms/master/protocol/openid-connect/token" \
      -d "client_id=admin-cli" \
      -d "username=${KEYCLOAK_ADMIN}" \
      -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
      -d "grant_type=password" 2>/dev/null \
      | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
    if [ -z "$TOKEN" ]; then
      warn "could not obtain Keycloak admin token; skipped client/org checks"
    else
      for client in portal-web qgis-plugin; do
        FOUND="$(docker exec "$API_CTR" curl -fsS --max-time 10 \
          -H "Authorization: Bearer ${TOKEN}" \
          "${KC_INTERNAL}/admin/realms/${REALM}/clients?clientId=${client}&max=1" 2>/dev/null || true)"
        if printf '%s' "$FOUND" | grep -q "\"clientId\"[[:space:]]*:[[:space:]]*\"${client}\""; then
          pass "Keycloak client '${client}' present"
        else
          fail "Keycloak client '${client}' missing in realm '${REALM}' (remediation: re-import realm JSON under infra/keycloak/import)"
        fi
      done
      # Users missing the org attribute: page once (max 200). Any hit
      # is a FAIL with the count — the known footgun that 401s everywhere.
      USERS_JSON="$(docker exec "$API_CTR" curl -fsS --max-time 15 \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_INTERNAL}/admin/realms/${REALM}/users?max=200" 2>/dev/null || true)"
      if [ -n "$USERS_JSON" ]; then
        MISSING_ORG="$(printf '%s' "$USERS_JSON" | docker exec -i "$API_CTR" node -e '
          let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
            try {
              const users=JSON.parse(s);
              const miss=users.filter(u=>{
                const attrs=(u&&u.attributes)||{};
                const org=attrs.org||attrs.organization||[];
                return !Array.isArray(org) || org.length===0 || !String(org[0]||"").trim();
              });
              process.stdout.write(String(miss.length));
            } catch { process.stdout.write("?"); }
          });
        ' 2>/dev/null || echo '?')"
        if [ "$MISSING_ORG" = "0" ]; then
          pass "no sampled Keycloak users missing org attribute"
        elif [ "$MISSING_ORG" = "?" ]; then
          warn "could not parse Keycloak users for org attribute"
        else
          fail "${MISSING_ORG} Keycloak user(s) missing org attribute (remediation: set user attribute org=<orgId>; without it every API call 401s)"
        fi
      else
        warn "Keycloak user list empty or unreachable"
      fi
    fi
  else
    warn "skipped identity checks (portal-api or KEYCLOAK_ADMIN* unavailable)"
  fi
else
  warn "skipped identity checks (stack down)"
fi

section "Recovery readiness"
# #198 Gap 6: backups exist, are fresh, and the backups volume has room.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && [ "$STACK_UP" -eq 1 ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE" 2>/dev/null || true
  set +a
  RETAIN="${BACKUP_RETENTION_COUNT:-7}"
  BACKUP_VOL="$(docker volume ls -q --filter name=portal-api-backups | head -1 || true)"
  if [ -n "$BACKUP_VOL" ]; then
    BACKUP_MOUNT="$(docker volume inspect --format '{{.Mountpoint}}' "$BACKUP_VOL" 2>/dev/null || true)"
    if [ -n "$BACKUP_MOUNT" ] && [ -d "$BACKUP_MOUNT" ]; then
      FREE_GB=$(( $(df -Pk "$BACKUP_MOUNT" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0) / 1024 / 1024 ))
      if [ "$FREE_GB" -ge 5 ]; then
        pass "backups volume free space: ${FREE_GB} GB"
      else
        fail "backups volume only ${FREE_GB} GB free (remediation: prune old archives or enlarge the volume; this volume has filled the disk before)"
      fi
      # Newest archive age: look for .tar* / .ggbackup / directories.
      NEWEST="$(find "$BACKUP_MOUNT" -type f \( -name '*.tar*' -o -name '*.ggbackup' -o -name '*.zip' \) 2>/dev/null \
        | xargs -r ls -t 2>/dev/null | head -1 || true)"
      COUNT="$(find "$BACKUP_MOUNT" -type f \( -name '*.tar*' -o -name '*.ggbackup' -o -name '*.zip' \) 2>/dev/null | wc -l | tr -dc '0-9')"
      if [ -z "$NEWEST" ]; then
        fail "no backup archives on the backups volume (remediation: trigger a backup from admin, or check BACKUP_* schedule)"
      else
        AGE_SEC=$(( $(date +%s) - $(stat -c %Y "$NEWEST" 2>/dev/null || echo 0) ))
        AGE_H=$(( AGE_SEC / 3600 ))
        pass "newest backup: $(basename "$NEWEST") (${AGE_H}h old); ${COUNT} archive(s) (retention ${RETAIN})"
        if [ "$AGE_H" -gt 48 ]; then
          fail "newest backup is ${AGE_H}h old (remediation: confirm backup cron/schedule; stale backups fail recovery)"
        fi
        if [ "${COUNT:-0}" -gt $(( RETAIN * 3 )) ]; then
          warn "archive count ${COUNT} is far above retention ${RETAIN}; check retention sweep"
        fi
      fi
    else
      warn "backups volume mountpoint unreadable"
    fi
  else
    warn "portal-api-backups volume not found (stack never backed up?)"
  fi
  warn "off-host copy of .env.prod: doctor cannot verify; losing that file is unrecoverable (credentials to reach Postgres live only there)"
else
  warn "skipped recovery checks (stack down)"
fi

section "Storage key integrity"
# #198 Gap 3: Postgres pointers vs MinIO bytes. Default skipped;
# --deep runs a bounded sample via portal-api's AWS SDK (private
# prefixes are not anonymously readable).
if [ "$DEEP" -eq 1 ] && command -v docker >/dev/null 2>&1 \
  && docker info >/dev/null 2>&1 && [ "$STACK_UP" -eq 1 ] && [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE" 2>/dev/null || true
  set +a
  PG_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'postgres' | head -1 || true)"
  API_CTR="$(docker ps --filter 'name=gratis-gis' --format '{{.Names}}' 2>/dev/null \
    | grep -E 'portal-api' | grep -v worker | head -1 || true)"
  SAMPLE_N=25
  if [ -n "$PG_CTR" ] && [ -n "$API_CTR" ]; then
    KEYS="$(docker exec -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$PG_CTR" \
      psql -U "${POSTGRES_USER:-gratisgis}" -d "${POSTGRES_DB:-gratisgis}" -At -c "
        (SELECT storage_key FROM feature_attachment ORDER BY created_at DESC LIMIT ${SAMPLE_N})
        UNION ALL
        (SELECT storage_key FROM map_icon_upload ORDER BY created_at DESC LIMIT ${SAMPLE_N})
        UNION ALL
        (SELECT data_json->>'storageKey' FROM item
          WHERE deleted_at IS NULL
            AND type IN ('file','tile_layer','point_cloud')
            AND COALESCE(data_json->>'storageKey','') <> ''
          ORDER BY updated_at DESC LIMIT ${SAMPLE_N});
      " 2>/dev/null || true)"
    HEAD_SCRIPT="$(mktemp --suffix=.mjs)"
    cat >"$HEAD_SCRIPT" <<'NODE'
import { createInterface } from 'node:readline';
import { stdin } from 'node:process';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
const bucket = process.env.S3_BUCKET || 'gratisgis';
const client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || process.env.MINIO_ROOT_USER || '',
    secretAccessKey: process.env.S3_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || '',
  },
});
let checked = 0;
const dangling = [];
const rl = createInterface({ input: stdin });
for await (const line of rl) {
  const key = line.trim();
  if (!key) continue;
  checked += 1;
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    dangling.push(key);
  }
}
process.stdout.write(JSON.stringify({ checked, dangling }));
NODE
    docker cp "$HEAD_SCRIPT" "${API_CTR}:/tmp/gg-doctor-head.mjs" >/dev/null 2>&1 || true
    RESULT="$(printf '%s\n' "$KEYS" | docker exec -i "$API_CTR" \
      node /tmp/gg-doctor-head.mjs 2>/dev/null || echo '{"checked":0,"dangling":[]}')"
    docker exec "$API_CTR" rm -f /tmp/gg-doctor-head.mjs >/dev/null 2>&1 || true
    rm -f "$HEAD_SCRIPT"
    CHECKED="$(printf '%s' "$RESULT" | sed -n 's/.*"checked":\([0-9]*\).*/\1/p')"
    CHECKED="${CHECKED:-0}"
    if printf '%s' "$RESULT" | grep -q '"dangling":\[\]'; then
      DANGLING_N=0
    else
      DANGLING_N="$(printf '%s' "$RESULT" | grep -oE '"(item-|feature-attachment/)[^"]+"' | wc -l | tr -dc '0-9')"
      DANGLING_N="${DANGLING_N:-0}"
    fi
    if [ "$CHECKED" -eq 0 ]; then
      warn "storage integrity: no keys sampled (empty portal or query failed)"
    elif [ "$DANGLING_N" -eq 0 ]; then
      pass "storage integrity sample: ${CHECKED} key(s) present in MinIO"
    else
      fail "storage integrity sample: ${DANGLING_N} dangling key(s) of ${CHECKED} checked (remediation: restore objects or clear DB pointers; admin housekeeping orphans)"
      printf '%s' "$RESULT" | grep -oE '"(item-|feature-attachment/)[^"]+"' | head -5 \
        | sed 's/^"\(.*\)"$/FAIL  dangling: \1/' || true
    fi
  else
    warn "storage integrity: postgres/portal-api unavailable"
  fi
elif [ "$DEEP" -eq 1 ]; then
  warn "storage integrity: skipped (stack down)"
else
  pass "storage integrity: skipped (pass --deep for a bounded pointer/object sample)"
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

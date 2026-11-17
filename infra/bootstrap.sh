#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Create infra/.env.prod with random secrets, check the required
# variables, and render the Keycloak realm import.
#
# One command, from a checkout of this repository (git clone or a
# GitHub tarball). Works on a VPS, a NAS, or a laptop. It does not
# start containers and it does not install Docker.
#
#   ./infra/bootstrap.sh
#   ./infra/bootstrap.sh --domain gis.example.org --acme-email you@example.org --yes
#   ./infra/bootstrap.sh --force          # replace an existing env file
#   ./infra/bootstrap.sh --rerender       # keep secrets, rewrite the realm
#
# --yes skips the questions and needs --domain and --acme-email.
# Reads questions from /dev/tty so it still works under `curl | bash`.
#
# Secrets are generated. Nothing in the file is a default password.
# CHROMIUM_TOKEN and SCRIPT_EXECUTOR_TOKEN are always set: Compose
# reads them even when you never print and never enable user scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
REALM_TEMPLATE="${SCRIPT_DIR}/keycloak/realm-gratis-gis.prod.json.tmpl"
REALM_OUT="${SCRIPT_DIR}/keycloak/import/realm-gratis-gis.json"
DOMAIN=""
AUTH_DOMAIN_IN=""
STORAGE_DOMAIN_IN=""
ACME_EMAIL_IN=""
ORG_NAME="GratisGIS"
ASSUME_YES=0
FORCE=0
RERENDER=0
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --auth-domain) AUTH_DOMAIN_IN="$2"; shift 2 ;;
    --storage-domain) STORAGE_DOMAIN_IN="$2"; shift 2 ;;
    --acme-email) ACME_EMAIL_IN="$2"; shift 2 ;;
    --org-name) ORG_NAME="$2"; shift 2 ;;
    # These used to be accepted and then read by nothing: Postgres and
    # MinIO always use the pgdata and miniodata named volumes, and the
    # VPS stack builds its images from source. Refuse rather than let
    # someone snapshot an empty host directory as their backup.
    --pgdata|--minio-data)
      echo "$1 is not supported. Postgres and MinIO keep their data in the pgdata and miniodata Docker volumes. Back up with Admin -> Backup or infra/recovery (docs/deployment.md)." >&2
      exit 1
      ;;
    --image-tag)
      echo "--image-tag is not supported. The VPS stack builds images from the checked-out release; the NAS stack reads GG_IMAGE_TAG from its own compose file." >&2
      exit 1
      ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --realm-out) REALM_OUT="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --rerender) RERENDER=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | tail -n +3 | head -22
      exit 0
      ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

say()  { [ "$QUIET" = "1" ] || printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'ERROR %s\n' "$*" >&2; exit 1; }

if [ "$RERENDER" = "1" ] && [ "$FORCE" = "1" ]; then
  die "--rerender keeps the existing secrets. It cannot be combined with --force."
fi

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets. Install it and re-run."
command -v python3 >/dev/null 2>&1 || die "python3 is required to render the Keycloak realm. Install it and re-run."

# shellcheck source=infra/lib-env.sh
. "${SCRIPT_DIR}/lib-env.sh"

render_realm() {
  export AUTH_URL="https://${AUTH_DOMAIN}"
  gg_render_realm_import "$REALM_TEMPLATE" "$REALM_OUT"
  say "Wrote ${REALM_OUT}"
}

if [ "$RERENDER" = "1" ]; then
  [ -f "$ENV_FILE" ] || die "No env file at ${ENV_FILE}. Run without --rerender first."
  gg_load_env_file "$ENV_FILE"
  gg_require_prod_env
  render_realm
  say "Secrets were not changed."
  exit 0
fi

if [ -f "$ENV_FILE" ] && [ "$FORCE" != "1" ]; then
  die "Env file already exists at ${ENV_FILE}. Re-run with --force to replace it (the old file is backed up), or --rerender to keep the secrets and only rewrite the realm."
fi

ask() {
  local prompt="$1" default="${2-}" answer=""
  if [ "$ASSUME_YES" = "1" ] && [ -n "$default" ]; then
    printf '%s' "$default"
    return
  fi
  if [ "$ASSUME_YES" = "1" ]; then
    printf '%s' "$default"
    return
  fi
  if [ -r /dev/tty ]; then
    if [ -n "$default" ]; then
      read -r -p "$prompt [$default]: " answer < /dev/tty || true
    else
      read -r -p "$prompt: " answer < /dev/tty || true
    fi
  fi
  if [ -z "$answer" ]; then answer="$default"; fi
  printf '%s' "$answer"
}

say ""
say "GratisGIS setup"
say "==============="
say "This writes an env file with generated secrets, checks that the"
say "required variables are set, and renders the Keycloak realm."
say "Secrets are printed once at the end. Save that output."
say ""

while [ -z "$DOMAIN" ]; do
  if [ "$ASSUME_YES" = "1" ]; then
    die "--yes needs --domain, for example --domain gis.example.org"
  fi
  DOMAIN="$(ask 'What domain will the portal live at (e.g. gis.example.org)')"
  case "$DOMAIN" in
    *.*) : ;;
    *) say "That does not look like a domain."; DOMAIN="" ;;
  esac
done
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%/}"
case "$DOMAIN" in
  *" "*|*"/"*) die "The domain must be a hostname, with no spaces and no slash." ;;
esac
if [ "$DOMAIN" = "gratisgis.org" ] || [ "$DOMAIN" = "www.gratisgis.org" ] \
  || [ "$DOMAIN" = "demo.gratisgis.org" ] || [ "$DOMAIN" = "www.demo.gratisgis.org" ]; then
  warn "${DOMAIN} is the public demo. Use a domain name you control."
fi

AUTH_DOMAIN="${AUTH_DOMAIN_IN:-$(ask 'Auth (Keycloak) domain' "auth.${DOMAIN}")}"
STORAGE_DOMAIN="${STORAGE_DOMAIN_IN:-$(ask 'Storage (uploads) domain' "storage.${DOMAIN}")}"
AUTH_DOMAIN="${AUTH_DOMAIN#http://}"; AUTH_DOMAIN="${AUTH_DOMAIN#https://}"; AUTH_DOMAIN="${AUTH_DOMAIN%/}"
STORAGE_DOMAIN="${STORAGE_DOMAIN#http://}"; STORAGE_DOMAIN="${STORAGE_DOMAIN#https://}"; STORAGE_DOMAIN="${STORAGE_DOMAIN%/}"

ACME_EMAIL="$ACME_EMAIL_IN"
while [ -z "$ACME_EMAIL" ]; do
  if [ "$ASSUME_YES" = "1" ]; then
    die "--yes needs --acme-email, for example --acme-email you@example.org"
  fi
  ACME_EMAIL="$(ask "Email for Let's Encrypt certificate notices")"
  case "$ACME_EMAIL" in
    *@*.*) : ;;
    *) say "That does not look like an email address."; ACME_EMAIL="" ;;
  esac
done

if [ "$ASSUME_YES" != "1" ]; then
  ORG_NAME="$(ask 'Organization name shown in the portal' "$ORG_NAME")"
fi

# head -c closes the pipe early and openssl dies with SIGPIPE. Under
# pipefail that would abort the script, so the openssl status is
# ignored. `+`, `/`, and `=` are stripped so a secret cannot break
# the unquoted env file or the realm JSON.
gen() { openssl rand -base64 48 | tr -d '\n/+=' | head -c 32 || true; }
gen_typeable() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16 || true; }

POSTGRES_PASSWORD="$(gen)"
KEYCLOAK_DB_PASSWORD="$(gen)"
MINIO_ROOT_PASSWORD="$(gen)"
KEYCLOAK_ADMIN_PASSWORD="$(gen)"
KEYCLOAK_ADMIN_CLIENT_SECRET="$(gen)"
NEXTAUTH_SECRET="$(gen)"
CHROMIUM_TOKEN="$(gen)"
SCRIPT_EXECUTOR_TOKEN="$(gen)"
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
INITIAL_USER_PASSWORD="$(gen_typeable)"

if [ -z "$POSTGRES_PASSWORD" ] || [ -z "$INITIAL_USER_PASSWORD" ] || [ -z "$CREDENTIAL_ENCRYPTION_KEY" ]; then
  die "openssl did not produce a secret. Check that openssl works and re-run."
fi

if [[ "$ORG_NAME" == *$'\n'* || "$ORG_NAME" == *'#'* || "$ORG_NAME" == *\\* || "$ORG_NAME" == *'"'* || "$ORG_NAME" == *\'* || "$ORG_NAME" == *'`'* || "$ORG_NAME" == *'$'* ]]; then
  die "Organization name cannot contain a newline, hash, quote, backtick, or dollar sign."
fi

if [ "$QUIET" != "1" ]; then
  say ""
  say "Checking DNS (warnings only; Caddy retries until the names exist)..."
  SERVER_IP=""
  if command -v curl >/dev/null 2>&1; then
    SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  fi
  for host in "$DOMAIN" "$AUTH_DOMAIN" "$STORAGE_DOMAIN"; do
    resolved=""
    if command -v getent >/dev/null 2>&1; then
      resolved="$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    fi
    if [ -z "$resolved" ]; then
      warn "${host} does not resolve yet. Add an A record pointing at this server."
    elif [ -n "$SERVER_IP" ] && [ "$resolved" != "$SERVER_IP" ]; then
      warn "${host} resolves to ${resolved}, but this server's public IP looks like ${SERVER_IP}."
    else
      say "  ok  ${host} -> ${resolved:-?}"
    fi
  done
fi

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  warn "Existing env file backed up alongside it."
fi

umask 077
cat > "$ENV_FILE" <<EOF
# Generated by infra/bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Every secret the stack uses is in this file. It is not committed.
# Mode 600. Do not put this file on a shared folder.
# Do not run bootstrap.sh --force on a server that already has data:
# a new CREDENTIAL_ENCRYPTION_KEY makes old encrypted rows unreadable.

# --- Public hostnames ---
PORTAL_DOMAIN=${DOMAIN}
AUTH_DOMAIN=${AUTH_DOMAIN}
STORAGE_DOMAIN=${STORAGE_DOMAIN}
PUBLIC_URL=https://${DOMAIN}

# --- Let's Encrypt ---
ACME_EMAIL=${ACME_EMAIL}

# --- Postgres (app DB) ---
POSTGRES_DB=gratisgis
POSTGRES_USER=gratisgis
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
KEYCLOAK_DB_PASSWORD=${KEYCLOAK_DB_PASSWORD}

# --- MinIO (object storage) ---
MINIO_ROOT_USER=gratisgis
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
S3_BUCKET=gratisgis

# --- Keycloak ---
KEYCLOAK_REALM=gratis-gis
KEYCLOAK_HOSTNAME=${AUTH_DOMAIN}
KEYCLOAK_ISSUER=https://${AUTH_DOMAIN}/realms/gratis-gis
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
KEYCLOAK_CLIENT_ID=portal-web
KEYCLOAK_CLIENT_SECRET=
KEYCLOAK_ADMIN_CLIENT_ID=portal-api-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET}

# --- Credential encryption ---
# 32 bytes, base64. Treat as permanent.
CREDENTIAL_ENCRYPTION_KEY=${CREDENTIAL_ENCRYPTION_KEY}

# Initial portal admin password (username: admin). Keycloak asks
# for a new password on first login.
INITIAL_USER_PASSWORD=${INITIAL_USER_PASSWORD}
DEFAULT_ORG_SLUG=gratis-gis

# --- NextAuth ---
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}

# Print sidecars. Required even if you never print. An empty Dockge
# or TrueNAS env box fails with "CHROMIUM_TOKEN is missing".
CHROMIUM_TOKEN=${CHROMIUM_TOKEN}

# User-script profile. Compose interpolates this even when the
# profile is off, so it has to be set. It is not a published password.
SCRIPT_EXECUTOR_TOKEN=${SCRIPT_EXECUTOR_TOKEN}

# --- Organization branding ---
# Name of the first organization, set when the admin first signs in.
# Change it later on Admin -> Branding.
DEFAULT_ORG_NAME=${ORG_NAME}

# portal-api containers. One fits a 4 GB box; the compose default
# without this line is 2, which is what the public demo runs.
GG_API_REPLICAS=1
EOF
# No GG_VERSION here: deploy.sh stamps it from git on every deploy,
# and a value written at setup time overrode that stamp for good.

chmod 600 "$ENV_FILE"

# Load what we just wrote so the checks see the same bytes Compose
# will see, including quote stripping.
gg_load_env_file "$ENV_FILE"
gg_require_prod_env
render_realm

say ""
say "Wrote ${ENV_FILE} (mode 600)."
say ""
if [ "$QUIET" != "1" ]; then
  say "Save these initial credentials somewhere safe:"
  say "  Portal sign-in:      https://${DOMAIN}  ->  admin / ${INITIAL_USER_PASSWORD}"
  say "                       (you will be asked to set a new password on first login)"
  say "  Keycloak admin:      admin / ${KEYCLOAK_ADMIN_PASSWORD} (master realm)"
  say "                       Not reachable from the internet: Caddy blocks /admin and the"
  say "                       master realm. Use kcadm.sh inside the container:"
  say "                       docker exec -it gratis-gis-prod-keycloak /opt/keycloak/bin/kcadm.sh"
  say ""
fi
say "Next, for a VPS:"
say "  ./infra/deploy.sh"
say "For a NAS, do not use this script. Paste infra/docker-compose.nas.yml."
say "Guide: docs/truenas.md"

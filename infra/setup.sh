#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Guided first-run setup for a self-hosted GratisGIS (#147).
#
# Produces infra/.env.prod from infra/.env.prod.example by asking the
# operator only what the system cannot infer (domain, ACME email, org
# name) and generating every secret automatically. Safe to run before
# DNS exists: missing records produce a warning, not a failure, since
# Caddy retries certificate issuance until records resolve.
#
# Usage:
#   ./infra/setup.sh                       # interactive
#   ./infra/setup.sh --domain gis.example.org --acme-email you@example.org
#   ./infra/setup.sh ... --yes             # accept derived defaults, no prompts
#   ./infra/setup.sh --force               # overwrite an existing .env.prod
#
# Reads prompts from /dev/tty so it stays interactive when invoked by
# the piped installer (curl ... | bash), where stdin is the script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"

DOMAIN=""
AUTH_DOMAIN_IN=""
STORAGE_DOMAIN_IN=""
ACME_EMAIL_IN=""
ORG_NAME="GratisGIS"
ASSUME_YES=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --auth-domain) AUTH_DOMAIN_IN="$2"; shift 2 ;;
    --storage-domain) STORAGE_DOMAIN_IN="$2"; shift 2 ;;
    --acme-email) ACME_EMAIL_IN="$2"; shift 2 ;;
    --org-name) ORG_NAME="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -18
      exit 0
      ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
die()  { printf 'ERROR %s\n' "$*" >&2; exit 1; }

# Prompt helper that works under `curl | bash`: stdin is the script
# there, so interactive reads must come from the terminal itself.
ask() {
  local prompt="$1" default="${2-}" answer=""
  if [ "$ASSUME_YES" = "1" ] && [ -n "$default" ]; then
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

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets. Install it and re-run."

if [ -f "$ENV_FILE" ] && [ "$FORCE" != "1" ]; then
  die ".env.prod already exists at ${ENV_FILE}. Re-run with --force to overwrite it (the old file will be backed up)."
fi

say ""
say "GratisGIS setup"
say "==============="
say "This writes infra/.env.prod: the domains, secrets, and initial"
say "credentials the stack needs. Secrets are generated for you and"
say "printed once at the end; keep that output somewhere safe."
say ""

# --- Domains -----------------------------------------------------
while [ -z "$DOMAIN" ]; do
  DOMAIN="$(ask 'What domain will the portal live at (e.g. gis.example.org)')"
  case "$DOMAIN" in
    *.*) : ;;
    *) say "That does not look like a domain."; DOMAIN="" ;;
  esac
done
# Strip an accidental scheme or trailing slash.
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"

AUTH_DOMAIN="${AUTH_DOMAIN_IN:-$(ask 'Auth (Keycloak) domain' "auth.${DOMAIN}")}"
STORAGE_DOMAIN="${STORAGE_DOMAIN_IN:-$(ask 'Storage (uploads) domain' "storage.${DOMAIN}")}"

# --- Emails ------------------------------------------------------
ACME_EMAIL="$ACME_EMAIL_IN"
while [ -z "$ACME_EMAIL" ]; do
  ACME_EMAIL="$(ask "Email for Let's Encrypt certificate notices")"
  case "$ACME_EMAIL" in
    *@*.*) : ;;
    *) say "That does not look like an email address."; ACME_EMAIL="" ;;
  esac
done

ORG_NAME="$(ask 'Organization name shown in the portal' "$ORG_NAME")"

# --- Secrets -----------------------------------------------------
gen() { openssl rand -base64 36 | tr -d '\n'; }
# The initial portal password gets typed by a human exactly once
# (Keycloak forces a change on first login), so keep it typeable.
gen_typeable() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16; }

POSTGRES_PASSWORD="$(gen)"
KEYCLOAK_DB_PASSWORD="$(gen)"
MINIO_ROOT_PASSWORD="$(gen)"
KEYCLOAK_ADMIN_PASSWORD="$(gen)"
KEYCLOAK_ADMIN_CLIENT_SECRET="$(gen)"
NEXTAUTH_SECRET="$(gen)"
# AES-256-GCM master key: exactly 32 bytes, base64-encoded.
CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
INITIAL_USER_PASSWORD="$(gen_typeable)"

# --- DNS sanity (warn only) --------------------------------------
# Caddy needs the three hostnames to resolve to this server before it
# can obtain certificates, but it retries forever, so absent records
# only merit a warning. Public-IP detection needs an external call;
# skip quietly when offline.
say ""
say "Checking DNS (warnings only; Caddy retries until records exist)..."
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

# --- Write .env.prod --------------------------------------------
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  warn "Existing .env.prod backed up alongside it."
fi

umask 077
cat > "$ENV_FILE" <<EOF
# Generated by infra/setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# This file holds every secret the stack uses. Keep it out of git
# (it is gitignored) and readable only by the deploy user.

# --- Public hostnames ---
PORTAL_DOMAIN=${DOMAIN}
AUTH_DOMAIN=${AUTH_DOMAIN}
# Public-facing MinIO: browsers upload and fetch blobs here; Caddy
# terminates TLS and proxies to the in-cluster minio container.
STORAGE_DOMAIN=${STORAGE_DOMAIN}
PUBLIC_URL=https://${DOMAIN}

# --- Let's Encrypt ---
# Notified if certificate renewal fails; use an inbox you check.
ACME_EMAIL=${ACME_EMAIL}

# --- Postgres (app DB) ---
POSTGRES_DB=gratisgis
POSTGRES_USER=gratisgis
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
# Separate password for the keycloak role so one leak does not
# compromise both databases.
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
# Keycloak ADMIN CONSOLE password (https://${AUTH_DOMAIN}/admin/).
KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}

# portal-web is a public client (PKCE); its secret is intentionally
# empty but the variable must exist.
KEYCLOAK_CLIENT_ID=portal-web
KEYCLOAK_CLIENT_SECRET=

# Confidential service-account client the api uses for user
# reconcile / role mutation against Keycloak's admin REST.
KEYCLOAK_ADMIN_CLIENT_ID=portal-api-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET}

# --- Credential encryption ---
# AES-256-GCM master key for stored credentials. Effectively
# immutable: rotating it makes previously encrypted rows unreadable.
CREDENTIAL_ENCRYPTION_KEY=${CREDENTIAL_ENCRYPTION_KEY}

# Initial PORTAL admin password (username: admin). Keycloak forces a
# change on first login.
INITIAL_USER_PASSWORD=${INITIAL_USER_PASSWORD}

# Org slug baked into JWT claims; the api creates the org row from
# it on first auth.
DEFAULT_ORG_SLUG=gratis-gis

# --- NextAuth ---
# Signing key for NextAuth's own session tokens.
NEXTAUTH_SECRET=${NEXTAUTH_SECRET}

# --- Organization branding ---
# Initial org name; editable later in the portal admin.
DEFAULT_ORG_NAME=${ORG_NAME}
EOF
chmod 600 "$ENV_FILE"

# --- Summary -----------------------------------------------------
say ""
say "Wrote ${ENV_FILE} (mode 600)."
say ""
say "Save these initial credentials somewhere safe:"
say "  Portal sign-in:      https://${DOMAIN}  ->  admin / ${INITIAL_USER_PASSWORD}"
say "                       (you will be asked to set a new password on first login)"
say "  Keycloak console:    https://${AUTH_DOMAIN}/admin/  ->  admin / ${KEYCLOAK_ADMIN_PASSWORD}"
say ""
say "Next step:"
say "  ./infra/deploy.sh"
say ""
say "After the stack is up, run ./infra/doctor.sh any time to check"
say "the deployment's health."

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Reset one portal user's password inside the existing Keycloak.
# This does not delete volumes, databases, or objects.
#
# The new password is printed once, to this terminal, and is not
# written to a file. Keycloak's master realm stays closed at the
# proxy. This script talks to Keycloak through `docker exec`, on the
# container's own localhost.
#
#   RESET is not read from the command line, so it does not land in
#   shell history. Omit RESET_PASSWORD and the script generates one.
#
#   GG_KEYCLOAK_CONTAINER=gratis-gis-keycloak-1 \
#     ./infra/reset-portal-password.sh admin
#
#   GG_RESET_DRY_RUN=1 ./infra/reset-portal-password.sh admin
#
# Refuses to run if any argument asks to delete or wipe data.

set -euo pipefail

REALM="${GG_KEYCLOAK_REALM:-gratis-gis}"
DRY="${GG_RESET_DRY_RUN:-0}"

die() {
  echo "FATAL: $*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *volume*|*wipe*|*destroy*|--delete|--rm)
      die "refusing '$arg'. This command only resets a password. It does not delete volumes or data."
      ;;
  esac
done

USERNAME="${1:-}"
if [[ -z "$USERNAME" || "$USERNAME" == -* ]]; then
  die "usage: $0 <username>   (set GG_KEYCLOAK_CONTAINER if more than one Keycloak is running)"
fi
if [[ $# -gt 1 ]]; then
  die "unexpected extra arguments. Pass only the username."
fi

pick_container() {
  if [[ -n "${GG_KEYCLOAK_CONTAINER:-}" ]]; then
    printf '%s\n' "$GG_KEYCLOAK_CONTAINER"
    return
  fi
  local names
  names="$(docker ps --filter 'name=keycloak' --format '{{.Names}}' | sort)"
  local count
  count="$(printf '%s\n' "$names" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" -eq 1 ]]; then
    printf '%s\n' "$names"
    return
  fi
  if [[ "$count" -eq 0 ]]; then
    die "no running container with 'keycloak' in its name. Set GG_KEYCLOAK_CONTAINER."
  fi
  echo "$names" >&2
  die "more than one Keycloak container. Set GG_KEYCLOAK_CONTAINER to one of the names above."
}

if [[ "$DRY" == "1" ]]; then
  echo "dry-run: would reset portal user '$USERNAME' in realm '$REALM'"
  echo "dry-run: would not delete volumes, databases, or objects"
  echo "dry-run: new password would be printed once and not written to a file"
  exit 0
fi

CONTAINER="$(pick_container)"
docker inspect "$CONTAINER" >/dev/null

# Read the bootstrap admin password inside the container. Do not echo it.
ADMIN_PW="$(
  docker exec "$CONTAINER" /bin/bash -c '
    if [ -f /boot/env ]; then
      set -a
      . /boot/env
      set +a
    fi
    printf "%s" "${KC_BOOTSTRAP_ADMIN_PASSWORD:-${KEYCLOAK_ADMIN_PASSWORD:-}}"
  '
)"
if [[ -z "$ADMIN_PW" ]]; then
  die "Keycloak admin password is not in the container environment or /boot/env. Not deleting anything."
fi

if [[ -n "${RESET_PASSWORD:-}" ]]; then
  NEW_PW="$RESET_PASSWORD"
else
  NEW_PW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
fi

# kcadm authenticates to the master realm on localhost inside the
# container. The public proxy keeps that realm closed.
# Names only on `-e`: docker copies the values from this shell's
# environment, so neither password is on the docker command line, and
# kcadm reads the admin password from KC_CLI_PASSWORD rather than an
# argument.
export KC_CLI_PASSWORD="$ADMIN_PW"
export GG_KC_NEW_PW="$NEW_PW"
docker exec \
  -e KC_CLI_PASSWORD \
  -e GG_KC_NEW_PW \
  -e "GG_KC_USER=$USERNAME" \
  -e "GG_KC_REALM=$REALM" \
  "$CONTAINER" \
  /bin/bash -c '
    set -euo pipefail
    if [ -f /boot/env ]; then
      set -a
      . /boot/env
      set +a
    fi
    /opt/keycloak/bin/kcadm.sh config credentials \
      --server "http://127.0.0.1:8080${KC_HTTP_RELATIVE_PATH:-}" \
      --realm master \
      --user "${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}" >/dev/null
    /opt/keycloak/bin/kcadm.sh set-password \
      -r "$GG_KC_REALM" \
      --username "$GG_KC_USER" \
      --new-password "$GG_KC_NEW_PW" >/dev/null
  '

echo "Password reset for user '$USERNAME' in realm '$REALM'."
echo "New password (printed once, not saved to a file):"
echo "$NEW_PW"
echo "Sign in and change it. Keycloak will accept this password until you do."
echo "No volumes were deleted."

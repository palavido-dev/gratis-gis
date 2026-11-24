#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Single-command GratisGIS installer (#147).
#
#   curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
#
# Checks the server first and says in plain words what is missing and
# what to do about it, offers to install Docker and the basic tools
# when they are missing, then clones the repo at the newest release
# tag, runs the guided setup, deploys the stack, waits for the portal
# to answer, and prints where to sign in.
#
# Only check this server, change nothing:
#   curl -fsSL .../infra/install.sh | bash -s -- --check
#
# Prompts still work when piped because answers are read from
# /dev/tty. Override the defaults with env vars:
#   GRATIS_DIR=/opt/gratis-gis   install location
#   GRATIS_REPO=<git url>        repository to clone
#   GG_REF=v0.9.0                tag, branch, or sha to install
#                                (default: newest release tag)
#   GRATIS_ASSUME_YES=1          answer yes to the offers to install
#                                Docker and the basic tools
#
# Everything runs inside main() so a partially downloaded script
# cannot execute half an installer.
set -euo pipefail

# ---------------------------------------------------------------
# Minimums. The stack builds its images on the server, which is
# what needs the memory; the database and uploads need the disk.
# ---------------------------------------------------------------
GG_MIN_MEM_GB=3.5
GG_GOOD_MEM_GB=7.5
GG_MIN_DISK_GB=20
GG_GOOD_DISK_GB=40

# Counters for the server check.
GG_PROBLEMS=0
GG_CAUTIONS=0

# Colors only on a terminal, so logs stay readable.
if [ -t 1 ]; then GG_G=$'\033[32m' GG_Y=$'\033[33m' GG_R=$'\033[31m' GG_0=$'\033[0m'; else GG_G='' GG_Y='' GG_R='' GG_0=''; fi
gg_ok() { printf '  %sok%s    %s\n' "$GG_G" "$GG_0" "$*"; }
gg_caution() {
  printf '  %snote%s  %s\n' "$GG_Y" "$GG_0" "$1"
  [ -n "${2:-}" ] && printf '        %s\n' "$2"
  GG_CAUTIONS=$((GG_CAUTIONS + 1))
}
gg_problem() {
  printf '  %sstop%s  %s\n' "$GG_R" "$GG_0" "$1"
  [ -n "${2:-}" ] && printf '        What to do: %s\n' "$2"
  GG_PROBLEMS=$((GG_PROBLEMS + 1))
}

# Ask a yes/no question on the terminal. Defaults to yes on Enter.
# With no terminal (an unattended run) the answer is GRATIS_ASSUME_YES.
gg_confirm() {
  if [ "${GRATIS_ASSUME_YES:-0}" = "1" ]; then return 0; fi
  if ! { : </dev/tty; } 2>/dev/null; then return 1; fi
  local answer=""
  read -r -p "$1 [Y/n] " answer </dev/tty || true
  case "${answer,,}" in "" | y | yes) return 0 ;; *) return 1 ;; esac
}

# Run as root, through sudo when needed.
gg_as_root() {
  if [ "$(id -u)" = "0" ]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else return 1; fi
}

# Whether $1 >= $2 for decimal numbers.
gg_ge() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 >= b + 0) }'; }

# ---------------------------------------------------------------
# Server checks. Each reads the machine unless a GG_TEST_* value is
# set, which the tests use.
# ---------------------------------------------------------------

gg_check_system() {
  local kernel="${GG_TEST_KERNEL:-$(uname -s)}"
  local arch="${GG_TEST_ARCH:-$(uname -m)}"
  if [ "$kernel" != "Linux" ]; then
    gg_problem "This computer runs ${kernel}. GratisGIS installs on a Linux server." \
      "use a Linux server (Ubuntu 24.04 or Debian 12 work best), or on a home NAS follow docs/truenas.md."
    return
  fi
  case "$arch" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) gg_problem "This server's processor (${arch}) is not supported." "use a 64-bit Intel, AMD or ARM server." ;;
  esac
  local name=""
  if [ -n "${GG_TEST_OS:-}" ]; then
    name="$GG_TEST_OS"
  elif [ -r /etc/os-release ]; then
    name="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}")"
  fi
  case "$name" in
    Ubuntu* | Debian* | "Linux Mint"*) gg_ok "${name}" ;;
    "") gg_caution "Could not tell which Linux this is." "Ubuntu 24.04 and Debian 12 are the tested systems." ;;
    *) gg_caution "${name} is not one of the tested systems (Ubuntu 24.04, Debian 12)." "It may still work." ;;
  esac
}

gg_check_memory() {
  local mem="${GG_TEST_MEM_GB:-$(awk '/MemTotal/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo 2>/dev/null || echo 0)}"
  if ! gg_ge "$mem" "$GG_MIN_MEM_GB"; then
    gg_problem "This server has ${mem} GB of memory. GratisGIS needs at least 4 GB." \
      "move to a server plan with 4 GB or more (8 GB is comfortable), then run the installer again."
  elif ! gg_ge "$mem" "$GG_GOOD_MEM_GB"; then
    gg_caution "${mem} GB of memory. Enough to run, but the first install is slow and big uploads may struggle." \
      "8 GB is comfortable for a small team."
  else
    gg_ok "${mem} GB of memory"
  fi
}

gg_check_disk() {
  local path="/var/lib/docker"
  [ -d "$path" ] || path="/"
  local free="${GG_TEST_DISK_GB:-$(df -BG --output=avail "$path" 2>/dev/null | tail -1 | tr -dc '0-9')}"
  free="${free:-0}"
  if [ "$free" -lt "$GG_MIN_DISK_GB" ]; then
    gg_problem "Only ${free} GB of free disk space. GratisGIS needs at least ${GG_MIN_DISK_GB} GB." \
      "pick a server plan with more disk, or free up space, then run the installer again."
  elif [ "$free" -lt "$GG_GOOD_DISK_GB" ]; then
    gg_caution "${free} GB of free disk space. Enough to start; data and photos will need more over time."
  else
    gg_ok "${free} GB of free disk space"
  fi
}

# Web ports 80 and 443. Docker's own listener (a previous install of
# GratisGIS) is fine; anything else blocks the certificates.
gg_check_ports() {
  local p holder
  for p in 80 443; do
    if [ -n "${GG_TEST_PORT_HOLDER:-}" ]; then
      holder="$GG_TEST_PORT_HOLDER"
    elif command -v ss >/dev/null 2>&1; then
      holder="$(ss -H -ltnp "sport = :$p" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1 || true)"
      if [ -z "$holder" ] && [ -n "$(ss -H -ltn "sport = :$p" 2>/dev/null || true)" ]; then holder="another program"; fi
    else
      gg_caution "Could not check web port ${p} (the ss tool is missing)."
      continue
    fi
    case "$holder" in
      "" | none) gg_ok "Web port ${p} is free" ;;
      docker-proxy | caddy) gg_ok "Web port ${p} is used by Docker (an earlier install)" ;;
      *)
        gg_problem "Web port ${p} is already used by ${holder}. GratisGIS needs ports 80 and 443 for its web address and certificates." \
          "stop or remove ${holder} (for example: systemctl disable --now ${holder}), or use a server that does not run another website."
        ;;
    esac
  done
}

# The sites the install downloads from, and Let's Encrypt for the
# certificate.
gg_check_internet() {
  local url label failed=0
  for pair in \
    "https://github.com|GitHub (the GratisGIS code)" \
    "https://registry-1.docker.io/v2/|Docker Hub (base images)" \
    "https://quay.io|Quay (the sign-in service image)" \
    "https://acme-v02.api.letsencrypt.org/directory|Let's Encrypt (the HTTPS certificate)"; do
    url="${pair%%|*}"
    label="${pair#*|}"
    if [ -n "${GG_TEST_OFFLINE:-}" ] || ! curl -sS -o /dev/null --max-time 10 "$url" 2>/dev/null; then
      gg_problem "Cannot reach ${label}." \
        "check this server's internet connection and firewall, then run the installer again."
      failed=1
    fi
  done
  [ "$failed" = "0" ] && gg_ok "Internet: GitHub, Docker Hub, Quay and Let's Encrypt all answer"
  return 0
}

# Tools the installer uses. Missing ones are offered for install.
GG_TOOLS="git curl openssl python3"
gg_missing_tools() {
  local missing="" bin
  for bin in $GG_TOOLS; do
    command -v "$bin" >/dev/null 2>&1 || missing="${missing} ${bin}"
  done
  printf '%s' "${missing# }"
}

gg_docker_state() {
  if ! command -v docker >/dev/null 2>&1; then echo missing; return; fi
  if ! docker compose version >/dev/null 2>&1; then echo no-compose; return; fi
  local err
  if ! err="$(docker info 2>&1 >/dev/null)"; then
    case "$err" in
      *"permission denied"*) echo no-access ;;
      *) echo not-running ;;
    esac
    return
  fi
  echo ok
}

# Whether an existing install copies its backups off-site. Never a
# stop: a new server has nothing to back up yet. Reads the env file
# (BACKUP_OFFSITE_*), then the saved setting in the database when the
# stack is running. Test hooks: GG_TEST_ENV_FILE, GG_TEST_OFFSITE_DB
# (on, off or unknown).
gg_env_get() {
  grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"'\r'
}
gg_check_offsite() {
  local env_file="${GG_TEST_ENV_FILE:-${GRATIS_DIR:-/opt/gratis-gis}/infra/.env.prod}"
  if [ ! -f "$env_file" ]; then
    gg_ok "Off-site backups: set them up after installing (Admin, Backup, Off-site copies)"
    return 0
  fi
  local enabled bucket
  enabled="$(gg_env_get "$env_file" BACKUP_OFFSITE_ENABLED | tr '[:upper:]' '[:lower:]')"
  bucket="$(gg_env_get "$env_file" BACKUP_OFFSITE_BUCKET)"
  if [ "$enabled" = "true" ] && [ -n "$bucket" ]; then
    gg_ok "Off-site backups are on in the env file (bucket ${bucket})"
    return 0
  fi
  local db="${GG_TEST_OFFSITE_DB:-}"
  if [ -z "$db" ]; then
    db=unknown
    if command -v docker >/dev/null 2>&1; then
      local user name answer
      user="$(gg_env_get "$env_file" POSTGRES_USER)"
      name="$(gg_env_get "$env_file" POSTGRES_DB)"
      answer="$(docker exec gratis-gis-prod-postgres psql -X -A -t -U "${user:-gratisgis}" -d "${name:-gratisgis}" \
        -c "SELECT coalesce((SELECT coalesce(offsite_enabled, false) AND offsite_bucket IS NOT NULL FROM backup_config LIMIT 1), false)" 2>/dev/null || true)"
      case "$answer" in
        t) db=on ;;
        f) db=off ;;
      esac
    fi
  fi
  case "$db" in
    on) gg_ok "Off-site backups are on (set on Admin, Backup)" ;;
    off)
      gg_caution "Off-site backups are not set up. If this server is lost, its backups are lost with it." \
        "Turn on Off-site copies on Admin, Backup, or set BACKUP_OFFSITE_* in ${env_file}."
      ;;
    *)
      gg_caution "Could not tell whether off-site backups are set up (the portal database did not answer)." \
        "Check Admin, Backup, Off-site copies once the portal is running."
      ;;
  esac
}

# Run every check and print a summary. Returns 1 when anything must
# be fixed before installing.
gg_check_server() {
  echo ""
  echo "Checking this server"
  echo "--------------------"
  gg_check_system
  gg_check_memory
  gg_check_disk
  gg_check_ports
  gg_check_internet
  local missing
  missing="$(gg_missing_tools)"
  if [ -n "$missing" ]; then
    gg_caution "Missing tools: ${missing}." "The installer can add them for you."
  else
    gg_ok "Tools: git, curl, openssl, python3"
  fi
  case "$(gg_docker_state)" in
    ok) gg_ok "Docker with Compose is installed and running" ;;
    missing) gg_caution "Docker is not installed." "The installer can install it for you." ;;
    no-compose) gg_caution "Docker is installed but its Compose plugin is not." "The installer can add it for you." ;;
    not-running) gg_caution "Docker is installed but not running." "The installer will start it." ;;
    no-access)
      gg_problem "Docker is installed but this user cannot use it." \
        "run the installer as root (sudo -i first), or add this user to the docker group and log in again."
      ;;
  esac
  gg_check_offsite
  echo ""
  if [ "$GG_PROBLEMS" -gt 0 ]; then
    echo "${GG_PROBLEMS} thing(s) above need fixing before GratisGIS can be installed."
    return 1
  fi
  echo "This server is ready for GratisGIS."
  return 0
}

# ---------------------------------------------------------------
# Fixing what can be fixed here.
# ---------------------------------------------------------------

gg_install_tools() {
  local missing
  missing="$(gg_missing_tools)"
  [ -z "$missing" ] && return 0
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Please install these and run the installer again: ${missing}" >&2
    return 1
  fi
  if ! gg_confirm "Install ${missing} now?"; then
    echo "Install them with: sudo apt-get install -y ${missing}" >&2
    return 1
  fi
  # shellcheck disable=SC2086
  gg_as_root apt-get update -qq && gg_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $missing
}

gg_install_docker() {
  case "$(gg_docker_state)" in
    ok) return 0 ;;
    no-access) return 1 ;;
    not-running)
      echo "Starting Docker..."
      gg_as_root systemctl enable --now docker >/dev/null 2>&1 || true
      if [ "$(gg_docker_state)" = "ok" ]; then return 0; fi
      echo "Docker would not start. Check: sudo systemctl status docker" >&2
      return 1
      ;;
  esac
  if ! gg_confirm "Install Docker now, using Docker's official install script?"; then
    echo "Install Docker by following https://docs.docker.com/engine/install/ and run the installer again." >&2
    return 1
  fi
  echo "Installing Docker (a few minutes)..."
  local script
  script="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$script"
  gg_as_root sh "$script"
  rm -f "$script"
  gg_as_root systemctl enable --now docker >/dev/null 2>&1 || true
  if [ "$(gg_docker_state)" != "ok" ]; then
    if [ "$(id -u)" != "0" ] && gg_as_root docker info >/dev/null 2>&1; then
      echo "Docker is installed. This user is not in the docker group yet: run the installer again with sudo, or log out and back in." >&2
    else
      echo "Docker did not start. Check: sudo systemctl status docker" >&2
    fi
    return 1
  fi
  echo "Docker is installed."
}

# Wait for the portal's web address to answer over HTTPS. Returns 0
# when it does within the time allowed.
gg_wait_for_portal() {
  local domain="$1" tries="${2:-60}" i code
  for ((i = 0; i < tries; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${domain}/" 2>/dev/null || true)"
    case "$code" in 2* | 3*) return 0 ;; esac
    sleep 10
  done
  return 1
}

# Resolve which ref to install. GG_REF (a tag, branch, or commit sha)
# wins when set; otherwise the newest release tag (vX.Y.Z only, so a
# pre-release like v1.0.0-rc.1 is never auto-picked); when the remote
# has no release tags yet, fall back to main with a warning so
# pre-release checkouts keep deploying. Failing to LIST tags is fatal
# rather than a silent fallback: a transient network error must not
# flip a release-pinned deploy back onto main.
#
# Keep this function in sync with the copy in infra/deploy.sh.
gg_resolve_ref() {
  local remote="$1"
  if [[ -n "${GG_REF:-}" ]]; then
    printf '%s\n' "$GG_REF"
    return 0
  fi
  local tags latest
  if ! tags="$(git ls-remote --tags --refs "$remote" 'v[0-9]*')"; then
    echo "FATAL: could not list release tags on ${remote}." >&2
    return 1
  fi
  latest="$(printf '%s\n' "$tags" \
    | awk '{print $2}' \
    | sed 's|^refs/tags/||' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n 1)" || true
  if [[ -n "$latest" ]]; then
    printf '%s\n' "$latest"
  else
    echo "WARN: no release tags found on ${remote}; falling back to main." >&2
    printf '%s\n' "main"
  fi
}

main() {
  local repo="${GRATIS_REPO:-https://github.com/palavido-dev/gratis-gis}"
  local dir="${GRATIS_DIR:-/opt/gratis-gis}"
  local check_only=0
  [ "${1:-}" = "--check" ] && check_only=1

  echo ""
  echo "GratisGIS installer"
  echo "==================="

  if ! gg_check_server; then
    echo "Nothing was changed. Fix the items marked stop and run the installer again." >&2
    exit 1
  fi
  if [ "$check_only" = "1" ]; then exit 0; fi

  gg_install_tools || exit 1
  gg_install_docker || exit 1

  local fresh_clone=0
  if [ -d "${dir}/.git" ]; then
    echo "Using the existing checkout at ${dir}."
  else
    echo "Downloading GratisGIS to ${dir}..."
    # /opt needs root; the checkout itself belongs to this user.
    if ! mkdir -p "$dir" 2>/dev/null; then
      gg_as_root mkdir -p "$dir" && gg_as_root chown "$(id -u):$(id -g)" "$dir"
    fi
    git clone --quiet --depth 1 "$repo" "$dir"
    fresh_clone=1
  fi
  cd "$dir"

  # A fresh clone sits at the tip of the default branch; move it to
  # the release ref so the FIRST deploy already runs the released
  # deploy script. Existing checkouts are left alone here: deploy.sh
  # re-resolves the ref and hard-resets to it on every run, and may
  # be guarding local state we should not clobber from the installer.
  if [ "$fresh_clone" = "1" ]; then
    local ref
    ref="$(gg_resolve_ref "$repo")"
    echo "Using GratisGIS ${ref}."
    git fetch --quiet --depth 1 origin "$ref"
    git checkout --quiet --detach FETCH_HEAD
  fi

  if [ -f infra/.env.prod ]; then
    echo "infra/.env.prod already exists; keeping it. (Run ./infra/setup.sh --force to regenerate.)"
  else
    bash infra/setup.sh
  fi

  echo ""
  echo "Installing. The first time builds everything on this server and"
  echo "takes 15 to 30 minutes. You can leave this window open and come back."
  export INSTALL_TYPE=vps
  if ! ./infra/deploy.sh; then
    echo ""
    echo "The install stopped with an error (see the lines above)." >&2
    echo "Run ${dir}/infra/doctor.sh for a check of what is wrong, then run the installer again." >&2
    exit 1
  fi

  local domain
  domain="$(grep '^PORTAL_DOMAIN=' infra/.env.prod | cut -d= -f2-)"
  echo ""
  echo "Waiting for https://${domain} to answer (up to 10 minutes while the"
  echo "certificate is issued)..."
  if gg_wait_for_portal "$domain" 60; then
    echo ""
    echo "GratisGIS is ready: https://${domain}"
    echo "Sign in as admin with the password the setup printed above."
    echo ""
    echo "Health check any time: ${dir}/infra/doctor.sh"
  else
    echo ""
    echo "GratisGIS is installed, but https://${domain} is not answering yet." >&2
    echo "The usual cause is the domain name not pointing at this server yet," >&2
    echo "so the HTTPS certificate cannot be issued. Here is what the check finds:" >&2
    echo "" >&2
    ./infra/doctor.sh 2>&1 | grep -E '^(FAIL|WARN)' | head -15 >&2 || true
    echo "" >&2
    echo "Once that is fixed, the site comes up on its own within a few minutes." >&2
    echo "Run ${dir}/infra/doctor.sh again to check." >&2
    exit 1
  fi
}

# Tests load the functions without running the installer.
if [ "${GG_INSTALL_LIB_ONLY:-0}" != "1" ]; then
  main "$@"
fi

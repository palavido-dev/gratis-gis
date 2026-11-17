#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Literal loader for .env files, shared by deploy.sh,
# restore-golden.sh and snapshot-golden.sh.
#
# Why this exists: those scripts used to do `set -a; . infra/.env.prod`,
# which hands the file to bash. Bash expands the right-hand side, so a
# value that contains a dollar sign silently becomes something else.
# The day this was written, STATS_HASH (a bcrypt hash, which is all
# dollar signs) turned into the deploy shell's PID, Caddy rejected the
# resulting basic-auth config, and the site was down for six minutes.
# Sourcing also executes whatever the file says, so one bad line in a
# secrets file is arbitrary code in a root deploy.
#
# gg_load_env_file reads the same file the way docker compose reads
# --env-file, so the scripts and compose can never disagree:
#
#   - blank lines and whole-line comments are skipped
#   - an optional leading `export ` is allowed
#   - the key is everything before the first `=` and must look like a
#     shell name; anything else is ignored
#   - the value is taken verbatim, with one pass of quote stripping
#     when it is wrapped in matching single or double quotes
#   - an unquoted value drops a trailing ` #` comment and trailing
#     whitespace, which is what compose does
#   - outside single quotes, `$$` collapses to `$`, which is compose's
#     escape for a literal dollar sign
#   - nothing else is expanded, ever: no $(cmd), no backticks, and no
#     $VAR interpolation. Compose does interpolate $VAR in an
#     unquoted value, so a file that relies on it would make the
#     scripts and compose disagree; the loader warns on stderr rather
#     than pretending otherwise.
#
# The safe way to write a value containing dollar signs is single
# quotes, which both this loader and compose take literally.
#
# Usage: source this file, then `gg_load_env_file /path/to/.env.prod`.
# Every parsed key is exported, matching the old `set -a` behavior.

gg_load_env_file() {
  local file="$1"
  local line key value trimmed rest quoted inner body i c n
  if [[ ! -f "$file" ]]; then
    echo "FATAL: env file not found: $file" >&2
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Tolerate a CRLF file; an editor on Windows is a normal way for
    # this file to get written.
    line="${line%$'\r'}"
    # Left-trim, then skip blanks and comments.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    [[ "$trimmed" == export\ * ]] && trimmed="${trimmed#export }"
    [[ "$trimmed" == *=* ]] || continue
    key="${trimmed%%=*}"
    value="${trimmed#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # A quoted value may be followed by a ` # comment`, as Compose
    # allows. Take the text up to the closing quote; only blanks or a
    # comment may follow it.
    rest=""
    quoted=""
    if [[ "$value" == \'* ]]; then
      inner="${value:1}"
      if [[ "$inner" == *\'* ]]; then
        rest="${inner#*\'}"
        if [[ -z "${rest//[[:space:]]/}" || "$rest" =~ ^[[:space:]]+# ]]; then
          quoted=single
          value="${inner%%\'*}"
        fi
      fi
    elif [[ "$value" == \"* ]]; then
      inner="${value:1}"
      body=""
      i=0
      while (( i < ${#inner} )); do
        c="${inner:i:1}"
        if [[ "$c" == '\' && $((i + 1)) -lt ${#inner} ]]; then
          n="${inner:i+1:1}"
          case "$n" in
            n) body+=$'\n' ;;
            t) body+=$'\t' ;;
            '"' | '\' | '$') body+="$n" ;;
            *) body+="\\$n" ;;
          esac
          i=$((i + 2))
          continue
        fi
        if [[ "$c" == '"' ]]; then
          rest="${inner:i+1}"
          if [[ -z "${rest//[[:space:]]/}" || "$rest" =~ ^[[:space:]]+# ]]; then
            quoted=double
            value="$body"
          fi
          break
        fi
        body+="$c"
        i=$((i + 1))
      done
    fi
    if [[ "$quoted" == single ]]; then
      # Single quotes are literal for compose too. Nothing else to do.
      :
    else
      if [[ "$quoted" == double ]]; then
        :
      else
        value="${value%%[[:space:]]#*}"
        value="${value%"${value##*[![:space:]]}"}"
      fi
      if [[ "$value" == *'$'* ]]; then
        # Warn when a dollar sign survives the $$ escape: compose
        # would interpolate it as a variable and we would not, and a
        # value that means two different things to two readers of the
        # same file is how the site went down in the first place.
        if [[ "${value//\$\$/}" == *'$'* ]]; then
          echo "WARN: $key contains an unescaped \$; single-quote the value or double the dollar signs ($file)" >&2
        fi
        value="${value//\$\$/\$}"
      fi
    fi
    # printf -v assigns without any expansion of the value.
    printf -v "$key" '%s' "$value"
    export "${key}"
  done < "$file"
}

# Variables a production-shaped env file must contain before compose
# will interpolate. CHROMIUM_TOKEN and SCRIPT_EXECUTOR_TOKEN are
# required even when nobody prints and the scripts profile is off:
# Compose interpolates the whole file, profiles included. An empty
# Dockge / TrueNAS env box fails here with "CHROMIUM_TOKEN is missing".
gg_require_prod_env() {
  local key val missing weak
  local -a required secrets
  required=(
    PORTAL_DOMAIN
    AUTH_DOMAIN
    STORAGE_DOMAIN
    PUBLIC_URL
    ACME_EMAIL
    POSTGRES_PASSWORD
    KEYCLOAK_DB_PASSWORD
    MINIO_ROOT_USER
    MINIO_ROOT_PASSWORD
    KEYCLOAK_ADMIN_PASSWORD
    KEYCLOAK_ADMIN_CLIENT_SECRET
    CREDENTIAL_ENCRYPTION_KEY
    INITIAL_USER_PASSWORD
    NEXTAUTH_SECRET
    DEFAULT_ORG_SLUG
    CHROMIUM_TOKEN
    SCRIPT_EXECUTOR_TOKEN
  )
  secrets=(
    POSTGRES_PASSWORD
    KEYCLOAK_DB_PASSWORD
    MINIO_ROOT_PASSWORD
    KEYCLOAK_ADMIN_PASSWORD
    KEYCLOAK_ADMIN_CLIENT_SECRET
    INITIAL_USER_PASSWORD
    NEXTAUTH_SECRET
    CHROMIUM_TOKEN
    SCRIPT_EXECUTOR_TOKEN
  )
  missing=""
  weak=""
  for key in "${required[@]}"; do
    val="${!key-}"
    if [ -z "$val" ] || [ "$val" = "GENERATE" ]; then
      missing="${missing} ${key}"
    fi
  done
  if [ -n "$missing" ]; then
    echo "FATAL: these variables must be set to real values in the env file:${missing}" >&2
    echo "An empty env box (Dockge, Portainer, TrueNAS) does not fill them in." >&2
    echo "Run ./infra/bootstrap.sh so it can generate them, or set each one yourself." >&2
    echo "A secret is:  openssl rand -base64 36" >&2
    echo "The encryption key is:  openssl rand -base64 32" >&2
    echo "CHROMIUM_TOKEN is required even if you never print a map." >&2
    echo "SCRIPT_EXECUTOR_TOKEN is required even if you do not enable user scripts." >&2
    return 1
  fi
  # Known placeholders only. Length is not checked here: an existing
  # deployment may already have a shorter token, and this function
  # also runs on every ./infra/deploy.sh. New files from bootstrap.sh
  # are generated long. The encryption key is the exception, because
  # the api refuses any length other than 32 bytes.
  for key in "${secrets[@]}"; do
    val="${!key-}"
    case "$val" in
      password|devpassword|admin|changeme|secret)
        weak="${weak} ${key}"
        ;;
    esac
  done
  if [ -n "$weak" ]; then
    echo "FATAL: these secrets are too short or are a well-known placeholder:${weak}" >&2
    echo "Refusing to start with a default or guessable password." >&2
    return 1
  fi
  # AES-256-GCM key: exactly 32 raw bytes, base64. Rotating it later
  # makes every encrypted credential unreadable, so a wrong length has
  # to fail before the first row is written.
  # The key goes in on stdin, not argv, so `ps` never shows it.
  if ! python3 -c '
import base64, sys
raw = sys.stdin.read().strip()
try:
    decoded = base64.b64decode(raw, validate=True)
except Exception:
    sys.exit(1)
sys.exit(0 if len(decoded) == 32 else 1)
' <<<"$CREDENTIAL_ENCRYPTION_KEY"
  then
    echo "FATAL: CREDENTIAL_ENCRYPTION_KEY must be 32 bytes of base64 (openssl rand -base64 32)." >&2
    return 1
  fi
  case "$PUBLIC_URL" in
    https://*) ;;
    *)
      echo "FATAL: PUBLIC_URL must start with https:// (got ${PUBLIC_URL})." >&2
      return 1
      ;;
  esac
  case "$ACME_EMAIL" in
    *@*.*) ;;
    *)
      echo "FATAL: ACME_EMAIL does not look like an email address." >&2
      return 1
      ;;
  esac
}

# Substitute ${VAR} in the Keycloak realm template and write JSON.
# Uses Python so a TrueNAS shell (no gettext / envsubst) can render
# it. Values are JSON-escaped. Unset placeholders are an error, not
# an empty string.
gg_render_realm_import() {
  local template="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  python3 - "$template" "$dest" <<'PY'
import json, os, re, sys
template, dest = sys.argv[1], sys.argv[2]
text = open(template, encoding="utf-8").read()
missing = []
def repl(match):
    key = match.group(1)
    val = os.environ.get(key, "")
    if val == "":
        missing.append(key)
        return match.group(0)
    # json.dumps adds quotes; the placeholder already sits inside a
    # JSON string, so keep only the escaped contents.
    return json.dumps(val)[1:-1]
out = re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", repl, text)
if missing:
    sys.exit("FATAL: realm template is missing env vars: " + " ".join(sorted(set(missing))))
if "${" in out:
    sys.exit("FATAL: realm template still contains an unsubstituted placeholder")
json.loads(out)
with open(dest, "w", encoding="utf-8") as fh:
    fh.write(out)
    if not out.endswith("\n"):
        fh.write("\n")
PY
  if [ "$(id -u)" -eq 0 ]; then
    chown 0:0 "$dest"
    chmod 640 "$dest"
  else
    # Keycloak runs as uid 1000, gid 0. A 640 file owned by some
    # other group is unreadable in the container. 644 lets that uid
    # read it. Do not export this directory over a file share.
    chmod 644 "$dest"
    echo "WARN: realm import is mode 644 because this user is not root. Keep this directory off shared folders." >&2
  fi
}

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
  local line key value trimmed
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
    if [[ ${#value} -ge 2 && "$value" == \'*\' ]]; then
      # Single quotes are literal for compose too. Nothing else to do.
      value="${value:1:${#value}-2}"
    else
      if [[ ${#value} -ge 2 && "$value" == \"*\" ]]; then
        value="${value:1:${#value}-2}"
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

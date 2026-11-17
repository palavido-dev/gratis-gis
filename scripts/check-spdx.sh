#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Fail when a git-tracked first-party source file is missing
# `SPDX-License-Identifier: AGPL-3.0-or-later` in its first 10 lines.
#
#   bash scripts/check-spdx.sh            # this checkout
#   bash scripts/check-spdx.sh --self-test
#   pnpm check:spdx
#
# The header belongs on line 1, in the comment syntax of the file.
# Two placements are deliberate exceptions to "line 1":
#   - A shebang stays line 1. The header is the next line.
#   - A `'use client'` directive stays the first statement. The header
#     comment is the line above it (see any headered client component).
#
# Scanned extensions. This is the source-language set the repo
# actually writes, plus the languages in the OSGeo header rule that
# this tree does not use yet (java, go, rs, jsx, scss) so a new file
# in one of those is checked from the first commit:
#   ts tsx js jsx mjs cjs py kt kts java go rs sh bash sql css scss
#   prisma
#
# Not scanned, on purpose (resources, assets, and config, not that
# source set): Android XML manifests and resources, SVG, HTML, JSON,
# YAML, Markdown, .properties, ProGuard rules, systemd units,
# Dockerfiles, and the Caddyfile.
#
# Exemptions. A path here is skipped even when the extension matches.
# Do not add a header to an exempt file to satisfy this script.
#
#   apps/portal-api/prisma/migrations/**
#       Prisma migration history. Editing an applied migration changes
#       its checksum and breaks `migrate deploy`. One migration already
#       carries a header; that is fine, and new ones are not required
#       to.
#   next-env.d.ts
#       Next.js rewrites this file. A header would not survive the
#       next dev or build.
#   node_modules/**, dist/**, build/**, .next/**, coverage/**
#       Dependencies and build output. Not source, even if a checkout
#       force-adds them.
#   apps/portal-web/public/maplibre/**
#       MapLibre's worker and the chunk it imports, copied by
#       apps/portal-web/scripts/vendor-maplibre-worker.mjs. Third-party.
#   clients/android/gradlew
#   clients/android/gradlew.bat
#   clients/android/gradle/wrapper/**
#       Upstream Gradle wrapper. gradlew has no extension, so the
#       extension filter already skips it; the path exemption is what
#       keeps a wrapper script from becoming a failure if it is ever
#       named like source.
#   apps/portal-web/src/app/items/[id]/map/map-icons.ts
#       Generated icon registry. scripts/gen-map-icons.cjs writes the
#       SPDX line into the output, so the committed file is not
#       hand-maintained. Other generated sources are not exempt: if a
#       generator does not emit the header, fix the generator. Build
#       output that is not this file stays under the dist/build rules
#       above (the field-engine bundle is one of those).
#
# Only git-tracked files are scanned (`git ls-files`). A new file is
# invisible to the check until it is added.

set -euo pipefail

MARKER='SPDX-License-Identifier: AGPL-3.0-or-later'
HEAD_LINES=10
SCANNED=0

is_source() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.kt|*.kts|*.java|*.go|*.rs|*.sh|*.bash|*.sql|*.css|*.scss|*.prisma)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_exempt() {
  local p="$1"
  # Next.js regenerates this. Match the basename so a second app
  # would be covered too.
  [[ "${p##*/}" == 'next-env.d.ts' ]] && return 0
  [[ "$p" == apps/portal-api/prisma/migrations/* ]] && return 0
  # Literal path. Quoted so the [id] segment is not a character class.
  [[ "$p" == 'apps/portal-web/src/app/items/[id]/map/map-icons.ts' ]] && return 0
  [[ "$p" == 'clients/android/gradlew' || "$p" == 'clients/android/gradlew.bat' ]] && return 0
  [[ "$p" == clients/android/gradle/wrapper/* ]] && return 0
  [[ "$p" == apps/portal-web/public/maplibre/* ]] && return 0
  [[ "$p" == node_modules/* || "$p" == */node_modules/* ]] && return 0
  [[ "$p" == dist/* || "$p" == */dist/* ]] && return 0
  [[ "$p" == build/* || "$p" == */build/* ]] && return 0
  [[ "$p" == .next/* || "$p" == */.next/* ]] && return 0
  [[ "$p" == coverage/* || "$p" == */coverage/* ]] && return 0
  return 1
}

# Write sorted repo-relative paths that are in scope and lack the
# marker. Reads the working tree, not the index blob, so a dirty
# header deletion fails locally before commit.
collect_missing() {
  local root="$1"
  local outfile="$2"
  local f header
  : >"$outfile"
  SCANNED=0
  while IFS= read -r -d '' f; do
    is_source "$f" || continue
    is_exempt "$f" && continue
    SCANNED=$((SCANNED + 1))
    # Store the head and search it. A pipe into `grep -q` under
    # pipefail false-fails when grep exits early and head gets
    # SIGPIPE.
    header="$(head -n "$HEAD_LINES" -- "$root/$f")"
    if [[ "$header" != *"$MARKER"* ]]; then
      printf '%s\n' "$f" >>"$outfile"
    fi
  done < <(git -C "$root" ls-files -z)
  sort -o "$outfile" "$outfile"
}

report_missing() {
  local outfile="$1"
  local label="$2"
  if [[ -s "$outfile" ]]; then
    echo "$label" >&2
    sed 's/^/  /' "$outfile" >&2
    return 1
  fi
  return 0
}

# Temps registered here are removed on any exit, including a failed
# fixture diff. Empty-array expansion under `set -u` needs the `+` form.
TMP_DIRS=()
TMP_FILES=()
cleanup() {
  local d f
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    rm -rf "$d"
  done
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    rm -f "$f"
  done
}
trap cleanup EXIT

self_test() {
  local tmp expected actual
  tmp="$(mktemp -d)"
  expected="$(mktemp)"
  actual="$(mktemp)"
  TMP_DIRS+=("$tmp")
  TMP_FILES+=("$expected" "$actual")

  mkdir -p \
    "$tmp/apps/portal-api/prisma/migrations/20260101_init" \
    "$tmp/apps/portal-web/src/app/items/[id]/map" \
    "$tmp/apps/portal-web/public/maplibre/1.0.0" \
    "$tmp/apps/foo/node_modules/pkg" \
    "$tmp/pkg/dist" \
    "$tmp/pkg/build" \
    "$tmp/clients/android/app" \
    "$tmp/clients/android/gradle/wrapper" \
    "$tmp/src"

  printf '// %s\nexport const a = 1;\n' "$MARKER" >"$tmp/ok.ts"
  printf 'export const b = 1;\n' >"$tmp/bad.ts"
  printf '// SPDX-License-Identifier: MIT\nexport const c = 1;\n' >"$tmp/mit.ts"
  {
    local i
    for i in 1 2 3 4 5 6 7 8 9; do printf '// pad %s\n' "$i"; done
    printf '// %s\n' "$MARKER"
  } >"$tmp/line10.ts"
  {
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do printf '// pad %s\n' "$i"; done
    printf '// %s\n' "$MARKER"
  } >"$tmp/line11.ts"
  printf '#!/usr/bin/env bash\n# %s\necho ok\n' "$MARKER" >"$tmp/shebang-ok.sh"
  printf '#!/usr/bin/env bash\necho no\n' >"$tmp/shebang-only.sh"
  printf 'model X {\n  id Int\n}\n' >"$tmp/bad.prisma"
  printf 'SELECT 1;\n' >"$tmp/apps/portal-api/prisma/migrations/20260101_init/migration.sql"
  printf '/// <reference types="next" />\n' >"$tmp/apps/portal-web/next-env.d.ts"
  printf 'export const icons = {};\n' >"$tmp/apps/portal-web/src/app/items/[id]/map/map-icons.ts"
  printf 'export const other = 1;\n' >"$tmp/apps/portal-web/src/app/items/[id]/map/other.ts"
  printf 'export const dep = 1;\n' >"$tmp/apps/foo/node_modules/pkg/index.js"
  printf 'export const bundle = 1;\n' >"$tmp/pkg/dist/bundle.js"
  printf 'export const built = 1;\n' >"$tmp/pkg/build/out.js"
  printf 'export const helper = 1;\n' >"$tmp/src/build-helper.ts"
  printf 'plugins {}\n' >"$tmp/clients/android/app/build.gradle.kts"
  printf '#!/bin/sh\necho wrapper\n' >"$tmp/clients/android/gradle/wrapper/upstream.sh"
  printf '#!/bin/sh\necho gradlew\n' >"$tmp/clients/android/gradlew"
  printf '<!DOCTYPE html>\n' >"$tmp/page.html"
  printf 'FROM scratch\n' >"$tmp/Dockerfile"
  printf '# notes\n' >"$tmp/README.md"

  git -C "$tmp" init -q
  git -C "$tmp" add -f -A

  printf '%s\n' \
    'apps/portal-web/src/app/items/[id]/map/other.ts' \
    'bad.prisma' \
    'bad.ts' \
    'clients/android/app/build.gradle.kts' \
    'line11.ts' \
    'mit.ts' \
    'shebang-only.sh' \
    'src/build-helper.ts' \
    | sort >"$expected"

  collect_missing "$tmp" "$actual"
  if ! diff -u "$expected" "$actual" >&2; then
    echo 'self-test: fixture did not fail on the expected files' >&2
    exit 1
  fi
  echo "self-test fixture matched (${SCANNED} files scanned in the fixture)"
}

repo_root="$(git rev-parse --show-toplevel)"

case "${1:-}" in
  '') ;;
  --self-test) self_test ;;
  *)
    echo "usage: bash scripts/check-spdx.sh [--self-test]" >&2
    exit 2
    ;;
esac

missing="$(mktemp)"
TMP_FILES+=("$missing")

collect_missing "$repo_root" "$missing"
if ! report_missing "$missing" "Missing ${MARKER} in the first ${HEAD_LINES} lines:"; then
  exit 1
fi
echo "SPDX check passed (${SCANNED} files)."

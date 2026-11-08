#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Run from a checkout (CI does this on semgrep/semgrep:1.183.0).
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
bad="/tmp/gg-semgrep-bad.ts"
trap 'rm -f "$bad"' EXIT
cat > "$bad" <<'EOF'
export function bad(geojson: string) {
  return `SELECT ST_GeomFromGeoJSON(${geojson})`;
}
EOF
semgrep scan --config "$root/.semgrep.yml" --error --metrics=off "$root/infra/semgrep/safe-query.ts"
set +e
semgrep scan --config "$root/.semgrep.yml" --error --metrics=off "$bad" >/tmp/gg-semgrep-project.txt 2>&1
project=$?
set -e
if [ "$project" -eq 0 ]; then
  echo "project rule does not match the untagged template; CI still uses it because the stricter rule also matches Prisma \$queryRaw"
else
  echo "project rule matched the untagged template"
fi
semgrep scan --config "$root/infra/semgrep/fixture-rule.yml" --error --metrics=off "$root/infra/semgrep/safe-query.ts"
set +e
semgrep scan --config "$root/infra/semgrep/fixture-rule.yml" --error --metrics=off "$bad"
code=$?
set -e
if [ "$code" -eq 0 ]; then
  echo "fixture rule did not match the untagged template"
  exit 1
fi
echo "semgrep fixtures ok"

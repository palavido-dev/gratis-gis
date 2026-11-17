#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# The CI rule itself must flag an untagged template and stay quiet on
# parameterized Prisma. Run on semgrep/semgrep:1.183.0.
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
bad="/tmp/gg-semgrep-bad.ts"
trap 'rm -f "$bad"' EXIT
cat > "$bad" <<'EOF'
export function bad(geojson: string) {
  return `SELECT ST_GeomFromGeoJSON(${geojson})`;
}
export function badAssign(geojson: string) {
  const sql = `SELECT ST_GeomFromGeoJSON(${geojson})`;
  return sql;
}
export function badConcat(geojson: string) {
  return "SELECT ST_GeomFromGeoJSON(" + geojson + ")";
}
export async function badUnsafe(db: { $queryRawUnsafe: Function }, geojson: string) {
  await db.$queryRawUnsafe(`SELECT ST_GeomFromGeoJSON(${geojson})`);
}
EOF
semgrep scan --config "$root/.semgrep.yml" --error --metrics=off \
  "$root/infra/semgrep/safe-query.ts" \
  "$root/infra/semgrep/prisma-safe.ts"
set +e
semgrep scan --config "$root/.semgrep.yml" --error --metrics=off "$bad"
code=$?
set -e
found="$(semgrep scan --config "$root/.semgrep.yml" --metrics=off --json "$bad" | grep -o '"check_id"' | wc -l)"
if [ "$found" -ne 4 ]; then
  echo "project rule flagged $found of 4 unsafe GeoJSON fixtures"
  exit 1
fi
if [ "$code" -eq 0 ]; then
  echo "project rule did not match the unsafe GeoJSON fixture"
  exit 1
fi
echo "semgrep project rule ok"

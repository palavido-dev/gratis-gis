#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Placeholder for the future get.gratisgis.org one-liner installer.
#
# NOT IMPLEMENTED. This file exists so the URL has something honest
# to serve if it ever goes live early: a previous draft generated
# secrets, installed Docker, and then started a placeholder compose
# file, which would have left a half-installed stack on a stranger's
# server. Refusing loudly is the only safe behaviour until the real
# release-tarball flow ships.
#
# The WORKING installer is infra/install.sh in the repository:
#   curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash
set -euo pipefail

echo "GratisGIS get.gratisgis.org installer: not implemented yet." >&2
echo "" >&2
echo "Use the repository installer instead:" >&2
echo "  curl -fsSL https://raw.githubusercontent.com/palavido-dev/gratis-gis/main/infra/install.sh | bash" >&2
echo "" >&2
echo "Docs: https://github.com/palavido-dev/gratis-gis/blob/main/docs/deployment.md" >&2
exit 1

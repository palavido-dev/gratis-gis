#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Warn on a small machine. Does not change GRATIS_ANALYSIS.
# The implicit default stays on, including point-cloud installs.
set -eu
meminfo="${1:-/proc/meminfo}"
kb="$(awk '/MemAvailable/ {print $2}' "$meminfo" 2>/dev/null || echo 0)"
# 2 GiB available. Below this, analysis containers are the usual OOM.
if [ "${kb:-0}" -gt 0 ] && [ "$kb" -lt 2097152 ]; then
  echo "This machine has under 2 GiB available. Point-cloud analysis stays on unless you set GRATIS_ANALYSIS=off before the first start. That is a choice for this install, not a new default."
  exit 0
fi
echo "Memory is above the small-install warning, or it could not be read. GRATIS_ANALYSIS is unchanged."

#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Older name for infra/bootstrap.sh. install.sh, doctor.sh, and the
# deployment docs call this. Both names run the same script.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap.sh" "$@"

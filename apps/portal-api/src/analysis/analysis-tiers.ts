// SPDX-License-Identifier: AGPL-3.0-or-later
import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * Whether the operator has opted this deployment into the
 * server-heavy analysis tier (`ANALYSIS_TIERS` contains
 * `server-heavy`). Shared by the request gate and portal-info
 * (#225) so a client can pre-flight without attempting a call.
 */
export function isAnalysisEnabled(
  tiersEnv: string | undefined = process.env.ANALYSIS_TIERS,
): boolean {
  return (tiersEnv ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .includes('server-heavy');
}

/**
 * Shared gate for anything that queues work for the analysis /
 * point-cloud worker: only runs where the server-heavy tier is
 * enabled. Refuse with a plain-language 503 rather than queue a job
 * nothing will ever pick up. One implementation so the analysis,
 * point-cloud merge, and imagery-mosaic (#199) paths cannot drift.
 *
 * `activity` is the user-facing phrase for what was refused, e.g.
 * "Server-side analysis" or "Merging lidar tiles".
 */
export function assertServerHeavyTier(
  cfg: ConfigService,
  activity: string,
): void {
  if (!isAnalysisEnabled(cfg.get<string>('ANALYSIS_TIERS'))) {
    throw new ServiceUnavailableException(
      `${activity} is not enabled on this portal. The administrator ` +
        'can enable it by deploying the analysis worker (see infra docs).',
    );
  }
}

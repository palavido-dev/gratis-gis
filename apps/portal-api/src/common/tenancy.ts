// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Logger } from '@nestjs/common';

/**
 * Whether this install serves one organization or many.
 *
 * `single` is the self-hosted default and behaves exactly as before
 * this switch existed. `multi` turns on the hosted (Cloud) behaviour.
 * Only the exact value `multi` selects it: unset, empty, a typo or any
 * other value is `single`, so a mistake never turns Cloud rules on by
 * accident.
 */
export type TenancyMode = 'single' | 'multi';

let cached: TenancyMode | undefined;

function readMode(raw: string | undefined): TenancyMode {
  return raw?.trim().toLowerCase() === 'multi' ? 'multi' : 'single';
}

/**
 * The tenancy mode, read from `GRATIS_TENANCY` on first use and kept
 * for the life of the process. Changing the variable needs a restart.
 */
export function tenancyMode(): TenancyMode {
  if (cached === undefined) cached = readMode(process.env.GRATIS_TENANCY);
  return cached;
}

export function isMultiTenant(): boolean {
  return tenancyMode() === 'multi';
}

/**
 * Read the mode and write it to the log. Each process entry point
 * calls this once at startup so the mode a process runs in is visible
 * in its first lines of output.
 */
export function logTenancyMode(logger: Pick<Logger, 'log'>): TenancyMode {
  const mode = tenancyMode();
  logger.log(`Tenancy mode: ${mode}`);
  return mode;
}

/** Tests only: forget the cached mode so the next read sees the env. */
export function resetTenancyModeForTests(): void {
  cached = undefined;
}

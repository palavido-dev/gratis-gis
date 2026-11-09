// SPDX-License-Identifier: AGPL-3.0-or-later

/** Where the portal sends map address searches, from the environment. */
export interface NominatimTarget {
  /** Base URL to ask first. */
  url: string;
  /**
   * True when no NOMINATIM_URL was set and `url` is the local default.
   * Only then may a failed search fall back to the public service.
   */
  localDefault: boolean;
  /** False when NOMINATIM_PUBLIC_FALLBACK is 0. */
  allowPublic: boolean;
}

export const LOCAL_NOMINATIM = 'http://localhost:8081';

/**
 * Compose passes an unset NOMINATIM_URL as an empty string, so blank
 * counts as unset here.
 */
export function nominatimTarget(
  env: Record<string, string | undefined> = process.env,
): NominatimTarget {
  const configured = env.NOMINATIM_URL?.trim() ?? '';
  return {
    url: configured || LOCAL_NOMINATIM,
    localDefault: configured === '',
    allowPublic: env.NOMINATIM_PUBLIC_FALLBACK?.trim() !== '0',
  };
}

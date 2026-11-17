// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Browser GPS is a secure-context API. Address search is not.
 *
 * `http://192.168.x.x` can call `/api/geocode`. It cannot call
 * `navigator.geolocation`: Chromium reports "Only secure origins are
 * allowed". localhost and https (including Tailscale Serve) are secure
 * contexts. Do not loosen that.
 */

export const INSECURE_GEOLOCATION_MESSAGE =
  'The browser will not share GPS on this plain HTTP address. Address search does not use GPS. Open the portal with HTTPS (on a home NAS, Tailscale Serve with your MagicDNS name).';

export type GeolocationBlock = 'insecure-context' | 'unsupported';

// Default arguments are parsed by SWC. An `in` operator written
// directly in a parameter default is a syntax error there
// ("Expected ',', got 'in'"), which fails `next build`.
function pageIsSecureContext(): boolean | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.isSecureContext;
}

function pageHasGeolocation(): boolean | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return typeof navigator.geolocation !== 'undefined';
}

export function geolocationBlock(
  isSecureContext: boolean | undefined = pageIsSecureContext(),
  hasGeolocation: boolean | undefined = pageHasGeolocation(),
): GeolocationBlock | null {
  if (isSecureContext === false) return 'insecure-context';
  if (hasGeolocation === false) return 'unsupported';
  return null;
}

/** Chrome's message when GPS is called on plain HTTP. */
export function isInsecureGeolocationMessage(message: string | undefined): boolean {
  const text = (message ?? '').toLowerCase();
  return text.includes('secure origin') || text.includes('only secure origins');
}

/**
 * What a watchPosition error means for the watch.
 *
 * Only a refusal (permission denied, or an insecure page) ends the
 * watch. A timeout or a lost signal under canopy is something
 * watchPosition recovers from by itself; clearing the watch on those
 * left the app with no tracking and the old fix still live, so the
 * next one-tap Add dropped the point where the collector used to be.
 * The stale fix is always dropped, so nothing captures at it.
 */
export function geolocationErrorOutcome(
  code: number,
  message: string | undefined,
): {
  status: 'denied' | 'unavailable' | 'error';
  keepWatching: boolean;
  insecure: boolean;
} {
  // GeolocationPositionError codes, fixed by the spec.
  const PERMISSION_DENIED = 1;
  const POSITION_UNAVAILABLE = 2;
  const insecure = isInsecureGeolocationMessage(message);
  if (insecure) return { status: 'unavailable', keepWatching: false, insecure };
  if (code === PERMISSION_DENIED) {
    return { status: 'denied', keepWatching: false, insecure };
  }
  return {
    status: code === POSITION_UNAVAILABLE ? 'unavailable' : 'error',
    keepWatching: true,
    insecure,
  };
}

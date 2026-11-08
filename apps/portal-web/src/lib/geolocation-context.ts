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

export function geolocationBlock(
  isSecureContext: boolean | undefined = typeof window === 'undefined'
    ? undefined
    : window.isSecureContext,
  hasGeolocation: boolean | undefined = typeof navigator === 'undefined'
    ? undefined
    : 'geolocation' in navigator,
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

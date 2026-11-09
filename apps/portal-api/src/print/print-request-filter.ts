// SPDX-License-Identifier: AGPL-3.0-or-later
import { assertSafeOutboundUrl } from '../common/net-guards.js';

/**
 * Which requests the print renderer's Chromium may make.
 *
 * Chromium sits on the internal network beside postgres, MinIO,
 * Keycloak, and portal-api, and the page it renders loads URLs that
 * users author: image elements, basemap styles and tiles, service
 * layers. Without a filter, a print template with an image at
 * http://minio:9000/... or http://169.254.169.254/... makes Chromium
 * fetch it from inside the network and embed the answer in the PDF.
 *
 * Allowed:
 *  - the preview page's own origin (portal-web) and the portal's public
 *    origins, which serve the page, its assets, and the API it calls;
 *  - data: and blob: URLs, which never leave the browser;
 *  - any other http(s) URL that passes the same private-address check
 *    safeFetch applies everywhere else in the API.
 * Everything else is aborted.
 */
export function createPrintRequestFilter(
  trustedBases: ReadonlyArray<string | undefined>,
  check: (url: string) => Promise<unknown> = assertSafeOutboundUrl,
): (url: string) => Promise<boolean> {
  const trusted = new Set<string>();
  for (const base of trustedBases) {
    if (!base) continue;
    try {
      trusted.add(new URL(base).origin);
    } catch {
      // Not a URL; trust nothing for it.
    }
  }
  // One answer per origin per render: a map pulls hundreds of tiles
  // from the same host, and each would otherwise cost a DNS lookup.
  const verdicts = new Map<string, Promise<boolean>>();
  return async (raw: string): Promise<boolean> => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (trusted.has(url.origin)) return true;
    let verdict = verdicts.get(url.origin);
    if (!verdict) {
      verdict = check(url.origin + '/').then(
        () => true,
        () => false,
      );
      verdicts.set(url.origin, verdict);
    }
    return verdict;
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Content Security Policy for custom app runtime pages (review 28b-5).
//
// Every portal page frames only itself (`frame-src 'self' blob:`), so
// an Embed widget pointing at another site showed an empty box. An
// admin now keeps an allow-list of embed sites (Admin > Security), and
// app runtime pages, and only those, add it to frame-src. The
// middleware sets this header; next.config leaves these paths out
// (PAGE_CSP_SOURCE) so its header cannot override it.
import { normalizeEmbedOrigin } from '@gratis-gis/shared-types';

/** /items/:uuid/custom/run and anything under it. */
export const APP_RUNTIME_PATH_RE =
  /^\/items\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/custom\/run(?:\/|$)/i;

/**
 * `pageCsp` with the allowed origins added to its frame-src. Each
 * origin is checked again here, so a bad value from the API can only
 * be dropped, never reach the header.
 */
export function appRuntimeCsp(pageCsp: string, origins: readonly string[]): string {
  const extra: string[] = [];
  for (const o of origins) {
    const n = typeof o === 'string' ? normalizeEmbedOrigin(o) : null;
    if (n && !extra.includes(n)) extra.push(n);
  }
  if (extra.length === 0) return pageCsp;
  return pageCsp
    .split('; ')
    .map((d) => (d.startsWith('frame-src ') ? `${d} ${extra.join(' ')}` : d))
    .join('; ');
}

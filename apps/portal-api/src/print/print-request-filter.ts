// SPDX-License-Identifier: AGPL-3.0-or-later
import { safeFetch, type SafeFetchOptions } from '../common/net-guards.js';

/**
 * Which requests the print renderer's Chromium may make, and how.
 *
 * Chromium sits on the internal network beside postgres, MinIO,
 * Keycloak, and portal-api, and the page it renders loads URLs that
 * users author: image elements, basemap styles and tiles, service
 * layers. Without a filter, a print template with an image at
 * http://minio:9000/... or http://169.254.169.254/... makes Chromium
 * fetch it from inside the network and embed the answer in the PDF.
 *
 * Decisions:
 *  - `continue`: the preview page's own origin (portal-web) and the
 *    portal's public origins, which serve the page, its assets, and
 *    the API it calls; data: and blob: URLs, which never leave the
 *    browser.
 *  - `fetch`: any other http(s) URL. portal-api fetches it through
 *    safeFetch, which resolves the name once, refuses private
 *    addresses, and dials the address it checked. Chromium gets the
 *    answer through request.respond() and never resolves the name
 *    itself. Checking the name here and letting Chromium resolve it
 *    again would let a host that answers public first and private
 *    second (DNS rebinding) through.
 *  - `abort`: everything else.
 */
export type PrintRequestDecision = 'continue' | 'fetch' | 'abort';

export function createPrintRequestFilter(
  trustedBases: ReadonlyArray<string | undefined>,
): (url: string) => PrintRequestDecision {
  const trusted = new Set<string>();
  for (const base of trustedBases) {
    if (!base) continue;
    try {
      trusted.add(new URL(base).origin);
    } catch {
      // Not a URL; trust nothing for it.
    }
  }
  return (raw: string): PrintRequestDecision => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'abort';
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return 'continue';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'abort';
    if (trusted.has(url.origin)) return 'continue';
    return 'fetch';
  };
}

/** The parts of a Puppeteer HTTPRequest this module uses. */
export interface InterceptedRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  postData(): string | undefined;
  continue(): Promise<void>;
  abort(reason: 'blockedbyclient'): Promise<void>;
  respond(response: {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }): Promise<void>;
}

type Fetcher = (
  url: string,
  init: RequestInit,
  options: SafeFetchOptions,
) => Promise<Response>;

/** One resource on a printed page: a tile, an image, a style. */
const PRINT_RESOURCE_MAX_BYTES = 50 * 1024 * 1024;

const PROXIED_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);

/** Request headers never sent on to a third-party host. */
const DROP_REQUEST_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'host',
  'connection',
  'content-length',
]);

/**
 * Response headers not handed back to Chromium. The body is already
 * decoded and buffered, so length and encoding no longer describe it,
 * and a third-party cookie has no business in the print session.
 */
const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

/**
 * Answer one intercepted request according to the filter. Never
 * throws: a failure aborts that one request so the render goes on.
 */
export async function answerPrintRequest(
  request: InterceptedRequest,
  decide: (url: string) => PrintRequestDecision,
  fetcher: Fetcher = safeFetch,
): Promise<void> {
  const decision = decide(request.url());
  try {
    if (decision === 'continue') {
      await request.continue();
      return;
    }
    const method = request.method().toUpperCase();
    if (decision === 'abort' || !PROXIED_METHODS.has(method)) {
      await request.abort('blockedbyclient');
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers())) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    const init: RequestInit = { method, headers };
    const body = request.postData();
    if (body !== undefined && method === 'POST') init.body = body;
    const res = await fetcher(request.url(), init, {
      maxBytes: PRINT_RESOURCE_MAX_BYTES,
    });
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) out[key] = value;
    });
    const buf = Buffer.from(await res.arrayBuffer());
    await request.respond({ status: res.status, headers: out, body: buf });
  } catch {
    await request.abort('blockedbyclient').catch(() => undefined);
  }
}

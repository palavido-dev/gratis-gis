// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response as ExpressResponse } from 'express';

/**
 * Shared timeout for the server-side proxy fetches (item proxy,
 * public proxy, service probe). These bridge external map-service
 * tiles and metadata, which return quickly; a fetch that has not
 * produced a response in this long is a dead or black-holing
 * upstream, and holding the request open only piles up sockets.
 */
export const PROXY_FETCH_TIMEOUT_MS = 30_000;

/**
 * Default ceiling for a proxied response body. The proxies exist to
 * relay tiles and capabilities documents, which are small; a
 * multi-GB body is a misconfigured item or a hostile upstream, and
 * buffering it whole would be a memory-exhaustion vector. 64 MB is
 * far above any legitimate tile or metadata response.
 */
export const DEFAULT_MAX_PROXY_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling for a probe that has to hold the upstream body in memory
 * to parse it as JSON. Capabilities documents are small; a multi-GB
 * 200 from a hostile or misconfigured URL is the exhaustion case the
 * streaming proxies already refuse. 8 MB is far above a real service
 * description and far below a replica's heap.
 */
export const PROBE_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Thrown when an upstream body crosses the byte ceiling mid-read. */
export class UpstreamBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Upstream response exceeded ${maxBytes} bytes`);
    this.name = 'UpstreamBodyTooLargeError';
  }
}

/**
 * Same-origin script surface of a proxied response.
 *
 * The item and public proxies relay whatever an item's `data.url`
 * answers, and any contributor sets that URL. They are served from the
 * portal origin, so an upstream that answers `text/html` (or XHTML,
 * SVG, or XML with an XHTML-namespace script) would run its script with
 * the viewer's portal session. Legitimate consumers are map libraries
 * that read the body with fetch or as an image, so none of them needs
 * the browser to render the response as a document.
 *
 * Every proxied response therefore gets:
 * - `Content-Security-Policy: sandbox; default-src 'none'`, so a
 *   document that does render has an opaque origin and no scripts.
 * - `X-Content-Type-Options: nosniff`.
 * - `Content-Disposition: attachment` unless the type is on the
 *   inline allowlist below, so a top-level navigation downloads it.
 * Script types are also relabelled `text/plain`, which nosniff then
 * refuses to execute from a `<script src>` on the portal origin.
 */
/**
 * Types a proxied response may render inline: what map clients read
 * with fetch or as an image. Everything else (HTML, XML, SVG, PDF,
 * multipart, unknown, or no type at all) is sent as an attachment, so
 * a top-level navigation downloads it instead of rendering it. An
 * allowlist rather than a denylist, because there is always one more
 * renderable type.
 */
const INLINE_MEDIA = new Set([
  'text/plain',
  'text/csv',
  'application/json',
  'application/geo+json',
  'application/vnd.geo+json',
  'application/x-protobuf',
  'application/vnd.mapbox-vector-tile',
  'application/octet-stream',
]);
const SCRIPT_MEDIA =
  /^[a-z]+\/(x-)?(javascript|ecmascript|jscript|livescript)[\d.]*$|^application\/wasm$/;

function mayRenderInline(media: string): boolean {
  if (INLINE_MEDIA.has(media)) return true;
  // Raster images; SVG is a document that can carry script.
  return /^image\/[a-z0-9.+-]+$/.test(media) && media !== 'image/svg+xml';
}

export function applyProxyResponseHeaders(
  res: Pick<ExpressResponse, 'setHeader'>,
  upstreamContentType: string | null,
): void {
  res.setHeader('content-security-policy', "sandbox; default-src 'none'");
  res.setHeader('x-content-type-options', 'nosniff');
  const raw = upstreamContentType ?? '';
  // fetch joins repeated Content-Type headers with a comma, and a
  // browser uses the last one, so `text/plain, text/html` would render
  // as HTML. Any comma makes the type untrusted.
  const media = raw.includes(',')
    ? ''
    : (raw.split(';')[0]?.trim().toLowerCase() ?? '');
  if (SCRIPT_MEDIA.test(media)) {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', 'attachment');
    return;
  }
  if (upstreamContentType) res.setHeader('content-type', upstreamContentType);
  if (!mayRenderInline(media)) {
    res.setHeader('content-disposition', 'attachment');
  }
}

/**
 * Stream an upstream fetch Response to an Express response with a
 * hard byte ceiling and real backpressure, instead of buffering the
 * entire body in memory with `arrayBuffer()`.
 *
 * Content-length is deliberately NOT forwarded: Node's fetch
 * transparently decompresses gzip / br, so the upstream's byte count
 * describes the compressed payload while the bytes we emit are
 * decompressed. Letting the transfer be chunked from what we
 * actually write avoids the truncation-mid-document bug a forwarded,
 * wrong content-length caused.
 *
 * If the client disconnects mid-stream we cancel the upstream reader
 * so its socket returns to the pool rather than idling until timeout,
 * which is the abort-churn failure mode that pans/zooms over tiles
 * would otherwise cause.
 */
export async function streamUpstreamToResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  opts?: { maxBytes?: number },
): Promise<void> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_PROXY_BYTES;
  res.status(upstream.status);
  applyProxyResponseHeaders(res, upstream.headers.get('content-type'));

  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }

  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Over budget. Headers are already on the wire, so a clean
        // 502 is no longer possible; the honest move is to stop
        // reading and cut the connection so the client sees an
        // aborted transfer rather than us OOM-ing to satisfy it.
        await reader.cancel();
        res.destroy();
        return;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      // Respect socket backpressure so a slow client cannot make us
      // buffer the whole body in the writable queue.
      if (!res.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            res.off('drain', onDrain);
            res.off('close', onClose);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            reject(new Error('client closed'));
          };
          res.once('drain', onDrain);
          res.once('close', onClose);
        });
      }
    }
    res.end();
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* already released */
    }
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
}

/**
 * Read an upstream body as text, stopping as soon as it exceeds
 * `maxBytes`. `Response.text()` buffers the whole payload first, so a
 * probe that used it would hold a multi-GB body on a single 200. This
 * cancels the reader at the ceiling and throws instead.
 */
export async function readUpstreamText(
  upstream: globalThis.Response,
  maxBytes: number,
): Promise<string> {
  const body = upstream.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new UpstreamBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (!(err instanceof UpstreamBodyTooLargeError)) {
      try {
        await reader.cancel();
      } catch {
        /* already released */
      }
    }
    throw err;
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
  ).toString('utf8');
}

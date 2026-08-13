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
const DEFAULT_MAX_PROXY_BYTES = 64 * 1024 * 1024;

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
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);

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

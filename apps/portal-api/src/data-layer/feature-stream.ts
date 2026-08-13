// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response } from 'express';

/**
 * Await a writable's `drain` when `res.write` has signalled
 * backpressure, resolving on drain and rejecting if the client
 * disconnects (so a streaming loop stops rather than hanging on a
 * drain that will never come).
 */
export function onceDrain(res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client closed'));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

/**
 * Stream a GeoJSON FeatureCollection to the response from an async
 * iterator of feature batches, instead of buffering the whole
 * collection in memory and serialising it in one synchronous
 * `JSON.stringify`. The emitted bytes are identical to
 * `JSON.stringify({ type: 'FeatureCollection', features })`, just
 * produced incrementally with socket backpressure, so a very large
 * (or unbounded) public layer can no longer OOM a replica.
 *
 * The first batch is pulled BEFORE any bytes are written, so a query
 * error (bad filter, missing scope) still surfaces as a normal error
 * response through Nest's exception filter rather than as a truncated
 * 200 body. A failure after the first batch can only end the
 * (now-invalid) stream; the client's JSON parse then fails, which is
 * the honest signal that the read did not complete.
 */
export async function streamFeatureCollection(
  res: Response,
  batches: AsyncIterable<unknown[]>,
): Promise<void> {
  const iterator = batches[Symbol.asyncIterator]();
  // May throw; headers are not sent yet, so it propagates cleanly.
  let step = await iterator.next();

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.write('{"type":"FeatureCollection","features":[');
  let first = true;
  try {
    while (!step.done) {
      let chunk = '';
      for (const feature of step.value) {
        if (!first) chunk += ',';
        chunk += JSON.stringify(feature);
        first = false;
      }
      if (chunk && !res.write(chunk)) {
        await onceDrain(res);
      }
      step = await iterator.next();
    }
    res.write(']}');
    res.end();
  } catch {
    // Headers are already out; end the truncated body and let the
    // iterator release its DB cursor.
    try {
      res.end();
    } catch {
      /* already closed */
    }
    try {
      await iterator.return?.(undefined);
    } catch {
      /* best effort */
    }
  }
}

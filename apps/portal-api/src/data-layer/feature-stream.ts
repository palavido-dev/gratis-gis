// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Response } from 'express';

import {
  FeatureQueryBudgetError,
  type FeatureStreamBudget,
  featureStreamBudget,
} from './feature-paging.js';

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
  budget: FeatureStreamBudget = featureStreamBudget(),
): Promise<void> {
  const iterator = batches[Symbol.asyncIterator]();
  const started = Date.now();
  let written = 0;
  const charge = (text: string) => {
    written += Buffer.byteLength(text);
    if (budget.maxBytes != null && written > budget.maxBytes) {
      throw new FeatureQueryBudgetError();
    }
    if (budget.maxMs != null && Date.now() - started > budget.maxMs) {
      throw new FeatureQueryBudgetError();
    }
  };
  // May throw; headers are not sent yet, so it propagates cleanly.
  let step = await iterator.next();
  let firstChunk = '';
  let first = true;
  if (!step.done) {
    for (const feature of step.value) {
      if (!first) firstChunk += ',';
      firstChunk += JSON.stringify(feature);
      first = false;
    }
    charge(firstChunk);
  }
  const opening = '{"type":"FeatureCollection","features":[';
  charge(opening);

  res.setHeader('content-type', 'application/json; charset=utf-8');
  let headersOut = false;
  try {
    if (!res.write(opening)) await onceDrain(res);
    headersOut = true;
    if (firstChunk && !res.write(firstChunk)) await onceDrain(res);
    if (!step.done) step = await iterator.next();
    while (!step.done) {
      let chunk = '';
      for (const feature of step.value) {
        if (!first) chunk += ',';
        chunk += JSON.stringify(feature);
        first = false;
      }
      charge(chunk);
      if (chunk && !res.write(chunk)) await onceDrain(res);
      step = await iterator.next();
    }
    const close = ']}';
    charge(close);
    res.write(close);
    res.end();
  } catch (err) {
    if (!headersOut) throw err;
    // Headers are already out. Do not write the closing bytes: a
    // complete FeatureCollection would look like a successful read.
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
    throw err;
  }
}

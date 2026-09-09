// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request, Response } from 'express';

/**
 * An AbortSignal that fires when the client hangs up before the
 * response is finished. Express fires `close` on the request for a
 * completed response too, so the abort is gated on the response not
 * having ended; a signal that fired after a normal 200 would tell a
 * compute to stop for a client that got its answer.
 *
 * For handlers whose work can outlive the request that asked for it:
 * an aggregate queued behind other aggregates has no business running
 * once the dashboard that wanted it has panned away.
 */
export function requestAbortSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

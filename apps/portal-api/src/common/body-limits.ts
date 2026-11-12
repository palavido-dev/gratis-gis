// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Largest JSON request body the API accepts.
 *
 * Express's default is 100 KB, and nothing raised it, so an item save
 * past that failed with 413 "request entity too large". A data layer
 * with around 80 related tables sends its whole schema in one item
 * save and crossed it (#679). So did a single feature edit carrying a
 * very detailed polygon. 10 MB covers both with room to spare while
 * still bounding what one request can make a replica buffer. File
 * uploads do not come through here; they are multipart and capped in
 * Caddy.
 */
export const JSON_BODY_LIMIT = '10mb';

/**
 * JSON body limit for the script executor. The claimer posts a whole
 * script source (capped at 256 KB) as a JSON string, so escaped
 * quotes and newlines can roughly double it. 2 MB leaves room.
 */
export const EXECUTOR_JSON_BODY_LIMIT = '2mb';

/**
 * Register the JSON parser with our limit. Must run before the app
 * initialises: Nest then sees a parser named jsonParser already in
 * place and skips its own 100 KB one.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}

/**
 * How long a non-upload request may take to arrive in full.
 *
 * main.ts turns Node's own requestTimeout off so a large multipart
 * import on a slow link is not cut at 300 s. That switch is server
 * wide, so without this a caller could start a JSON body on any route
 * and stall, holding the connection and its buffered body forever.
 * The JSON parser runs before the auth guards, so no sign-in is
 * needed to do it.
 */
export const BODY_READ_TIMEOUT_MS = 300_000;

/**
 * Drop a request whose body has not fully arrived within `ms`.
 * Multipart uploads are exempt: they are the reason requestTimeout
 * is off. Must be registered before the body parsers. A request that
 * has arrived in full is never touched, however long its handler
 * runs.
 */
export function bodyReadDeadline(ms: number = BODY_READ_TIMEOUT_MS) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const type = req.headers['content-type'] ?? '';
    if (req.complete || type.toLowerCase().startsWith('multipart/')) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (!req.complete) req.destroy();
    }, ms);
    timer.unref();
    const clear = (): void => clearTimeout(timer);
    req.once('end', clear);
    res.once('close', clear);
    next();
  };
}

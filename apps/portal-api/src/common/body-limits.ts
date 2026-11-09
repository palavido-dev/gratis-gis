// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * Register the JSON parser with our limit. Must run before the app
 * initialises: Nest then sees a parser named jsonParser already in
 * place and skips its own 100 KB one.
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}

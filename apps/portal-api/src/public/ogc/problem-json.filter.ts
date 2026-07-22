// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';

/**
 * RFC 7807 problem+json filter scoped to the OGC API surface. The
 * portal's default Nest filter returns plain JSON with a `message`
 * field, which is fine for portal clients but doesn't match what
 * OGC-compliant tools expect when an endpoint errors. This filter
 * reshapes any `HttpException` thrown from `/api/public/ogc/*` into
 * the standard `application/problem+json` envelope:
 *
 *   {
 *     "type": "https://gratisgis.org/errors/<slug>",
 *     "title": "...",
 *     "status": <code>,
 *     "detail": "...",
 *     "instance": "<request path>"
 *   }
 *
 * The slug is derived from the exception message so common shapes
 * (collection-not-found, feature-not-found, invalid-bbox) get
 * stable type URIs that clients can match on. Unknown exceptions
 * fall back to an `internal` slug; non-OGC paths keep the default
 * filter unchanged.
 *
 * Scope: this filter is registered globally but only rewrites the
 * response when the request URL starts with `/api/public/ogc/` -
 * other surfaces (portal, public catalog, public features v1) keep
 * the existing envelope. That avoids breaking any client that
 * already parses the portal's plain-JSON error shape.
 */
@Catch()
export class OgcProblemJsonFilter extends BaseExceptionFilter {
  private readonly log = new Logger(OgcProblemJsonFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Out-of-scope paths: delegate to Nest's base filter so they
    // keep the standard plain-JSON envelope (#197). The previous
    // code THREW here on the assumption Nest's default handler
    // would pick the exception back up; it does not. An exception
    // thrown from inside an exception filter escapes Nest entirely
    // and lands in Express's default error handler, which renders
    // a bare HTML page. Net effect: from the day this filter
    // shipped, every error on every non-OGC route came back as
    // text/html with no message, which clients then surfaced as
    // unreadable raw markup.
    const url = req.originalUrl ?? req.url ?? '';
    if (!url.startsWith('/api/public/ogc/') && url !== '/api/public/ogc') {
      super.catch(exception, host);
      return;
    }

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail: string;
    let title = 'Internal Server Error';
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const b = body as { message?: unknown; error?: unknown };
        detail = typeof b.message === 'string'
          ? b.message
          : Array.isArray(b.message)
            ? b.message.join('; ')
            : exception.message;
        if (typeof b.error === 'string') title = b.error;
      } else {
        detail = exception.message;
      }
      // Default title comes from the status text; fall back to it
      // when the body didn't carry an explicit error name.
      if (title === 'Internal Server Error') {
        title = statusTitle(status);
      }
    } else {
      detail = exception instanceof Error ? exception.message : String(exception);
      this.log.error(
        `Unhandled exception on ${req.method} ${url}: ${detail}`,
      );
    }

    const slug = slugForOgcError(status, detail);
    res
      .status(status)
      .type('application/problem+json')
      .send({
        type: `https://gratisgis.org/errors/${slug}`,
        title,
        status,
        detail,
        instance: url,
      });
  }
}

function statusTitle(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 405: return 'Method Not Allowed';
    case 409: return 'Conflict';
    case 415: return 'Unsupported Media Type';
    case 422: return 'Unprocessable Entity';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 503: return 'Service Unavailable';
    default: return 'Error';
  }
}

/**
 * Derive a stable slug from the error detail so OGC clients can
 * match a `type` URI without parsing the prose detail string. The
 * mapping is best-effort + additive: when a future endpoint throws
 * a new exception class with a recognisable phrase, add it here so
 * its type URI stabilises.
 */
function slugForOgcError(status: number, detail: string): string {
  const d = detail.toLowerCase();
  if (status === 404) {
    if (d.includes('collection')) return 'collection-not-found';
    if (d.includes('feature')) return 'feature-not-found';
    if (d.includes('style')) return 'style-not-found';
    if (d.includes('record')) return 'record-not-found';
    if (d.includes('tile')) return 'tile-not-found';
    return 'not-found';
  }
  if (status === 400) {
    if (d.includes('bbox')) return 'invalid-bbox';
    if (d.includes('crs')) return 'invalid-crs';
    if (d.includes('sortby') || d.includes('sort-by')) return 'invalid-sortby';
    if (d.includes('limit') || d.includes('offset')) return 'invalid-paging';
    return 'invalid-request';
  }
  if (status === 415) return 'unsupported-media-type';
  if (status >= 500) return 'internal';
  return `status-${status}`;
}

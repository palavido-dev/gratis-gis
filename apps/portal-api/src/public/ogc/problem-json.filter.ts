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
import {
  callerIsAdmin,
  portalErrorBody,
  requestIdOf,
} from '../../common/public-error.js';

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
 * fall back to an `internal` slug. Non-OGC paths keep that same
 * plain-JSON shape, plus a `requestId`, instead of Nest's default
 * filter: this filter is global, so it has to write those
 * responses itself.
 *
 * Scope: problem+json is only for URLs under `/api/public/ogc/`.
 * Other surfaces (portal, public catalog, public features v1) keep
 * the plain-JSON envelope. That avoids breaking any client that
 * already parses it. Stack traces stay in the log. An admin may
 * also receive one redacted line; everyone else gets the status
 * and the request id.
 */
@Catch()
export class OgcProblemJsonFilter extends BaseExceptionFilter {
  private readonly log = new Logger(OgcProblemJsonFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Out-of-scope paths keep the plain-JSON envelope (#197) and
    // gain a request id. This filter must write that response
    // itself. Throwing here does not fall through to Nest's default
    // filter: it escapes to Express, which renders a bare HTML page,
    // and the browser then has no message to show.
    const url = req.originalUrl ?? req.url ?? '';
    if (!url.startsWith('/api/public/ogc/') && url !== '/api/public/ogc') {
      this.replyPortal(exception, req, res);
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
      // An unexpected error's message is internal: a Prisma raw query
      // error carries its SQL and Postgres message, a connection
      // error names the database host. This surface is anonymous, so
      // it gets the same answer the portal surface gives: a fixed
      // detail and a request id. The stack goes to the log.
      const requestId = requestIdOf(req);
      const path = url.split('?')[0];
      const stack =
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception);
      this.log.error(`requestId=${requestId} ${req.method} ${path} ${stack}`);
      detail = `Internal server error (request id ${requestId})`;
    }

    if (res.headersSent) {
      res.end();
      return;
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
        instance: url.split('?')[0],
      });
  }

  /**
   * Plain JSON for portal routes. Unexpected failures are logged
   * with the request id and answered without a stack. The query
   * string is left out of the log line because it can carry a token.
   */
  private replyPortal(exception: unknown, req: Request, res: Response): void {
    const requestId = requestIdOf(req);
    const { status, body } = portalErrorBody(exception, {
      requestId,
      admin: callerIsAdmin(req),
    });
    if (status >= 500) {
      const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
      const stack =
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception);
      this.log.error(`requestId=${requestId} ${req.method} ${path} ${stack}`);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json(body);
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

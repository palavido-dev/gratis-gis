// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

/**
 * An error with Esri's own code, where it differs from the HTTP
 * status: 498 (invalid token) and 499 (token required) make ArcGIS
 * Pro ask the user to sign in.
 */
export class EsriHttpError extends HttpException {
  constructor(
    status: number,
    readonly esriCode: number,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message, status);
  }
}

/** Sign-in is needed: the layer is not public, or the edit needs a user. */
export function tokenRequired(): EsriHttpError {
  return new EsriHttpError(401, 499, 'Token Required');
}

/** The token sent is bad, expired, or its API key was revoked. */
export function invalidToken(): EsriHttpError {
  return new EsriHttpError(401, 498, 'Invalid Token');
}

/**
 * Errors from the FeatureServer interface in the shape Esri clients
 * read: `{"error":{"code":..,"message":..,"details":[]}}`. The HTTP
 * status is the real one, so proxies, logs and the isolation suite see
 * a 404 as a 404; ArcGIS Pro and QGIS show the message either way.
 */
@Catch()
export class EsriErrorFilter implements ExceptionFilter {
  private readonly log = new Logger(EsriErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let code = 500;
    let details: string[] = [];
    let message = 'The server could not answer this request.';
    if (exception instanceof EsriHttpError) {
      status = exception.getStatus();
      code = exception.esriCode;
      details = exception.details;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const m = (body as { message?: unknown }).message;
        message = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : exception.message;
      }
      code = status;
    } else {
      this.log.error(
        `FeatureServer request failed: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`,
      );
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code, message, details } });
  }
}

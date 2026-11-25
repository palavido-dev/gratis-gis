// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

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
    let message = 'The server could not answer this request.';
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const m = (body as { message?: unknown }).message;
        message = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : exception.message;
      }
    } else {
      this.log.error(
        `FeatureServer request failed: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`,
      );
    }
    if (res.headersSent) return;
    res.status(status).json({ error: { code: status, message, details: [] } });
  }
}

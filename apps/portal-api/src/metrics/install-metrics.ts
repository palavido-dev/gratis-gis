// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  FailedAuthLimiter,
  MIN_METRICS_TOKEN_LENGTH,
  bearerMatches,
  readMetricsToken,
} from './metrics-auth.js';
import {
  methodLabel,
  routeTemplate,
  statusClassLabel,
  tileKindOf,
  tileSurfaceOf,
} from './http-labels.js';
import { MetricsService } from './metrics.service.js';

export const METRICS_PATH = '/metrics';

/**
 * Times every request and records it under its route template once the
 * response is done. Express sets `req.route` while dispatching, so it
 * is read in the finish handler, not here. The metrics route itself is
 * left out so scrapes do not show up in the numbers they report.
 */
export function httpMetricsMiddleware(metrics: MetricsService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const route = routeTemplate(req);
      if (route === METRICS_PATH) return;
      const status_class = res.writableFinished
        ? statusClassLabel(res.statusCode)
        : 'aborted';
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.observeHttp(
        { method: methodLabel(req.method), route, status_class },
        seconds,
      );
      const kind = tileKindOf(route);
      if (kind) {
        metrics.countTile({ kind, surface: tileSurfaceOf(route), status_class });
      }
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

/**
 * GET /metrics. Answers only `Authorization: Bearer <METRICS_TOKEN>`;
 * anything else is 401 with no body, and a client that keeps guessing
 * gets 429 for the rest of the minute.
 *
 * Mounted on Express directly instead of as a Nest controller so the
 * global JWT guard never sees the metrics token (it would try to verify
 * it as a Keycloak JWT) and the route sits outside the /api prefix,
 * which keeps it off every Caddy route the stacks ship.
 */
export function metricsHandler(
  metrics: MetricsService,
  token: string,
  limiter = new FailedAuthLimiter(),
): RequestHandler {
  return (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    // The socket peer, not req.ip: scrapers connect directly, and with
    // `trust proxy` set req.ip would come from X-Forwarded-For, which a
    // caller on the docker network can write to dodge the limit.
    const client = req.socket.remoteAddress ?? 'unknown';
    if (limiter.blocked(client)) {
      res.status(429).setHeader('Retry-After', '60').end();
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      limiter.recordMiss(client);
      res.status(401).setHeader('WWW-Authenticate', 'Bearer').end();
      return;
    }
    metrics.render().then(
      (body) => {
        res.status(200).setHeader('Content-Type', metrics.contentType);
        res.end(body);
      },
      () => {
        res.status(500).end();
      },
    );
  };
}

/**
 * Switch metrics on for this process when METRICS_TOKEN is set. Call
 * after NestFactory.create and before listen(), so the middleware and
 * the route land ahead of Nest's own router. Without the token nothing
 * is installed and GET /metrics falls through to Nest's normal 404.
 */
export function installMetrics(
  app: INestApplication,
  env: string | undefined = process.env.METRICS_TOKEN,
): boolean {
  const log = new Logger('Metrics');
  const setting = readMetricsToken(env);
  if (!setting.enabled) {
    if (setting.reason === 'too_short') {
      log.warn(
        `METRICS_TOKEN is shorter than ${MIN_METRICS_TOKEN_LENGTH} characters, so /metrics stays off. Generate one with: openssl rand -hex 32`,
      );
    }
    return false;
  }
  const metrics = app.get(MetricsService);
  metrics.enable();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const express = app.getHttpAdapter().getInstance() as any;
  express.use(httpMetricsMiddleware(metrics));
  express.get(METRICS_PATH, metricsHandler(metrics, setting.token));
  log.log(`Prometheus metrics enabled at ${METRICS_PATH} (bearer token required)`);
  return true;
}

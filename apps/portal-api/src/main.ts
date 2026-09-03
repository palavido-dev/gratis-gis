// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { corsOptionsFor, parseAllowedOrigins } from './common/cors.js';

// Process-level safety net (#117). Node >= 16 exits the process on an
// uncaughtException OR an unhandledRejection by default; in prod that
// has manifested as both portal-api replicas crash-looping when a
// guard / strategy throws synchronously outside the normal Nest
// exception filter. Log + continue so a single bad request can never
// take the whole worker down. This intentionally does NOT call
// process.exit: Nest's exception filter already handles request-scope
// errors, and anything that escapes to here is already past the point
// where the response could be salvaged for THAT request, but the
// process state is still recoverable for everyone else.
const processLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  const detail =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  processLogger.error(`Unhandled promise rejection (kept worker alive): ${detail}`);
});
process.on('uncaughtException', (err) => {
  processLogger.error(
    `Uncaught exception (kept worker alive): ${err.stack ?? err.message}`,
  );
});

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Per-route CORS: the open-data surface (/api/public/*, /health)
  // answers any origin read-only; everything else answers only the
  // origins in CORS_ALLOWED_ORIGINS, which defaults to none. The
  // portal's own browser traffic is same-origin in prod (Caddy) and
  // BFF-proxied in dev, so it needs no entry. See common/cors.ts.
  const corsLogger = new Logger('Cors');
  const allowedOrigins = parseAllowedOrigins(
    process.env.CORS_ALLOWED_ORIGINS,
    (entry) =>
      corsLogger.warn(
        `Ignoring CORS_ALLOWED_ORIGINS entry that is not an origin: ${entry}`,
      ),
  );
  if (allowedOrigins.length > 0) {
    corsLogger.log(`Cross-origin callers allowed: ${allowedOrigins.join(', ')}`);
  }
  app.enableCors((req, cb) => cb(null, corsOptionsFor(req, allowedOrigins)));
  // Don't advertise the Express framework over the wire.  The
  // default `x-powered-by: Express` header is informational only,
  // but it hands an attacker exact version targeting.
  app.disable('x-powered-by');
  // Trust exactly one proxy hop: Caddy, which is the only thing that
  // ever talks to this process in the shipped topology.
  //
  // Without this, `req.ip` is the connection peer, i.e. Caddy's own
  // container address on every request, so ThrottlerGuard (whose
  // default tracker is literally `req.ip`) put the entire internet in
  // ONE bucket per route. That is broken in both directions at once: a
  // single abusive client exhausts the budget for every other visitor,
  // and no individual client is ever limited.
  //
  // `1` and not `true`: Caddy APPENDS the real peer to X-Forwarded-For
  // rather than replacing it, so with one trusted hop Express reads the
  // rightmost entry, which Caddy wrote. `true` would take the leftmost,
  // which is whatever the caller sent, and would hand out a fresh
  // rate-limit budget per forged header. That is the same trap
  // feedback.controller.ts documents for its own clientIp() (#0.9.13);
  // keep the two consistent if the proxy topology ever changes.
  app.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['/health', '/docs'] });

  // Swagger UI is useful in dev and CI but exposes the full API
  // surface (endpoints, schemas, request shapes) to anyone who
  // hits /docs in production.  Gate behind ENABLE_SWAGGER so prod
  // ships without it and local dev opt-ins via NODE_ENV=development
  // (the dev compose sets this implicitly).
  const enableSwagger =
    process.env.ENABLE_SWAGGER === '1' ||
    process.env.NODE_ENV !== 'production';
  if (enableSwagger) {
    const swagger = new DocumentBuilder()
      .setTitle('GratisGIS Portal API')
      .setDescription('Users, groups, items, sharing, and feature services.')
      .setVersion('0.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`portal-api listening on http://localhost:${port}`);
}

bootstrap();

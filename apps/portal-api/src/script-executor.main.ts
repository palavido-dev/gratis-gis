// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';

import { ScriptExecutorAppModule } from './script-executor.module.js';

/**
 * script-executor entry point (#221).
 *
 * The process that actually runs user Python, and the only one. It is
 * split from the claimer for exactly one reason: the claimer needs the
 * database to pick up work, and anything that needs the database has
 * to sit on a network where the database is reachable. Put those in
 * one container and the script inherits that reachability.
 *
 * Measured, not assumed. A probe script on the single-container design
 * opened sockets to postgres:5432, minio:9000, and keycloak:8080. It
 * had no credentials for any of them, but "needs a password" is a
 * weaker property than "cannot open the socket", and only one of those
 * survives a protocol-level CVE.
 *
 * So: this process has no DATABASE_URL, no object-storage keys, and no
 * Keycloak secret, and its container joins only the network carrying
 * the claimer and portal-api. A script can still reach the portal's
 * public API (which is the point) and the internet (which the
 * refresh-from-a-county-endpoint case needs), and nothing else of ours.
 *
 * Listens on plain HTTP inside that network. Never exposed through
 * Caddy, never given a published port.
 */
async function bootstrap() {
  const log = new Logger('ScriptExecutor');
  const app = await NestFactory.create(ScriptExecutorAppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  // A run can be the full timeout long, so the request body/response can
  // legitimately take an hour: disable requestTimeout, and let the
  // executor's own per-run timer be the authority on run duration.
  //
  // But headersTimeout stays finite. It only bounds how long a client
  // may take to send the request HEADERS, which is never legitimately
  // slow, and disabling it lets a caller on the script network hold
  // sockets open indefinitely (a slowloris) against the single executor.
  // The claimer sends headers immediately, so a few seconds is ample.
  const port = Number(process.env.SCRIPT_EXECUTOR_PORT ?? 4100);
  const server = await app.listen(port, '0.0.0.0');
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;

  if (!process.env.SCRIPT_EXECUTOR_TOKEN) {
    // Loud, and it still starts: the controller refuses every request
    // without the token, so the failure is visible in one place rather
    // than as a container that will not boot.
    log.error(
      'SCRIPT_EXECUTOR_TOKEN is not set. Every execute request will be refused.',
    );
  }
  log.log(`script executor listening on ${port}`);
}

void bootstrap();

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CLI for docker-entrypoint.sh:
 *
 *   node dist/startup-status.main.js <phase> [log file]
 *
 * With a log file, its last lines go on the page (secrets removed).
 * Always exits 0: a status write must never change how startup goes.
 */
import { readFileSync } from 'node:fs';

import { STARTUP_PHASES, type StartupPhase, writeStartupStatus } from './startup-status.js';

const [phase, logFile] = process.argv.slice(2);
if (phase && (STARTUP_PHASES as readonly string[]).includes(phase)) {
  let log: string | undefined;
  if (logFile) {
    try {
      log = readFileSync(logFile, 'utf8');
    } catch {
      log = undefined;
    }
  }
  writeStartupStatus(phase as StartupPhase, { log });
}

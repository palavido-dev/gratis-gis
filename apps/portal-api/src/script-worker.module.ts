// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { LeaderElectionModule } from './cron/leader-election.module.js';
import { ScriptsModule } from './scripts/scripts.module.js';

/**
 * Module graph for the script-runner process (#221).
 *
 * In its own file, separate from the entry point, so the boot-time DI
 * spec can compile it. It previously lived inline in
 * script-worker.main.ts, which the spec cannot import because that
 * file calls bootstrap() at module scope. The result was a third
 * bootable graph that nothing checked, and it crash-looped on first
 * deploy for exactly the reason app.module.spec.ts exists.
 *
 * LeaderElectionModule is here to satisfy dependency injection, not
 * because this process leads anything. ScriptsModule imports
 * ItemsModule, which reaches NotificationsModule, whose worker takes
 * a LeaderElectionService. Nest instantiates that provider at boot
 * whether or not it will ever do work, so the module has to be in
 * scope. ENABLE_CRONS=false on the container keeps it from acquiring
 * a connection or draining a queue that portal-api already owns.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LeaderElectionModule,
    ScriptsModule,
  ],
})
export class ScriptWorkerAppModule {}

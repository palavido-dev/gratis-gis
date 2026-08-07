// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { clampScriptTimeout } from '@gratis-gis/shared-types';

import { ApiKeyService } from '../auth/api-key.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Executes queued `script` runs (#221).
 *
 * The privilege story, which is the whole design:
 *
 *   - The child process gets a SCRUBBED environment. Not the worker's
 *     environment minus a few names: a fresh object with exactly the
 *     variables listed below. The worker itself needs DATABASE_URL to
 *     claim rows and MinIO credentials for other work, and none of
 *     that may leak into a process running code the portal did not
 *     write. An allowlist fails closed when a new secret is added to
 *     compose later; a denylist fails open, silently.
 *   - The only credential the child receives is an API key minted for
 *     this run, valid for the run's timeout, revoked when it ends.
 *     Its authority is the owning user's, so a script can never reach
 *     anything that user could not reach in the browser.
 *   - Writes therefore go through the public HTTP API and the engine,
 *     preserving the observation log's bitemporal semantics. A direct
 *     database handle would let a script corrupt that model silently.
 *     Same boundary the analysis bridge draws.
 *
 * Claiming reuses the analysis queue's proven mechanism: FOR UPDATE
 * SKIP LOCKED, a heartbeat while running, and a sweep that fails rows
 * whose worker died. A SIGKILLed worker cannot flip its own row.
 */
@Injectable()
export class ScriptRunnerWorker implements OnModuleDestroy {
  private readonly log = new Logger(ScriptRunnerWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Live children, so shutdown and cancel can reach them. */
  private readonly running = new Map<string, { kill: () => void }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  /** Started explicitly by the worker entry point, never by the API
   *  process: an API replica must not spend its CPU on user code. */
  start(): void {
    if (this.timer) return;
    const period = Number(process.env.SCRIPT_POLL_MS ?? 3000);
    this.timer = setInterval(() => {
      void this.tick();
    }, period);
    this.timer.unref();
    this.log.log(`script runner polling every ${period}ms`);
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const child of this.running.values()) child.kill();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.reclaimStale();
      const claimed = await this.claimOne();
      if (claimed) await this.execute(claimed);
    } catch (err) {
      this.log.error(
        `script poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fail runs whose worker stopped beating. Without this a killed
   * worker leaves a row in `running` forever and the UI spins. Same
   * reasoning and window as the analysis queue.
   */
  private async reclaimStale(): Promise<void> {
    const staleAfterMs = Number(process.env.SCRIPT_STALE_MS ?? 10 * 60 * 1000);
    const cutoff = new Date(Date.now() - staleAfterMs);
    const stale = await this.prisma.scriptRun.findMany({
      where: {
        state: { in: ['running', 'cancel_requested'] },
        heartbeatAt: { lt: cutoff },
      },
      select: { id: true, state: true, apiKeyId: true },
    });
    for (const row of stale) {
      await this.finish(row.id, {
        state: row.state === 'cancel_requested' ? 'cancelled' : 'failed',
        error:
          row.state === 'cancel_requested'
            ? 'Cancelled; the worker running it stopped responding.'
            : 'The worker running this script stopped responding.',
        apiKeyId: row.apiKeyId,
      });
      this.log.warn(`script run ${row.id}: reclaimed, worker heartbeat stale`);
    }
  }

  /**
   * Claim the oldest queued run. SKIP LOCKED so two workers never take
   * the same row and neither blocks on the other.
   */
  private async claimOne(): Promise<{
    id: string;
    userId: string;
    source: string;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; user_id: string; source_snapshot: string | null }>
    >(Prisma.sql`
      UPDATE script_run
      SET state = 'running', started_at = now(), heartbeat_at = now()
      WHERE id = (
        SELECT id FROM script_run
        WHERE state = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, user_id, source_snapshot
    `);
    const row = rows[0];
    if (!row) return null;
    if (!row.source_snapshot) {
      await this.finish(row.id, {
        state: 'failed',
        error: 'This run has no code attached to it.',
        apiKeyId: null,
      });
      return null;
    }
    return { id: row.id, userId: row.user_id, source: row.source_snapshot };
  }

  private async execute(job: {
    id: string;
    userId: string;
    source: string;
  }): Promise<void> {
    const timeoutSeconds = clampScriptTimeout(
      Number(process.env.SCRIPT_TIMEOUT_SECONDS ?? NaN),
    );
    // A little slack past the wall clock so the key cannot expire
    // while the script is still legitimately finishing a request.
    const key = await this.apiKeys.mintForRun(job.userId, {
      label: `script run ${job.id}`,
      ttlSeconds: timeoutSeconds + 60,
    });
    await this.prisma.scriptRun.update({
      where: { id: job.id },
      data: { apiKeyId: key.id },
    });

    const dir = await mkdtemp(join(tmpdir(), 'gg-script-'));
    const file = join(dir, 'main.py');
    await writeFile(file, job.source, 'utf8');

    const started = Date.now();
    let out = '';
    let truncated = false;
    const maxLog = Number(process.env.SCRIPT_MAX_LOG_BYTES ?? 256 * 1024);

    try {
      const result = await new Promise<{
        code: number | null;
        killedBy: 'timeout' | 'cancel' | null;
      }>((resolve) => {
        const child = spawn(
          process.env.SCRIPT_PYTHON ?? 'python3',
          // -I isolates: ignores PYTHON* env vars and the user site
          // directory, so the run cannot be steered by leftovers in
          // the image. -u keeps output unbuffered, which matters
          // because a killed process must not lose the last thing it
          // printed before dying.
          ['-I', '-u', file],
          {
            cwd: dir,
            env: this.childEnv(key.token),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        let settled = false;
        let killedBy: 'timeout' | 'cancel' | null = null;
        const collect = (buf: Buffer) => {
          if (truncated) return;
          out += buf.toString('utf8');
          if (out.length > maxLog) {
            out = out.slice(0, maxLog);
            truncated = true;
            // Say so explicitly. A log that just stops reads as a
            // crash, and the author would go looking for the wrong bug.
            out += '\n--- output truncated at the size limit ---\n';
          }
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const hardKill = () => {
          // SIGKILL, not SIGTERM: a script can install a SIGTERM
          // handler, and a timeout that a script can decline to honour
          // is not a timeout.
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        };
        const timeoutHandle = setTimeout(() => {
          killedBy = 'timeout';
          hardKill();
        }, timeoutSeconds * 1000);
        timeoutHandle.unref();

        // Cooperative cancel: poll the row rather than hold a
        // listener, matching how the analysis queue does it.
        const cancelPoll = setInterval(() => {
          void this.prisma.scriptRun
            .findUnique({
              where: { id: job.id },
              select: { state: true },
            })
            .then((r) => {
              if (r?.state === 'cancel_requested') {
                killedBy = 'cancel';
                hardKill();
              }
            })
            .catch(() => {
              // A transient DB blip must not kill a healthy run.
            });
        }, 2000);
        cancelPoll.unref();

        const heartbeat = setInterval(() => {
          void this.prisma.scriptRun
            .update({
              where: { id: job.id },
              data: { heartbeatAt: new Date() },
            })
            .catch(() => {
              // Same: a missed beat is recoverable, the sweep window
              // is minutes wide.
            });
        }, 30_000);
        heartbeat.unref();

        this.running.set(job.id, { kill: hardKill });

        const done = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          clearInterval(cancelPoll);
          clearInterval(heartbeat);
          this.running.delete(job.id);
          resolve({ code, killedBy });
        };
        child.on('error', (err) => {
          out += `\nCould not start the script: ${err.message}\n`;
          done(null);
        });
        child.on('close', (code) => done(code));
      });

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.killedBy === 'timeout') {
        await this.finish(job.id, {
          state: 'failed',
          error: `Stopped after ${timeoutSeconds}s, the time limit for a script run.`,
          log: out,
          apiKeyId: key.id,
        });
      } else if (result.killedBy === 'cancel') {
        await this.finish(job.id, {
          state: 'cancelled',
          error: 'Cancelled.',
          log: out,
          apiKeyId: key.id,
        });
      } else if (result.code === 0) {
        await this.finish(job.id, {
          state: 'done',
          exitCode: 0,
          log: out,
          apiKeyId: key.id,
        });
        this.log.log(`script run ${job.id}: done in ${seconds}s`);
      } else {
        await this.finish(job.id, {
          state: 'failed',
          exitCode: result.code,
          error: `The script exited with code ${result.code}.`,
          log: out,
          apiKeyId: key.id,
        });
      }
    } catch (err) {
      await this.finish(job.id, {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
        log: out,
        apiKeyId: key.id,
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // A leftover temp dir is not worth failing a finished run.
      });
    }
  }

  /**
   * The child's entire environment, built from nothing.
   *
   * Allowlist, not denylist. The worker's own environment holds
   * DATABASE_URL, MinIO root credentials, the Keycloak admin secret,
   * and the credential encryption key. Passing `...process.env` minus
   * a hand-maintained deny set means the next secret someone adds to
   * compose is exposed to every script until somebody remembers to
   * add it to the list. Starting empty means the next secret is
   * private by default and the mistake is a missing variable, which
   * is loud.
   */
  private childEnv(apiKeyToken: string): NodeJS.ProcessEnv {
    return {
      // Exactly the two names `GratisGIS.from_env()` reads. Getting
      // this wrong is invisible to a unit test that asserts the same
      // wrong name, and shows up as a ValueError on the first real
      // run; it did. The client's contract is the authority here, not
      // this file, because the same two variables are what a person
      // exports on their laptop.
      GRATISGIS_URL: process.env.PORTAL_BASE_URL ?? 'http://localhost:3000',
      GRATISGIS_API_KEY: apiKeyToken,
      // Enough of a system for python to start and for TLS to verify.
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.SCRIPT_HOME ?? '/tmp',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // Requests / httpx read these for the CA bundle in slim images.
      ...(process.env.SSL_CERT_FILE
        ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
        : {}),
      ...(process.env.SSL_CERT_DIR
        ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR }
        : {}),
    };
  }

  /** Terminal update plus key revocation, in that order. */
  private async finish(
    runId: string,
    input: {
      state: 'done' | 'failed' | 'cancelled';
      exitCode?: number | null;
      error?: string;
      log?: string;
      apiKeyId: string | null;
    },
  ): Promise<void> {
    await this.prisma.scriptRun.update({
      where: { id: runId },
      data: {
        state: input.state,
        finishedAt: new Date(),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.log !== undefined ? { log: input.log } : {}),
      },
    });
    if (input.apiKeyId) {
      // Best-effort, and backed up by the key's own short expiry: a
      // failure here must not leave the run stuck, but it also must
      // not silently leave a usable credential, hence the expiry.
      await this.apiKeys.revokeSystemKey(input.apiKeyId).catch(() => {
        this.log.warn(
          `script run ${runId}: could not revoke its key; it expires on its own shortly`,
        );
      });
    }
  }
}

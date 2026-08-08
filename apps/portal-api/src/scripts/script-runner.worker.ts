// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SCRIPT_MAX_NOTEBOOK_BYTES,
  clampScriptTimeout,
  looksLikeNotebook,
  type ScriptFormat,
} from '@gratis-gis/shared-types';

import { ApiKeyService } from '../auth/api-key.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Claims queued `script` runs and hands them to the executor (#221).
 *
 * This process NEVER spawns Python. That is the whole point of the
 * split.
 *
 * Claiming requires the database, and a container that can reach the
 * database sits on a network where the database is reachable. In the
 * original single-container design the script inherited that: a probe
 * script opened sockets to postgres:5432, minio:9000, and
 * keycloak:8080. It had no credentials for any of them, but "needs a
 * password" is a much weaker property than "cannot open the socket",
 * and only one of the two survives a protocol-level vulnerability.
 *
 * So the two responsibilities are now two containers. This one holds
 * the database handle and no Python. The executor holds the Python and
 * no database, on a network carrying only this claimer and portal-api.
 *
 * Cancel is expressed as hanging up: aborting the HTTP request makes
 * the executor kill the child. That avoids a second endpoint and a
 * run-id registry on the executor that could leak entries when a
 * claimer dies mid-run.
 *
 * Claim, heartbeat, and stale reclaim are the analysis queue's proven
 * mechanism, reused rather than reinvented.
 */
@Injectable()
export class ScriptRunnerWorker implements OnModuleDestroy {
  private readonly log = new Logger(ScriptRunnerWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** One run at a time. See the note in tick(). */
  private busy = false;
  /** In-flight runs, so shutdown can abort them promptly. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  start(): void {
    if (this.timer) return;
    const period = Number(process.env.SCRIPT_POLL_MS ?? 3000);
    this.timer = setInterval(() => {
      void this.tick();
    }, period);
    this.timer.unref();
    this.log.log(
      `script claimer polling every ${period}ms, executor at ${executorUrl()}`,
    );
  }

  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const ac of this.inFlight.values()) ac.abort();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    // setInterval does not wait for an async callback, so without this
    // guard a 300-second run would let 100 further ticks fire while it
    // was still going, each claiming another row and spawning another
    // interpreter. Someone queueing fifty runs would get fifty
    // concurrent Python processes. One executor, one run at a time.
    if (this.busy) return;
    this.busy = true;
    try {
      await this.reclaimStale();
      const claimed = await this.claimOne();
      if (claimed) await this.dispatch(claimed);
    } catch (err) {
      this.log.error(
        `script poll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.busy = false;
    }
  }

  /**
   * Fail runs whose claimer stopped beating. Without this a killed
   * claimer leaves a row in `running` forever and the UI spins.
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
      this.log.warn(`script run ${row.id}: reclaimed, heartbeat stale`);
    }
  }

  private async claimOne(): Promise<{
    id: string;
    userId: string;
    source: string;
    format: ScriptFormat;
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
    // Decided from the snapshot rather than read off the item, for the
    // same reason the source is snapshotted: an edit landing between
    // enqueue and claim must not change how the queued thing runs. A
    // notebook is unmistakable from its content, so there is no need to
    // carry a second column that could disagree with the first.
    return {
      id: row.id,
      userId: row.user_id,
      source: row.source_snapshot,
      format: looksLikeNotebook(row.source_snapshot) ? 'notebook' : 'python',
    };
  }

  private async dispatch(job: {
    id: string;
    userId: string;
    source: string;
    format: ScriptFormat;
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

    const ac = new AbortController();
    this.inFlight.set(job.id, ac);

    const heartbeat = setInterval(() => {
      void this.prisma.scriptRun
        .update({ where: { id: job.id }, data: { heartbeatAt: new Date() } })
        .catch(() => {
          // A missed beat is recoverable; the sweep window is minutes.
        });
    }, 30_000);
    heartbeat.unref();

    // Cooperative cancel: poll the row and hang up on the executor,
    // which kills the child when the request closes.
    const cancelPoll = setInterval(() => {
      void this.prisma.scriptRun
        .findUnique({ where: { id: job.id }, select: { state: true } })
        .then((r) => {
          if (r?.state === 'cancel_requested') ac.abort();
        })
        .catch(() => {
          // A transient DB blip must not kill a healthy run.
        });
    }, 2000);
    cancelPoll.unref();

    const started = Date.now();
    try {
      const res = await fetch(`${executorUrl()}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-script-executor-token': process.env.SCRIPT_EXECUTOR_TOKEN ?? '',
        },
        body: JSON.stringify({
          source: job.source,
          apiKeyToken: key.token,
          timeoutSeconds,
          maxLogBytes: Number(process.env.SCRIPT_MAX_LOG_BYTES ?? 262_144),
          format: job.format,
          maxNotebookBytes: Number(
            process.env.SCRIPT_MAX_NOTEBOOK_BYTES ?? SCRIPT_MAX_NOTEBOOK_BYTES,
          ),
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        await this.finish(job.id, {
          state: 'failed',
          error: `The script executor refused the run (HTTP ${res.status}).`,
          log: detail.slice(0, 2000),
          apiKeyId: key.id,
        });
        return;
      }

      const out = (await res.json()) as {
        exitCode: number | null;
        log: string;
        killedBy: 'timeout' | 'cancel' | null;
        notebook?: string | null;
      };
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // Kept on failure as well as success. papermill writes the
      // notebook as it executes, so a failed run's artifact carries the
      // traceback in the cell that raised it, which is more use than
      // the log alone.
      const notebook = out.notebook ?? null;

      if (out.killedBy === 'timeout') {
        await this.finish(job.id, {
          state: 'failed',
          error: `Stopped after ${timeoutSeconds}s, the time limit for a script run.`,
          log: out.log,
          notebook,
          apiKeyId: key.id,
        });
      } else if (out.killedBy === 'cancel') {
        await this.finish(job.id, {
          state: 'cancelled',
          error: 'Cancelled.',
          log: out.log,
          notebook,
          apiKeyId: key.id,
        });
      } else if (out.exitCode === 0) {
        await this.finish(job.id, {
          state: 'done',
          exitCode: 0,
          log: out.log,
          notebook,
          apiKeyId: key.id,
        });
        this.log.log(`script run ${job.id}: done in ${seconds}s`);
      } else {
        await this.finish(job.id, {
          state: 'failed',
          exitCode: out.exitCode,
          error: `The script exited with code ${out.exitCode}.`,
          log: out.log,
          notebook,
          apiKeyId: key.id,
        });
      }
    } catch (err) {
      // An aborted fetch is the cancel path, not a failure of ours.
      const cancelled = ac.signal.aborted;
      await this.finish(job.id, {
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled
          ? 'Cancelled.'
          : `Could not reach the script executor: ${
              err instanceof Error ? err.message : String(err)
            }`,
        apiKeyId: key.id,
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelPoll);
      this.inFlight.delete(job.id);
    }
  }

  /** Terminal update plus key revocation, in that order. */
  private async finish(
    runId: string,
    input: {
      state: 'done' | 'failed' | 'cancelled';
      exitCode?: number | null;
      error?: string;
      log?: string;
      notebook?: string | null;
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
        ...(input.notebook !== undefined ? { notebook: input.notebook } : {}),
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

function executorUrl(): string {
  return (
    process.env.SCRIPT_EXECUTOR_URL ?? 'http://script-executor:4100'
  ).replace(/\/+$/, '');
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SCRIPT_MAX_NOTEBOOK_BYTES,
  clampScriptTimeout,
  SCRIPT_MAX_TIMEOUT_SECONDS,
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
/** Prune the run history at most this often. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Finished runs kept per script. SCRIPT_RUN_KEEP, default 100. */
export function scriptRunKeep(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SCRIPT_RUN_KEEP);
  return Number.isInteger(n) && n > 0 ? n : 100;
}

@Injectable()
export class ScriptRunnerWorker implements OnModuleDestroy {
  private readonly log = new Logger(ScriptRunnerWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** One run at a time. See the note in tick(). */
  private busy = false;
  /** In-flight runs, so shutdown can abort them promptly. */
  private readonly inFlight = new Map<string, AbortController>();
  /** When the run history was last pruned. See pruneOldRuns(). */
  private lastPruneAt = 0;

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
      if (Date.now() - this.lastPruneAt >= PRUNE_EVERY_MS) {
        this.lastPruneAt = Date.now();
        const removed = await this.pruneOldRuns();
        if (removed > 0) this.log.log(`pruned ${removed} old script runs`);
      }
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
      // Conditional on the state and staleness we read: a row that
      // finished, or beat, since the read is not ours to reclaim.
      const reclaimed = await this.finish(
        row.id,
        {
          state: row.state === 'cancel_requested' ? 'cancelled' : 'failed',
          error:
            row.state === 'cancel_requested'
              ? 'Cancelled; the worker running it stopped responding.'
              : 'The worker running this script stopped responding.',
          apiKeyId: row.apiKeyId,
        },
        { from: [row.state], staleBefore: cutoff },
      );
      if (reclaimed) {
        this.log.warn(`script run ${row.id}: reclaimed, heartbeat stale`);
      }
    }
  }

  /**
   * Keep the newest SCRIPT_RUN_KEEP finished runs of each script and
   * delete the rest. Each run can carry a 256 KB log, a source snapshot
   * and a 4 MB notebook, and a script can run hourly, so without this
   * the table (and every backup) grows forever. Queued and running
   * rows are never touched.
   */
  async pruneOldRuns(keep = scriptRunKeep()): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM script_run r
      USING (
        SELECT id,
               row_number() OVER (PARTITION BY script_id ORDER BY created_at DESC) AS rn
        FROM script_run
        WHERE state IN ('done', 'failed', 'cancelled')
      ) old
      WHERE r.id = old.id AND old.rn > ${keep}
    `);
  }

  private async claimOne(): Promise<{
    id: string;
    userId: string;
    scriptId?: string;
    source: string;
    format: ScriptFormat;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        user_id: string;
        script_id: string;
        source_snapshot: string | null;
      }>
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
      RETURNING id, user_id, script_id, source_snapshot
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
      scriptId: row.script_id,
      source: row.source_snapshot,
      format: looksLikeNotebook(row.source_snapshot) ? 'notebook' : 'python',
    };
  }

  private async dispatch(job: {
    id: string;
    userId: string;
    scriptId?: string;
    source: string;
    format: ScriptFormat;
  }): Promise<void> {
    const timeoutSeconds = await this.runTimeoutSeconds(job.scriptId);
    // A little slack past the wall clock so the key cannot expire
    // while the script is still legitimately finishing a request.
    //
    // The row is already 'running'. A failure here (owner deleted,
    // database blip) used to leave it there until the stale sweep
    // called it a crashed worker, with any minted key still live.
    let key: Awaited<ReturnType<ApiKeyService['mintForRun']>> | null = null;
    try {
      key = await this.apiKeys.mintForRun(job.userId, {
        label: `script run ${job.id}`,
        ttlSeconds: timeoutSeconds + 60,
      });
      await this.prisma.scriptRun.update({
        where: { id: job.id },
        data: { apiKeyId: key.id },
      });
    } catch (err) {
      await this.finish(job.id, {
        state: 'failed',
        error: `Could not start the run: ${
          err instanceof Error ? err.message : String(err)
        }`,
        apiKeyId: key?.id ?? null,
      });
      return;
    }

    const ac = new AbortController();
    this.inFlight.set(job.id, ac);

    const heartbeat = setInterval(() => {
      void this.prisma.scriptRun
        .updateMany({
          where: { id: job.id, state: { in: [...LIVE_STATES] } },
          data: { heartbeatAt: new Date() },
        })
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
    // Set once the executor has answered: an error after that is ours
    // (saving the result), not a failure to reach the executor.
    let answered = false;
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
        // Our own deadline as well as the cancel signal. The executor
        // enforces the run timeout, but if it ever fails to answer, this
        // claimer must not wait forever: it is the only one, and every
        // queued run would wait behind it.
        signal: AbortSignal.any([
          ac.signal,
          AbortSignal.timeout((timeoutSeconds + EXECUTOR_GRACE_SECONDS) * 1000),
        ]),
      });

      answered = true;
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
      // An aborted fetch is the cancel path, not a failure of ours,
      // unless the abort came from this process shutting down.
      const cancelled = ac.signal.aborted && !this.stopping;
      const shutDown = ac.signal.aborted && this.stopping;
      const timedOut =
        !ac.signal.aborted && err instanceof Error && err.name === 'TimeoutError';
      const detail = err instanceof Error ? err.message : String(err);
      await this.finish(job.id, {
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled
          ? 'Cancelled.'
          : shutDown
            ? 'Stopped because the script service shut down.'
            : timedOut
              ? 'The script executor did not answer in time.'
              : answered
                ? `The run finished but its result could not be saved: ${detail}`
                : `Could not reach the script executor: ${detail}`,
        apiKeyId: key.id,
      }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelPoll);
      this.inFlight.delete(job.id);
    }
  }

  /**
   * The time limit for one run: the script's own setting (the panel
   * saves it as data.timeoutSeconds), never above the operator's
   * SCRIPT_TIMEOUT_SECONDS when that is set, nor above the hard
   * maximum. The per-script value used to be saved and then ignored.
   */
  private async runTimeoutSeconds(scriptId: string | undefined): Promise<number> {
    const envRaw = process.env.SCRIPT_TIMEOUT_SECONDS;
    const operatorCap =
      envRaw !== undefined && envRaw.trim() !== ''
        ? clampScriptTimeout(Number(envRaw))
        : SCRIPT_MAX_TIMEOUT_SECONDS;
    let perScript: number | undefined;
    if (scriptId) {
      const item = await this.prisma.item
        .findUnique({ where: { id: scriptId }, select: { data: true } })
        .catch(() => null);
      const raw = (item?.data as { timeoutSeconds?: unknown } | null)?.timeoutSeconds;
      if (typeof raw === 'number' && Number.isFinite(raw)) perScript = raw;
    }
    const wanted =
      perScript !== undefined
        ? clampScriptTimeout(perScript)
        : clampScriptTimeout(envRaw !== undefined ? Number(envRaw) : undefined);
    return Math.min(wanted, operatorCap);
  }

  /**
   * Terminal update plus key revocation, in that order.
   *
   * The update only applies while the row is still in one of `from`
   * (by default, any live state), so a run that something else already
   * finished is never relabelled. The key is revoked either way.
   * Returns whether this call moved the row.
   */
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
    guard: { from?: readonly string[]; staleBefore?: Date } = {},
  ): Promise<boolean> {
    const res = await this.prisma.scriptRun.updateMany({
      where: {
        id: runId,
        state: { in: [...(guard.from ?? LIVE_STATES)] },
        ...(guard.staleBefore ? { heartbeatAt: { lt: guard.staleBefore } } : {}),
      },
      data: {
        state: input.state,
        finishedAt: new Date(),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        // Postgres text refuses NUL. A script that printed one used to
        // fail this write, and the run was then recorded as unreachable
        // with no log.
        ...(input.error !== undefined ? { error: stripNul(input.error) } : {}),
        ...(input.log !== undefined ? { log: stripNul(input.log) } : {}),
        ...(input.notebook !== undefined
          ? { notebook: input.notebook === null ? null : stripNul(input.notebook) }
          : {}),
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
    return res.count === 1;
  }
}

/** Drop NUL characters, which a Postgres text column refuses. */
export function stripNul(text: string): string {
  return text.includes('\u0000') ? text.split('\u0000').join('') : text;
}

/** How long past the run timeout the claimer waits for the executor. */
const EXECUTOR_GRACE_SECONDS = 120;

/** States in which a claimer owns the run. */
const LIVE_STATES = ['running', 'cancel_requested'] as const;

function executorUrl(): string {
  return (
    process.env.SCRIPT_EXECUTOR_URL ?? 'http://script-executor:4100'
  ).replace(/(?<!\/)\/+$/, '');
}

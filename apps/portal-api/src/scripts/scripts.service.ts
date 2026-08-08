// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  SCRIPT_MAX_SOURCE_BYTES,
  clampScriptTimeout,
  looksLikeNotebook,
  normalizeScriptSchedule,
  type ScriptFormat,
  type ScriptData,
  type ScriptRunDetail,
  type ScriptRunSummary,
} from '@gratis-gis/shared-types';

import type { ItemShare } from '@prisma/client';

import { ItemsService } from '../items/items.service.js';
import { SharingService } from '../items/sharing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Queue and history for `script` item runs (#221).
 *
 * Enqueue only. Execution lives in the worker, which claims rows with
 * FOR UPDATE SKIP LOCKED exactly like the analysis queue, so the API
 * process never spawns a child and a busy script cannot compete with
 * request handling for CPU.
 */
@Injectable()
export class ScriptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
  ) {}

  /**
   * Resolve a script item the caller may RUN.
   *
   * Running is gated on edit, not read. A run executes arbitrary code
   * as the person who pressed the button, so "can see this item" is
   * the wrong bar: a script shared read-only with a viewer would
   * otherwise let that viewer execute the author's code under their
   * own credentials, which is a confused-deputy setup in both
   * directions.
   */
  private async assertRunnable(user: AuthUser, scriptId: string) {
    const item = await this.items.get(user, scriptId);
    if (!item) throw new NotFoundException('Script not found.');
    if (item.type !== 'script') {
      throw new BadRequestException('That item is not a script.');
    }
    const withShares = item as typeof item & { shares?: ItemShare[] };
    if (!this.sharing.canEdit(user, item, withShares.shares ?? [])) {
      throw new ForbiddenException(
        'Running a script requires edit access to it.',
      );
    }
    return item;
  }

  static readData(item: { data: unknown }): ScriptData {
    const data = (item.data ?? {}) as Partial<ScriptData>;
    const schedule = normalizeScriptSchedule(data.schedule);
    const source = typeof data.source === 'string' ? data.source : '';
    // Trust the content over the declared format. They can only
    // disagree if something wrote the item without going through the
    // editor, and the content is the thing that has to execute.
    const format: ScriptFormat = looksLikeNotebook(source)
      ? 'notebook'
      : 'python';
    return {
      version: 1,
      format,
      source,
      ...(typeof data.timeoutSeconds === 'number'
        ? { timeoutSeconds: data.timeoutSeconds }
        : {}),
      ...(typeof data.notes === 'string' ? { notes: data.notes } : {}),
      ...(schedule ? { schedule } : {}),
    };
  }

  /**
   * Queue one run.
   *
   * The source is snapshotted onto the run row here rather than read
   * by the worker. Two reasons, and the second is the important one:
   * a month-old failed run must show the code that failed, not
   * whatever the script says today; and reading at claim time would
   * mean an edit landing between enqueue and claim silently changes
   * what executes.
   */
  async enqueue(
    user: AuthUser,
    scriptId: string,
  ): Promise<{ id: string; state: string }> {
    const item = await this.assertRunnable(user, scriptId);
    const data = ScriptsService.readData(item as { data: unknown });

    const source = data.source.trim();
    if (source.length === 0) {
      throw new BadRequestException(
        'This script has no code in it yet. Add some and save before running.',
      );
    }
    if (Buffer.byteLength(source, 'utf8') > SCRIPT_MAX_SOURCE_BYTES) {
      throw new BadRequestException('That script is too large to run.');
    }

    // One in-flight run per script. Concurrent runs of a layer-refresh
    // script would race each other's writes, and the second one is
    // almost never what the person clicking twice wanted.
    const inFlight = await this.prisma.scriptRun.findFirst({
      where: { scriptId, state: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (inFlight) {
      throw new BadRequestException(
        'This script is already running. Wait for it to finish, or cancel it.',
      );
    }

    const run = await this.prisma.scriptRun.create({
      data: {
        scriptId,
        orgId: user.orgId,
        userId: user.id,
        trigger: 'manual',
        sourceSnapshot: source,
      },
      select: { id: true, state: true },
    });
    return run;
  }

  /**
   * Queue one run because the clock said so, not because a person did.
   *
   * Separate from enqueue() rather than sharing it behind a flag,
   * because almost every rule differs. There is no request user, so
   * authority comes from the item's owner; there is no caller to
   * return a 400 to, so every refusal has to become a record or a log
   * line; and the "already running" case flips from an error into a
   * normal, expected outcome.
   *
   * Whose authority: the owner's. A scheduled run has to act as
   * somebody, and the owner is the person who took responsibility for
   * the item. Notably this is NOT whoever last edited the schedule,
   * which would let an editor quietly arrange for code to run with the
   * owner's permissions on a timer.
   *
   * Returns the run id, or null when nothing was queued.
   */
  async enqueueScheduled(scriptId: string): Promise<string | null> {
    const item = await this.prisma.item.findFirst({
      where: { id: scriptId, type: 'script', deletedAt: null },
      select: { id: true, orgId: true, ownerId: true, data: true },
    });
    if (!item) return null;

    const source = ScriptsService.readData(item).source.trim();
    if (source.length === 0) return null;
    if (Buffer.byteLength(source, 'utf8') > SCRIPT_MAX_SOURCE_BYTES) {
      return null;
    }

    // The owner must still be a live user. An owner who has been
    // deactivated should not keep executing code every night, and
    // failing closed here is the difference between a stale schedule
    // and a standing grant that outlives the account.
    const owner = await this.prisma.user.findFirst({
      where: { id: item.ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!owner) {
      await this.recordSkip(
        item,
        'The person who owns this script no longer has an active account, so the scheduled run did not start.',
      );
      return null;
    }

    const inFlight = await this.prisma.scriptRun.findFirst({
      where: { scriptId, state: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    if (inFlight) {
      await this.recordSkip(
        item,
        'Skipped: the previous run was still going when this one was due.',
      );
      return null;
    }

    const run = await this.prisma.scriptRun.create({
      data: {
        scriptId,
        orgId: item.orgId,
        userId: item.ownerId,
        trigger: 'schedule',
        sourceSnapshot: source,
      },
      select: { id: true },
    });
    return run.id;
  }

  /** A terminal row explaining why a scheduled fire produced nothing. */
  private async recordSkip(
    item: { id: string; orgId: string; ownerId: string },
    error: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.scriptRun.create({
      data: {
        scriptId: item.id,
        orgId: item.orgId,
        userId: item.ownerId,
        trigger: 'schedule',
        state: 'skipped',
        error,
        finishedAt: now,
      },
    });
  }

  async listRuns(
    user: AuthUser,
    scriptId: string,
    limit = 20,
  ): Promise<ScriptRunSummary[]> {
    // Reading history only needs read access; it is the running that
    // is privileged.
    const item = await this.items.get(user, scriptId);
    if (!item || item.type !== 'script') {
      throw new NotFoundException('Script not found.');
    }
    const rows = await this.prisma.scriptRun.findMany({
      where: { scriptId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map(toSummary);
  }

  async getRun(user: AuthUser, runId: string): Promise<ScriptRunDetail> {
    const row = await this.prisma.scriptRun.findUnique({
      where: { id: runId },
    });
    if (!row) throw new NotFoundException('Run not found.');
    // Re-check against the script, not the run: the run row carries no
    // sharing of its own.
    const item = await this.items.get(user, row.scriptId);
    if (!item) throw new NotFoundException('Run not found.');
    return {
      ...toSummary(row),
      log: row.log,
      sourceSnapshot: row.sourceSnapshot,
      notebook: row.notebook,
    };
  }

  /**
   * Cooperative cancel, same contract as the analysis queue: flip the
   * state and let the worker notice. A queued run that no worker has
   * claimed can be cancelled outright, since there is nothing to tell.
   */
  async cancelRun(user: AuthUser, runId: string): Promise<{ state: string }> {
    const row = await this.prisma.scriptRun.findUnique({
      where: { id: runId },
      select: { id: true, scriptId: true, state: true },
    });
    if (!row) throw new NotFoundException('Run not found.');
    await this.assertRunnable(user, row.scriptId);

    if (row.state === 'queued') {
      await this.prisma.scriptRun.update({
        where: { id: row.id },
        data: { state: 'cancelled', finishedAt: new Date() },
      });
      return { state: 'cancelled' };
    }
    if (row.state === 'running') {
      await this.prisma.scriptRun.update({
        where: { id: row.id },
        data: { state: 'cancel_requested' },
      });
      return { state: 'cancel_requested' };
    }
    // Already finished. Not an error: the button and the run's own
    // completion race constantly, and a 400 here would be noise.
    return { state: row.state };
  }
}

function toSummary(row: {
  id: string;
  scriptId: string;
  state: string;
  trigger: string;
  notebook?: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): ScriptRunSummary {
  return {
    id: row.id,
    scriptId: row.scriptId,
    state: row.state as ScriptRunSummary['state'],
    trigger: row.trigger as ScriptRunSummary['trigger'],
    exitCode: row.exitCode,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export { clampScriptTimeout };

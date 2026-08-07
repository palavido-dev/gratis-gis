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
    return {
      version: 1,
      source: typeof data.source === 'string' ? data.source : '',
      ...(typeof data.timeoutSeconds === 'number'
        ? { timeoutSeconds: data.timeoutSeconds }
        : {}),
      ...(typeof data.notes === 'string' ? { notes: data.notes } : {}),
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

// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminAuditService } from './admin-audit.service.js';

export function redactJobError(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]')
    .replace(/bearer\s+\S+/gi, '[redacted]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted]')
    .slice(0, 240);
}

export interface JobRow {
  id: string;
  kind: 'import' | 'analysis' | 'backup';
  source: string;
  type: string;
  status: string;
  error: string | null;
  actions: { cancel: boolean; retry: boolean };
}

@Injectable()
export class JobsMonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(orgId: string): Promise<{ jobs: JobRow[] }> {
    const [imports, analysis] = await Promise.all([
      this.prisma.importJob.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.analysisJob.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    const jobs: JobRow[] = [
      ...imports.map((row) => ({
        id: row.id,
        kind: 'import' as const,
        source: row.sourceFileName,
        type: row.mode,
        status: row.status,
        error: redactJobError(row.errorMessage),
        actions: {
          cancel: row.status === 'queued' || row.status === 'running',
          retry: row.status === 'failed' || row.status === 'cancelled',
        },
      })),
      ...analysis.map((row) => ({
        id: row.id,
        kind: 'analysis' as const,
        source: row.sourceItemId,
        type: row.kind,
        status: row.state,
        error: redactJobError(row.error),
        actions: {
          cancel: row.state === 'queued' || row.state === 'running',
          retry: row.state === 'failed' || row.state === 'cancelled',
        },
      })),
    ];
    return { jobs };
  }

  async cancel(user: AuthUser, kind: string, id: string): Promise<JobRow> {
    if (kind === 'import') return this.cancelImport(user, id);
    if (kind === 'analysis') return this.cancelAnalysis(user, id);
    throw new BadRequestException('Backups stay on the backup page for this install.');
  }

  async retry(user: AuthUser, kind: string, id: string): Promise<JobRow> {
    if (kind === 'import') return this.retryImport(user, id);
    if (kind === 'analysis') return this.retryAnalysis(user, id);
    throw new BadRequestException('Backups stay on the backup page for this install.');
  }

  private async cancelImport(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.importJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) throw new NotFoundException('Import job not found.');
    if (row.status !== 'queued' && row.status !== 'running') {
      throw new BadRequestException('Only a queued or running import can be cancelled.');
    }
    const updated = await this.prisma.importJob.update({
      where: { id },
      data: { status: 'cancelled', finishedAt: new Date() },
    });
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.cancel',
      targetType: 'import',
      targetId: id,
      outcome: 'succeeded',
    });
    return {
      id,
      kind: 'import',
      source: updated.sourceFileName,
      type: updated.mode,
      status: updated.status,
      error: redactJobError(updated.errorMessage),
      actions: { cancel: false, retry: true },
    };
  }

  private async cancelAnalysis(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.analysisJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) throw new NotFoundException('Analysis job not found.');
    if (row.state !== 'queued' && row.state !== 'running') {
      throw new BadRequestException('Only a queued or running analysis can be cancelled.');
    }
    const nextState = row.state === 'queued' ? 'cancelled' : 'cancel_requested';
    const updated = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH lease AS (
        SELECT set_config('gratis.reclaim', '1', true)
      )
      UPDATE analysis_job
      SET state = ${nextState},
          finished_at = CASE WHEN ${nextState} = 'cancelled' THEN now() ELSE finished_at END
      WHERE id = ${id}::uuid
        AND org_id = ${user.orgId}::uuid
        AND state = ${row.state}
        AND (SELECT count(*) FROM lease) = 1
      RETURNING id
    `;
    if (updated.length !== 1) {
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'job.cancel',
        targetType: 'analysis',
        targetId: id,
        outcome: 'failed',
      });
      throw new ConflictException('The analysis could not be cancelled.');
    }
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.cancel',
      targetType: 'analysis',
      targetId: id,
      outcome: 'succeeded',
    });
    const next = await this.prisma.analysisJob.findUniqueOrThrow({ where: { id } });
    return {
      id,
      kind: 'analysis',
      source: next.sourceItemId,
      type: next.kind,
      status: next.state,
      error: redactJobError(next.error),
      actions: { cancel: false, retry: next.state === 'cancelled' },
    };
  }

  private async retryImport(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.importJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) throw new NotFoundException('Import job not found.');
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw new BadRequestException('Only a failed or cancelled import can be retried.');
    }
    await this.assertOwnedItem(user.orgId, row.itemId);
    await this.assertRequester(user.orgId, row.createdBy);
    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.importJob.findFirst({
        where: {
          orgId: row.orgId,
          itemId: row.itemId,
          layerId: row.layerId,
          stagingId: row.stagingId,
          status: { in: ['queued', 'running'] },
        },
      });
      if (existing) return existing;
      return tx.importJob.create({
        data: {
          itemId: row.itemId,
          layerId: row.layerId,
          stagingId: row.stagingId,
          sourceFileName: row.sourceFileName,
          sourceLayerName: row.sourceLayerName,
          mode: row.mode,
          createdBy: row.createdBy,
          orgId: row.orgId,
          totalFeatures: row.totalFeatures,
          status: 'queued',
        },
      });
    });
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.retry',
      targetType: 'import',
      targetId: created.id,
      outcome: 'succeeded',
      detail: { from: id },
    });
    return {
      id: created.id,
      kind: 'import',
      source: created.sourceFileName,
      type: created.mode,
      status: created.status,
      error: null,
      actions: { cancel: true, retry: false },
    };
  }

  private async retryAnalysis(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.analysisJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) throw new NotFoundException('Analysis job not found.');
    if (row.state !== 'failed' && row.state !== 'cancelled') {
      throw new BadRequestException('Only a failed or cancelled analysis can be retried.');
    }
    await this.assertOwnedItem(user.orgId, row.sourceItemId);
    if (row.targetItemId) await this.assertOwnedItem(user.orgId, row.targetItemId);
    await this.assertRequester(user.orgId, row.userId);
    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.analysisJob.findFirst({
        where: {
          orgId: row.orgId,
          sourceItemId: row.sourceItemId,
          kind: row.kind,
          state: { in: ['queued', 'running', 'ingest', 'importing', 'cancel_requested'] },
        },
      });
      if (existing) return existing;
      return tx.analysisJob.create({
        data: {
          orgId: row.orgId,
          userId: row.userId,
          kind: row.kind,
          params: row.params ?? {},
          sourceItemId: row.sourceItemId,
          targetItemId: row.targetItemId,
          state: 'queued',
        },
      });
    });
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.retry',
      targetType: 'analysis',
      targetId: created.id,
      outcome: 'succeeded',
      detail: { source: row.sourceItemId },
    });
    return {
      id: created.id,
      kind: 'analysis',
      source: created.sourceItemId,
      type: created.kind,
      status: created.state,
      error: null,
      actions: { cancel: created.state === 'queued' || created.state === 'running', retry: false },
    };
  }

  private async assertOwnedItem(orgId: string, itemId: string): Promise<void> {
    const item = await this.prisma.item.findFirst({
      where: { id: itemId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!item) {
      throw new BadRequestException('That item is not in this organization.');
    }
  }

  private async assertRequester(orgId: string, userId: string): Promise<void> {
    const requester = await this.prisma.user.findFirst({
      where: { id: userId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!requester) {
      throw new BadRequestException('The original requester is not in this organization.');
    }
  }

}

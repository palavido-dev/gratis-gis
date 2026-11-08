// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { BackupService } from '../backup/backup.service.js';
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
    private readonly backup: BackupService,
    private readonly audit: AdminAuditService,
  ) {}

  async list(orgId: string): Promise<{ jobs: JobRow[] }> {
    const [imports, analysis, backups] = await Promise.all([
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
      this.prisma.backupRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: 20,
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
      ...backups.map((row) => ({
        id: row.id,
        kind: 'backup' as const,
        source: row.trigger,
        type: 'backup',
        status: row.status,
        error: redactJobError(row.error),
        actions: {
          cancel: row.status === 'running',
          retry: row.status === 'failed',
        },
      })),
    ];
    return { jobs };
  }

  async cancel(user: AuthUser, kind: string, id: string): Promise<JobRow> {
    if (kind === 'import') return this.cancelImport(user, id);
    if (kind === 'analysis') return this.cancelAnalysis(user, id);
    if (kind === 'backup') return this.cancelBackup(user, id);
    throw new BadRequestException('That job type cannot be cancelled here.');
  }

  async retry(user: AuthUser, kind: string, id: string): Promise<JobRow> {
    if (kind === 'import') return this.retryImport(user, id);
    if (kind === 'analysis') return this.retryAnalysis(user, id);
    if (kind === 'backup') return this.retryBackup(user, id);
    throw new BadRequestException('That job type cannot be retried.');
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
    if (row.state === 'queued') {
      await this.prisma.analysisJob.updateMany({
        where: { id, state: 'queued' },
        data: { state: 'cancelled', finishedAt: new Date() },
      });
    } else if (row.state === 'running') {
      await this.prisma.analysisJob.updateMany({
        where: { id, state: 'running' },
        data: { state: 'cancel_requested' },
      });
    } else {
      throw new BadRequestException('Only a queued or running analysis can be cancelled.');
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

  private async cancelBackup(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup run not found.');
    if (row.status !== 'running') {
      throw new BadRequestException('Only a running backup can be cancelled.');
    }
    await this.backup.requestCancel(id);
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.cancel',
      targetType: 'backup',
      targetId: id,
      outcome: 'succeeded',
    });
    const next = await this.prisma.backupRun.findUniqueOrThrow({ where: { id } });
    return {
      id,
      kind: 'backup',
      source: next.trigger,
      type: 'backup',
      status: next.status,
      error: redactJobError(next.error),
      actions: { cancel: next.status === 'running', retry: next.status === 'failed' },
    };
  }

  private async retryImport(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.importJob.findUnique({ where: { id } });
    if (!row || row.orgId !== user.orgId) throw new NotFoundException('Import job not found.');
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw new BadRequestException('Only a failed or cancelled import can be retried.');
    }
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
    const source = await this.prisma.item.findFirst({
      where: { id: row.sourceItemId, orgId: user.orgId, deletedAt: null },
      select: { id: true, access: true },
    });
    if (!source) {
      throw new BadRequestException('The source item is gone, so this analysis cannot be retried.');
    }
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
      detail: { access: source.access },
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

  private async retryBackup(user: AuthUser, id: string): Promise<JobRow> {
    const row = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Backup run not found.');
    if (row.status !== 'failed') {
      throw new BadRequestException('Only a failed backup can be run again.');
    }
    const live = await this.prisma.backupRun.findFirst({ where: { status: 'running' } });
    if (live) throw new ConflictException('A backup is already running.');
    const next = await this.backup.runBackup('manual', user.id);
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'job.retry',
      targetType: 'backup',
      targetId: next.id,
      outcome: 'succeeded',
      detail: { from: id },
    });
    return {
      id: next.id,
      kind: 'backup',
      source: next.trigger,
      type: 'backup',
      status: next.status,
      error: redactJobError(next.error),
      actions: { cancel: next.status === 'running', retry: next.status === 'failed' },
    };
  }
}

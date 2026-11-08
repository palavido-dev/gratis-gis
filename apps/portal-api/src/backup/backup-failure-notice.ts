// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { operatorOrgId } from './operator-org.js';

/**
 * One in-portal notice per failed backup run. The primary key is the
 * run id, so a second failure path for the same run does not send
 * again. The payload is the run id, not the error text.
 */
@Injectable()
export class BackupFailureNotice {
  private readonly log = new Logger(BackupFailureNotice.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async announce(runId: string): Promise<boolean> {
    try {
      await this.prisma.backupFailureNotice.create({ data: { runId } });
    } catch {
      return false;
    }
    const orgId = await operatorOrgId(this.prisma);
    const admins = orgId
      ? await this.prisma.user.findMany({
          where: { orgRole: 'admin', deletedAt: null, orgId },
          select: { id: true },
        })
      : [];
    await this.notifications.notifyMany(
      admins.map((admin) => admin.id),
      'backup_failed',
      { runId },
    );
    this.log.warn('backup failure notice queued');
    return true;
  }
}

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
    await this.notifyOperatorAdmins({ runId });
    this.log.warn('backup failure notice queued');
    return true;
  }

  /**
   * One notice per off-site event, keyed in backup_offsite_notice:
   * "failed:<run id>" for an upload that failed, "stale:<run id or
   * none>" for a quiet period, "key:<fingerprint>:<time>" for a changed
   * public key, "signing:<fingerprint>:<time>" for a new signing key,
   * "suspect:<copy>" for a copy whose date cannot be trusted,
   * "unverified:<copy>" for a copy whose signature does not check.
   * Same recipients and notification type as a failed backup;
   * the payload says which kind it is. Never carries an error message,
   * a key or a bucket name; fingerprints are not secret.
   */
  async announceOffsite(
    key: string,
    payload: {
      runId?: string;
      kind:
        | 'offsite_failed'
        | 'offsite_stale'
        | 'offsite_key_changed'
        | 'offsite_suspect_copy'
        | 'offsite_signing_key_changed'
        | 'offsite_unverified_copy';
      days?: number | null;
      from?: string | null;
      to?: string | null;
      name?: string;
    },
  ): Promise<boolean> {
    try {
      await this.prisma.backupOffsiteNotice.create({ data: { key: key.slice(0, 300) } });
    } catch {
      return false;
    }
    const body: Record<string, string | number | null> = { kind: payload.kind };
    if (payload.runId) body.runId = payload.runId;
    if (payload.days !== undefined) body.days = payload.days;
    if (payload.from !== undefined) body.from = payload.from;
    if (payload.to !== undefined) body.to = payload.to;
    if (payload.name !== undefined) body.name = payload.name;
    await this.notifyOperatorAdmins(body);
    this.log.warn(`off-site backup notice queued (${payload.kind})`);
    return true;
  }

  private async notifyOperatorAdmins(payload: Record<string, string | number | null>) {
    // Same lookup as OperatorOrgGuard: GRATIS_OPERATOR_ORG_ID when set,
    // the oldest organization otherwise, and nobody when the variable
    // is malformed.
    const operator = await operatorOrgId(this.prisma);
    const admins = operator
      ? await this.prisma.user.findMany({
          where: { orgRole: 'admin', deletedAt: null, orgId: operator },
          select: { id: true },
        })
      : [];
    await this.notifications.notifyMany(
      admins.map((admin) => admin.id),
      'backup_failed',
      payload,
    );
  }
}

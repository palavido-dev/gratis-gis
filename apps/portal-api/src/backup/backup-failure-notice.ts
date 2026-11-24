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
   * "set-aside:<digest>" for one retention pass's summary of copies set
   * aside (the digest names the set, so the same set is not announced
   * twice), "retention-stopped:<day>" for a retention pass stopped by
   * a record it could not read. Same recipients and notification type
   * as a failed backup; the payload says which kind it is. Never
   * carries an error message, a key or a bucket name; fingerprints are
   * not secret.
   */
  async announceOffsite(
    key: string,
    payload: {
      runId?: string;
      kind:
        | 'offsite_failed'
        | 'offsite_stale'
        | 'offsite_key_changed'
        | 'offsite_set_aside'
        | 'offsite_retention_stopped'
        | 'offsite_signing_key_changed';
      days?: number | null;
      from?: string | null;
      to?: string | null;
      name?: string;
      count?: number;
      badSignature?: number;
      dated?: number;
      automatic?: boolean;
    },
  ): Promise<boolean> {
    try {
      await this.prisma.backupOffsiteNotice.create({ data: { key: key.slice(0, 300) } });
    } catch {
      return false;
    }
    const body: Record<string, string | number | boolean | null> = Object.fromEntries(
      (
        [
          ['kind', payload.kind],
          ['runId', payload.runId || undefined],
          ['days', payload.days],
          ['from', payload.from],
          ['to', payload.to],
          ['name', payload.name],
          ['count', payload.count],
          ['badSignature', payload.badSignature],
          ['dated', payload.dated],
          ['automatic', payload.automatic],
        ] as Array<[string, string | number | boolean | null | undefined]>
      ).filter((e): e is [string, string | number | boolean | null] => e[1] !== undefined),
    );
    await this.notifyOperatorAdmins(body);
    this.log.warn(`off-site backup notice queued (${payload.kind})`);
    return true;
  }

  private async notifyOperatorAdmins(payload: Record<string, string | number | boolean | null>) {
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

// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { diskDecision } from './resource-quota.js';

@Injectable()
export class ResourceQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hold bytes for one staged upload or import. The transaction takes
   * an advisory lock for the org, drops reservations whose import
   * already finished or that outlived a crashed upload, and then
   * refuses the hold if the staging disk does not have room. There is
   * no per-org storage or concurrency cap.
   */
  async reserve(orgId: string, bytes: bigint, purpose: string): Promise<{ id: string }> {
    const id = randomUUID();
    const heldPurpose = purpose.slice(0, 80);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`;
      await tx.$executeRaw`
        DELETE FROM storage_reservation AS r
        WHERE r.org_id = ${orgId}::uuid
          AND (
            EXISTS (
              SELECT 1 FROM import_job AS done
              WHERE done.org_id = r.org_id
                AND done.status IN ('succeeded', 'failed', 'cancelled')
                AND (done.id::text = r.purpose OR done.staging_id = r.purpose)
                AND NOT EXISTS (
                  SELECT 1 FROM import_job AS live
                  WHERE live.org_id = r.org_id
                    AND live.status IN ('queued', 'running')
                    AND (live.id::text = r.purpose OR live.staging_id = r.purpose)
                )
            )
            OR (
              r.created_at < now() - interval '70 minutes'
              AND NOT EXISTS (
                SELECT 1 FROM import_job AS live
                WHERE live.org_id = r.org_id
                  AND live.status IN ('queued', 'running')
                  AND (live.id::text = r.purpose OR live.staging_id = r.purpose)
              )
            )
          )
      `;
      const existing = await tx.storageReservation.findFirst({
        where: { orgId, purpose: heldPurpose },
      });
      if (existing) return;
      const decision = diskDecision({
        requestedBytes: bytes,
        freeBytes: await this.freeBytes(),
      });
      if (!decision.ok) {
        throw new ConflictException('The disk does not have room for this import.');
      }
      await tx.storageReservation.create({
        data: { id, orgId, bytes, purpose: heldPurpose },
      });
    });
    return { id };
  }

  async release(id: string): Promise<void> {
    await this.prisma.storageReservation.delete({ where: { id } }).catch(() => undefined);
  }

  async releasePurpose(purpose: string): Promise<void> {
    await this.prisma.storageReservation.deleteMany({ where: { purpose } }).catch(() => undefined);
  }

  private async freeBytes(): Promise<bigint | null> {
    try {
      const stat = await statfs(tmpdir());
      return BigInt(stat.bsize) * BigInt(stat.bavail);
    } catch {
      return null;
    }
  }
}

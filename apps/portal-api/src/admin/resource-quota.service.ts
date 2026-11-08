// SPDX-License-Identifier: AGPL-3.0-or-later
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { quotaDecision } from './resource-quota.js';

@Injectable()
export class ResourceQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async get(orgId: string) {
    const row = await this.prisma.orgResourceQuota.findUnique({ where: { orgId } });
    return {
      maxStorageBytes: row?.maxStorageBytes?.toString() ?? null,
      maxConcurrentImports: row?.maxConcurrentImports ?? null,
    };
  }

  async set(
    orgId: string,
    input: { maxStorageBytes: bigint | null; maxConcurrentImports: number | null },
  ) {
    await this.prisma.orgResourceQuota.upsert({
      where: { orgId },
      create: { orgId, ...input },
      update: input,
    });
    return this.get(orgId);
  }

  /**
   * Hold bytes for one org. The transaction takes an advisory lock
   * for that org first, then drops reservations whose import already
   * finished or that outlived a crashed upload, then inserts only if
   * the cap still fits. Two concurrent callers cannot both pass.
   */
  async reserve(orgId: string, bytes: bigint, purpose: string): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const heldPurpose = purpose.slice(0, 80);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('gratis-storage-reserve', 0))`;
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
      const quota = await tx.orgResourceQuota.findUnique({ where: { orgId } });
      const used = await tx.storageReservation.aggregate({
        where: { orgId },
        _sum: { bytes: true },
      });
      const active = await tx.importJob.count({
        where: { orgId, status: { in: ['queued', 'running'] } },
      });
      const free = await this.freeBytes();
      const decision = quotaDecision({
        maxBytes: quota?.maxStorageBytes ?? null,
        usedBytes: used._sum.bytes ?? 0n,
        requestedBytes: bytes,
        maxConcurrentImports: quota?.maxConcurrentImports ?? null,
        activeImports: active,
        freeBytes: free,
      });
      if (!decision.ok) {
        throw new ConflictException(
          decision.reason === 'disk'
            ? 'The disk does not have room for this import.'
            : decision.reason === 'concurrent'
              ? 'This organization is at its import limit.'
              : 'This organization is at its storage limit.',
        );
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

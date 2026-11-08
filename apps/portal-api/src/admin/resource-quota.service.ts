// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ConflictException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { quotaDecision } from './resource-quota.js';

export function stagingDir(): string {
  const configured = process.env.STAGING_DIR?.trim();
  return configured && configured.length > 0 ? configured : tmpdir();
}

export async function freeBytesAt(dir: string): Promise<bigint | null> {
  try {
    const stat = await statfs(dir);
    return BigInt(stat.bsize) * BigInt(stat.bavail);
  } catch {
    return null;
  }
}

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
    const id = randomUUID();
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
      const quota = await tx.orgResourceQuota.findUnique({ where: { orgId } });
      const reservations = await tx.storageReservation.findMany({
        where: { orgId },
        select: { purpose: true, bytes: true },
      });
      const jobs = await tx.importJob.findMany({
        where: { orgId, status: { in: ['queued', 'running'] } },
        select: { id: true, stagingId: true },
      });
      const slots = new Set<string>();
      for (const job of jobs) {
        slots.add(job.id);
        if (job.stagingId) slots.add(job.stagingId);
      }
      for (const reservation of reservations) slots.add(reservation.purpose);
      const others = existing ? Math.max(0, slots.size - 1) : slots.size;
      const usedBytes = reservations.reduce((sum, row) => sum + row.bytes, 0n);
      const free = await freeBytesAt(stagingDir());
      const decision = quotaDecision({
        maxBytes: quota?.maxStorageBytes ?? null,
        usedBytes: existing ? usedBytes - existing.bytes : usedBytes,
        requestedBytes: existing ? existing.bytes : bytes,
        maxConcurrentImports: quota?.maxConcurrentImports ?? null,
        activeImports: others,
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
      if (existing) return;
      await tx.storageReservation.create({
        data: { id, orgId, bytes, purpose: heldPurpose },
      });
    });
    const held = await this.prisma.storageReservation.findFirst({
      where: { orgId, purpose: heldPurpose },
      select: { id: true },
    });
    return { id: held?.id ?? id };
  }

  async release(id: string): Promise<void> {
    await this.prisma.storageReservation.delete({ where: { id } }).catch(() => undefined);
  }

  async releasePurpose(purpose: string): Promise<void> {
    await this.prisma.storageReservation.deleteMany({ where: { purpose } }).catch(() => undefined);
  }

}

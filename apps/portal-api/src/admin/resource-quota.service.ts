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
   * Hold bytes for one org inside a transaction so two imports
   * cannot both pass a cap they only fit under one at a time.
   */
  async reserve(orgId: string, bytes: bigint, purpose: string): Promise<{ id: string }> {
    const id = crypto.randomUUID();
    const free = await this.freeBytes();
    await this.prisma.$transaction(async (tx) => {
      const quota = await tx.orgResourceQuota.findUnique({ where: { orgId } });
      const used = await tx.storageReservation.aggregate({
        where: { orgId },
        _sum: { bytes: true },
      });
      const active = await tx.importJob.count({
        where: { orgId, status: { in: ['queued', 'running'] } },
      });
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
        data: { id, orgId, bytes, purpose: purpose.slice(0, 40) },
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

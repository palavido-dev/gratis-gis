// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-record summary the field client posts up. Mirrors the QueueRecord
 * shape in `apps/portal-web/src/lib/offline-store.ts` but trimmed to the
 * fields the admin view actually renders. We never accept the record
 * payload server-side (the whole point of the manifest is that the
 * actual edits stay on the device); this is metadata only.
 */
export interface ManifestEntry {
  dataCollectionId: string;
  cachedAt: string | null;
  queuedRecords: Array<{
    id: string;
    op: 'insert' | 'update' | 'delete';
    layerId: string;
    queuedAt: string;
    /** 'rejected' is the device's terminal state: the server refused
     *  the edit deterministically and no drain retries it until the
     *  worker retries or discards it on the device. */
    status: 'pending' | 'failed' | 'rejected';
    /** Optional: present when the last sync attempt errored. Trimmed to
     *  ~200 chars on the server before persist so a chatty backend
     *  message can't bloat the row. */
    lastError?: string | null;
    /** Number of failed sync attempts; helps the admin distinguish
     *  "device has been offline" from "this record keeps failing". */
    attempts?: number;
  }>;
}

/** Cap on the JSONB blob so a stuck or malicious client cannot fill the
 *  table. Beyond this we truncate the queuedRecords array. */
const MAX_RECORDS_PER_DEPLOYMENT = 500;
/** Cap on lastError length before persist. */
const MAX_ERROR_LENGTH = 200;

export interface UpsertManifestInput {
  userId: string;
  deviceFingerprint: string;
  manifest: ManifestEntry[];
  storageUsage?: number | bigint | null | undefined;
  storageQuota?: number | bigint | null | undefined;
  userAgent?: string | null | undefined;
}

/**
 * Tier 4 of the field-offline resilience model (see
 * docs/field-offline-areas.md). The field client posts a manifest
 * periodically; we upsert the row keyed on (userId, deviceFingerprint)
 * so the admin "field queues" view always reflects current state. We
 * never reconcile against this; recovery still flows through the
 * client's own sync. The mirror is purely a beacon for human
 * intervention ("user X has 47 records stuck, oldest from 3 days ago").
 */
@Injectable()
export class FieldQueueService {
  private readonly logger = new Logger(FieldQueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsertManifest(input: UpsertManifestInput): Promise<void> {
    const sanitized = sanitizeManifest(input.manifest);
    const usage = toBigInt(input.storageUsage);
    const quota = toBigInt(input.storageQuota);
    const userAgent = input.userAgent?.slice(0, 512) ?? null;

    await this.prisma.fieldQueueManifest.upsert({
      where: {
        userId_deviceFingerprint: {
          userId: input.userId,
          deviceFingerprint: input.deviceFingerprint,
        },
      },
      create: {
        userId: input.userId,
        deviceFingerprint: input.deviceFingerprint,
        manifest: sanitized as unknown as Prisma.InputJsonValue,
        storageUsage: usage,
        storageQuota: quota,
        userAgent,
      },
      update: {
        manifest: sanitized as unknown as Prisma.InputJsonValue,
        storageUsage: usage,
        storageQuota: quota,
        userAgent,
        // Bump reportedAt explicitly: the @default(now()) only fires on
        // create, but the admin view needs to know "when did we last
        // hear from this device".
        reportedAt: new Date(),
      },
    });
  }

  /**
   * Admin: every device that has reported in. Joined with the user so
   * the admin sees "Alice on iPhone Safari, 47 records stuck", not a
   * raw uuid.
   *
   * Scoped to one org -- admin is org-scoped today. We filter via
   * `user.orgId` rather than carrying orgId on the manifest table; if
   * a user moves between orgs (rare) we follow them automatically.
   */
  async listManifestsForOrg(orgId: string) {
    return this.prisma.fieldQueueManifest.findMany({
      where: { user: { orgId } },
      orderBy: [{ reportedAt: 'desc' }],
      take: 500,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            fullName: true,
          },
        },
      },
    });
  }
}

/** Bound the manifest size and trim error strings before persist. */
function sanitizeManifest(input: ManifestEntry[] | null | undefined): ManifestEntry[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((entry) => ({
    dataCollectionId: String(entry?.dataCollectionId ?? ''),
    cachedAt: entry?.cachedAt ? String(entry.cachedAt) : null,
    queuedRecords: Array.isArray(entry?.queuedRecords)
      ? entry.queuedRecords.slice(0, MAX_RECORDS_PER_DEPLOYMENT).map((r) => {
          const out: ManifestEntry['queuedRecords'][number] = {
            id: String(r?.id ?? ''),
            op:
              r?.op === 'insert' || r?.op === 'update' || r?.op === 'delete'
                ? r.op
                : 'insert',
            layerId: String(r?.layerId ?? ''),
            queuedAt: r?.queuedAt ? String(r.queuedAt) : '',
            status:
              r?.status === 'failed' || r?.status === 'rejected'
                ? r.status
                : 'pending',
            lastError:
              typeof r?.lastError === 'string'
                ? r.lastError.slice(0, MAX_ERROR_LENGTH)
                : null,
          };
          // Only include `attempts` when the client sent a number;
          // exactOptionalPropertyTypes refuses `undefined` for an
          // optional-with-no-undefined type.
          if (typeof r?.attempts === 'number') out.attempts = r.attempts;
          return out;
        })
      : [],
  }));
}

function toBigInt(v: number | bigint | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (!Number.isFinite(v) || v < 0) return null;
  // Cap at 2^53 to stay inside JS-safe range when the client posts a
  // raw number; navigator.storage.estimate() never reports anywhere
  // close to this in practice.
  return BigInt(Math.min(v, Number.MAX_SAFE_INTEGER));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';

import { stagingDiskPath } from '../ingest/ingest-staging.service.js';
import { isAnalysisEnabled } from '../analysis/analysis-tiers.js';
import { PrismaService } from '../prisma/prisma.service.js';

const TIMEOUT_MS = 2000;

export type CheckState = 'ok' | 'down' | 'unconfigured';

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function originOnly(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Privileged readiness. The public /health probe stays a database
 * check with no dependency names beyond that. This one adds object
 * storage, the identity realm, and the job queue, and it does not
 * return credentials or URLs that contain them.
 */
/**
 * Analysis is on when ANALYSIS_TIERS includes server-heavy, the same
 * switch the API uses to accept or refuse analysis work. GRATIS_ANALYSIS
 * is a NAS bootstrap input that never reaches portal-api.
 */
export function analysisConfigured(
  tiers: string | undefined = process.env.ANALYSIS_TIERS,
): 'on' | 'off' {
  return isAnalysisEnabled(tiers) ? 'on' : 'off';
}

@Injectable()
export class ReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<{
    database: CheckState;
    objectStore: CheckState;
    identity: CheckState;
    queue: CheckState;
    analysis: { configured: string; diskWarning: boolean };
  }> {
    const database = await this.pingDatabase();
    const objectStore = await this.ping(originOnly(process.env.MINIO_ENDPOINT), '/minio/health/live');
    const identity = await this.ping(
      originOnly(process.env.KEYCLOAK_URL),
      `/realms/${encodeURIComponent(process.env.KEYCLOAK_REALM || 'gratis')}/.well-known/openid-configuration`,
    );
    const queue = await this.pingQueue();
    const configured = analysisConfigured();
    return {
      database,
      objectStore,
      identity,
      queue,
      analysis: {
        configured,
        diskWarning: configured === 'on' && (await this.lowDisk()),
      },
    };
  }

  private async pingDatabase(): Promise<CheckState> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`);
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async pingQueue(): Promise<CheckState> {
    try {
      await withTimeout(this.prisma.importJob.count({ where: { status: 'running' } }));
      return 'ok';
    } catch {
      return 'down';
    }
  }

  private async ping(origin: string | null, path: string): Promise<CheckState> {
    if (!origin) return 'unconfigured';
    try {
      const res = await withTimeout(fetch(`${origin}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }));
      return res.ok ? 'ok' : 'down';
    } catch {
      return 'down';
    }
  }

  private async lowDisk(): Promise<boolean> {
    try {
      const { statfs } = await import('node:fs/promises');
      const stat = await statfs(stagingDiskPath());
      const free = BigInt(stat.bsize) * BigInt(stat.bavail);
      return free < 2n * 1024n * 1024n * 1024n;
    } catch {
      return false;
    }
  }
}

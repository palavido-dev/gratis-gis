// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  decryptWithKey,
  loadKeyFromEnv,
} from '../items/credential-cipher.js';
import { AdminAuditService } from './admin-audit.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

const NOT_COVERED = [
  'postgres password',
  'keycloak client secret',
  'keycloak admin secret',
  'minio root credentials',
] as const;

interface CipherRow {
  id: string;
  aad: string;
  ciphertext: string;
  iv: string;
}

/**
 * Re-encrypt application credential blobs with a new key file.
 * Database passwords and identity client secrets are not these blobs.
 * The previous key stays in the operator's env file until they replace
 * it; this service does not write that file.
 */
@Injectable()
export class CredentialRekeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  coverage() {
    return { rotates: ['item credentials', 'org ai provider secret'], notCovered: [...NOT_COVERED] };
  }

  async preflight(): Promise<{ credentials: number; aiProviders: number; unreadable: number }> {
    const rows = await this.loadRows();
    const key = loadKeyFromEnv();
    let unreadable = 0;
    for (const row of rows) {
      try {
        decryptWithKey(row.ciphertext, row.iv, row.aad, key);
      } catch {
        unreadable += 1;
      }
    }
    return {
      credentials: rows.filter((row) => row.aad && !row.aad.startsWith('ai-provider:')).length,
      aiProviders: rows.filter((row) => row.aad.startsWith('ai-provider:')).length,
      unreadable,
    };
  }

  /**
   * The mutation stays closed. A successful rewrite would leave
   * ciphertext that other API and worker processes cannot read until
   * every replica is restarted onto the new key, and a crash between
   * the write and that restart is not recovered by a SQL rollback.
   */
  async refuse(user: AuthUser): Promise<never> {
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'credential.rekey',
      targetType: 'credentials',
      targetId: user.orgId,
      outcome: 'failed',
      detail: { phase: 'disabled' },
    });
    throw new BadRequestException(
      'Application rekey is not enabled. Ciphertext was not changed. Database passwords and identity secrets are not part of this action.',
    );
  }

  async rekey(user: AuthUser, _confirm: string): Promise<never> {
    return this.refuse(user);
  }

  private async loadRows(): Promise<CipherRow[]> {
    const [credentials, providers] = await Promise.all([
      this.prisma.itemCredential.findMany({
        select: { id: true, itemId: true, encryptedPayload: true, iv: true },
      }),
      this.prisma.orgAiProvider.findMany({
        select: { orgId: true, encryptedSecret: true, encryptedSecretIv: true },
      }),
    ]);
    return [
      ...credentials.map((row) => ({
        id: row.id,
        aad: row.itemId,
        ciphertext: row.encryptedPayload,
        iv: row.iv,
      })),
      ...providers.map((row) => ({
        id: row.orgId,
        aad: `ai-provider:${row.orgId}`,
        ciphertext: row.encryptedSecret,
        iv: row.encryptedSecretIv,
      })),
    ];
  }
}

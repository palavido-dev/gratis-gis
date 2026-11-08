// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';

import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  decryptWithKey,
  encryptWithKey,
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

  async rekey(user: AuthUser, confirm: string): Promise<{ rewritten: number; notCovered: string[] }> {
    if (confirm !== 'rekey-application-credentials') {
      throw new BadRequestException('Confirmation phrase was not accepted.');
    }
    const file = process.env.GRATIS_REKEY_NEW_KEY_FILE;
    if (!file || file.includes('\0') || file.split(/[/\\]/).includes('..')) {
      throw new BadRequestException('Set GRATIS_REKEY_NEW_KEY_FILE to the new key file first.');
    }
    let next: Buffer;
    try {
      next = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    } catch {
      throw new BadRequestException('The new key file could not be read.');
    }
    if (next.length !== 32) {
      throw new BadRequestException('The new key must be 32 bytes, base64-encoded.');
    }
    const current = loadKeyFromEnv();
    const rows = await this.loadRows();
    const plain: string[] = [];
    try {
      for (const row of rows) {
        plain.push(decryptWithKey(row.ciphertext, row.iv, row.aad, current));
      }
    } catch {
      plain.fill('');
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'credential.rekey',
        targetType: 'credentials',
        targetId: user.orgId,
        outcome: 'failed',
        detail: { phase: 'preflight' },
      });
      throw new BadRequestException('A stored credential could not be opened with the current key.');
    }
    const rewritten = rows.map((row, index) => ({
      ...row,
      next: encryptWithKey(plain[index] ?? '', row.aad, next),
    }));
    try {
      await this.prisma.$transaction(async (tx) => {
        for (const row of rewritten) {
          if (row.aad.startsWith('ai-provider:')) {
            await tx.orgAiProvider.update({
              where: { orgId: row.id },
              data: { encryptedSecret: row.next.ciphertext, encryptedSecretIv: row.next.iv },
            });
          } else {
            await tx.itemCredential.update({
              where: { id: row.id },
              data: { encryptedPayload: row.next.ciphertext, iv: row.next.iv },
            });
          }
        }
      });
      for (const row of rewritten) {
        const opened = decryptWithKey(row.next.ciphertext, row.next.iv, row.aad, next);
        if (opened !== (plain[rewritten.indexOf(row)] ?? '')) {
          throw new Error('verify');
        }
      }
    } catch {
      await this.restore(rows);
      plain.fill('');
      await this.audit.record({
        orgId: user.orgId,
        actorUserId: user.id,
        action: 'credential.rekey',
        targetType: 'credentials',
        targetId: user.orgId,
        outcome: 'failed',
        detail: { phase: 'verify' },
      });
      throw new BadRequestException('Rekey was rolled back. The previous ciphertext is in place.');
    }
    plain.fill('');
    await this.audit.record({
      orgId: user.orgId,
      actorUserId: user.id,
      action: 'credential.rekey',
      targetType: 'credentials',
      targetId: user.orgId,
      outcome: 'succeeded',
      detail: { rewritten: rewritten.length },
    });
    return { rewritten: rewritten.length, notCovered: [...NOT_COVERED] };
  }

  private async restore(rows: CipherRow[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const row of rows) {
        if (row.aad.startsWith('ai-provider:')) {
          await tx.orgAiProvider.update({
            where: { orgId: row.id },
            data: { encryptedSecret: row.ciphertext, encryptedSecretIv: row.iv },
          });
        } else {
          await tx.itemCredential.update({
            where: { id: row.id },
            data: { encryptedPayload: row.ciphertext, iv: row.iv },
          });
        }
      }
    });
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

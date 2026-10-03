// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  decryptCredential,
  encryptCredential,
} from '../items/credential-cipher.js';
import {
  assertCompatibleBaseUrl,
  isAiProviderId,
  type AiProviderId,
  type StoredAiSecret,
} from './providers.js';

/**
 * What an admin client is allowed to see after a save. The raw key
 * is never included. `apiKeyConfigured` matches the SMTP
 * `hasPassword` flag: the UI can say a secret is stored without
 * reading it back.
 */
export interface PublicAiConfig {
  /** Row exists and the key decrypts into a usable provider. */
  configured: boolean;
  /** A row exists, even when the key cannot be decrypted. */
  saved: boolean;
  provider: AiProviderId | null;
  model: string | null;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
}

export const EMPTY_AI_CONFIG: PublicAiConfig = {
  configured: false,
  saved: false,
  provider: null,
  model: null,
  baseUrl: null,
  apiKeyConfigured: false,
};

export interface SaveAiConfigInput {
  provider: AiProviderId;
  model: string;
  baseUrl?: string | null | undefined;
  /** Omit or send empty to keep the stored key. Required on first save. */
  apiKey?: string | null | undefined;
}

@Injectable()
export class AiConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublic(orgId: string): Promise<PublicAiConfig> {
    const row = await this.prisma.orgAiProvider.findUnique({
      where: { orgId },
    });
    if (!row) return EMPTY_AI_CONFIG;
    const provider = isAiProviderId(row.provider) ? row.provider : null;
    const apiKey = this.tryDecrypt(row.encryptedSecret, row.encryptedSecretIv, orgId);
    const baseUrl = row.baseUrl;
    const baseOk = provider !== 'openai-compatible' || Boolean(baseUrl && baseUrl.trim());
    return {
      saved: true,
      configured: Boolean(provider && apiKey && baseOk),
      provider,
      model: row.model,
      baseUrl,
      apiKeyConfigured: Boolean(apiKey),
    };
  }

  /**
   * Decrypts the org key for a model call. Null when AI is off,
   * the row is incomplete, or the ciphertext cannot be read.
   * Callers treat null as "not configured" and make no request.
   */
  async loadUsable(orgId: string): Promise<StoredAiSecret | null> {
    const row = await this.prisma.orgAiProvider.findUnique({
      where: { orgId },
    });
    if (!row || !isAiProviderId(row.provider)) return null;
    const apiKey = this.tryDecrypt(row.encryptedSecret, row.encryptedSecretIv, orgId);
    if (!apiKey) return null;
    if (row.provider === 'openai-compatible') {
      if (!row.baseUrl || !row.baseUrl.trim()) return null;
      return {
        provider: row.provider,
        model: row.model,
        baseUrl: row.baseUrl,
        apiKey,
      };
    }
    return {
      provider: row.provider,
      model: row.model,
      baseUrl: null,
      apiKey,
    };
  }

  async save(
    orgId: string,
    actorId: string,
    input: SaveAiConfigInput,
  ): Promise<PublicAiConfig> {
    const model = input.model.trim();
    if (!model || model.length > 200) {
      throw new BadRequestException('A model name is required.');
    }
    if (/[\r\n]/.test(model)) {
      throw new BadRequestException('Model name cannot contain line breaks.');
    }

    let baseUrl: string | null = null;
    const rawBase = (input.baseUrl ?? '').trim();
    if (input.provider === 'openai-compatible') {
      if (!rawBase) {
        throw new BadRequestException(
          'A base URL is required for a local OpenAI-compatible endpoint.',
        );
      }
      baseUrl = await assertCompatibleBaseUrl(rawBase);
    } else if (rawBase) {
      throw new BadRequestException(
        'Base URL is only used for an OpenAI-compatible endpoint.',
      );
    }

    const existing = await this.prisma.orgAiProvider.findUnique({
      where: { orgId },
    });
    const pasted = (input.apiKey ?? '').trim();
    if (/[\r\n]/.test(pasted)) {
      throw new BadRequestException('API key cannot contain line breaks.');
    }

    let encryptedSecret = existing?.encryptedSecret ?? null;
    let encryptedSecretIv = existing?.encryptedSecretIv ?? null;
    if (pasted) {
      const enc = this.encrypt(pasted, orgId);
      encryptedSecret = enc.ciphertext;
      encryptedSecretIv = enc.iv;
    } else if (!encryptedSecret || !encryptedSecretIv) {
      throw new BadRequestException('An API key is required.');
    }

    await this.prisma.orgAiProvider.upsert({
      where: { orgId },
      create: {
        orgId,
        provider: input.provider,
        model,
        baseUrl,
        encryptedSecret,
        encryptedSecretIv,
        updatedBy: actorId,
      },
      update: {
        provider: input.provider,
        model,
        baseUrl,
        encryptedSecret,
        encryptedSecretIv,
        updatedBy: actorId,
      },
    });
    return this.getPublic(orgId);
  }

  async clear(orgId: string): Promise<PublicAiConfig> {
    await this.prisma.orgAiProvider.deleteMany({ where: { orgId } });
    return EMPTY_AI_CONFIG;
  }

  private encrypt(plaintext: string, orgId: string): { ciphertext: string; iv: string } {
    try {
      return encryptCredential(plaintext, aad(orgId));
    } catch {
      throw new ServiceUnavailableException(
        'CREDENTIAL_ENCRYPTION_KEY is not set, so AI provider secrets cannot be stored.',
      );
    }
  }

  private tryDecrypt(
    ciphertext: string,
    iv: string,
    orgId: string,
  ): string | null {
    try {
      const plain = decryptCredential(ciphertext, iv, aad(orgId));
      return plain.trim().length > 0 ? plain : null;
    } catch {
      return null;
    }
  }
}

function aad(orgId: string): string {
  return `ai-provider:${orgId}`;
}

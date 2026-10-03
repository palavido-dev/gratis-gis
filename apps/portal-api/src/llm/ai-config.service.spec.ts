// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import { _resetKeyCacheForTests, decryptCredential } from '../items/credential-cipher.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SECRET = 'sk-live-example-key-9f3a';

interface Row {
  orgId: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  encryptedSecret: string;
  encryptedSecretIv: string;
  updatedBy: string;
}

function memoryPrisma() {
  const rows = new Map<string, Row>();
  const prisma = {
    orgAiProvider: {
      findUnique: jest.fn(async ({ where }: { where: { orgId: string } }) => {
        return rows.get(where.orgId) ?? null;
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { orgId: string };
          create: Row;
          update: Omit<Row, 'orgId'>;
        }) => {
          const existing = rows.get(where.orgId);
          const next = existing ? { ...existing, ...update, orgId: where.orgId } : create;
          rows.set(where.orgId, next);
          return next;
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: { orgId: string } }) => {
        const had = rows.delete(where.orgId);
        return { count: had ? 1 : 0 };
      }),
    },
  };
  return { prisma, rows };
}

describe('AiConfigService', () => {
  const savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
    _resetKeyCacheForTests();
  });

  it('stores the key as ciphertext and returns only a configured flag', async () => {
    const { prisma, rows } = memoryPrisma();
    const svc = new AiConfigService(prisma as unknown as PrismaService);

    const saved = await svc.save(ORG, 'admin-1', {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: SECRET,
    });

    expect(saved).toEqual({
      configured: true,
      saved: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: null,
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);

    const row = rows.get(ORG);
    expect(row).toBeDefined();
    expect(row?.encryptedSecret).not.toBe(SECRET);
    expect(row?.encryptedSecret).not.toContain(SECRET);
    expect(
      decryptCredential(row!.encryptedSecret, row!.encryptedSecretIv, `ai-provider:${ORG}`),
    ).toBe(SECRET);

    const again = await svc.save(ORG, 'admin-1', {
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(again.model).toBe('gpt-4o');
    expect(again.apiKeyConfigured).toBe(true);
    expect(
      decryptCredential(
        rows.get(ORG)!.encryptedSecret,
        rows.get(ORG)!.encryptedSecretIv,
        `ai-provider:${ORG}`,
      ),
    ).toBe(SECRET);
  });

  it('rejects a base URL on a commercial provider and a metadata URL on a local one', async () => {
    const { prisma } = memoryPrisma();
    const svc = new AiConfigService(prisma as unknown as PrismaService);
    await expect(
      svc.save(ORG, 'admin-1', {
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: SECRET,
        baseUrl: 'https://example.com/v1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.save(ORG, 'admin-1', {
        provider: 'openai-compatible',
        model: 'llama3.2',
        apiKey: SECRET,
        baseUrl: 'http://169.254.169.254/latest',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the row', async () => {
    const { prisma, rows } = memoryPrisma();
    const svc = new AiConfigService(prisma as unknown as PrismaService);
    await svc.save(ORG, 'admin-1', {
      provider: 'xai',
      model: 'grok-3',
      apiKey: SECRET,
    });
    const cleared = await svc.clear(ORG);
    expect(cleared.configured).toBe(false);
    expect(cleared.saved).toBe(false);
    expect(rows.size).toBe(0);
    expect(await svc.loadUsable(ORG)).toBeNull();
  });
});

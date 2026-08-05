// SPDX-License-Identifier: AGPL-3.0-or-later
import { UnauthorizedException } from '@nestjs/common';

import { ApiKeyService } from './api-key.service.js';
import { hashApiKey } from './api-key-token.js';
import { effectiveCapabilities } from './capabilities.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth-sync.service.js';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    userId: 'user-1',
    name: 'nightly parcels',
    prefix: 'ggk_abc12345',
    readOnly: false,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(NOW),
    user: {
      id: 'user-1',
      orgId: 'org-1',
      username: 'matt',
      email: 'matt@example.org',
      orgRole: 'contributor' as const,
      deletedAt: null,
      autoDisableAt: null,
      org: { slug: 'randolph' },
    },
    ...overrides,
  };
}

function makePrisma(row: unknown) {
  return {
    apiKey: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue(row),
    },
    groupMember: {
      findMany: jest.fn().mockResolvedValue([{ groupId: 'g-1' }]),
    },
    userCapabilityOverride: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const svc = (prisma: unknown) =>
  new ApiKeyService(prisma as unknown as PrismaService);

describe('ApiKeyService.resolve', () => {
  it('builds the same AuthUser a JWT would, marked as a key', async () => {
    const prisma = makePrisma(makeRow());
    const user = await svc(prisma).resolve('ggk_whatever');

    expect(user.id).toBe('user-1');
    expect(user.orgId).toBe('org-1');
    // The SLUG, not the UUID: passing the UUID re-triggers the
    // phantom-org bug documented on AuthUser.orgSlug.
    expect(user.orgSlug).toBe('randolph');
    expect(user.orgRole).toBe('contributor');
    expect(user.groupIds).toEqual(['g-1']);
    expect([...user.capabilities].sort()).toEqual(
      [...effectiveCapabilities('contributor', [])].sort(),
    );
    expect(user.authKind).toBe('api_key');
    expect(user.apiKeyReadOnly).toBe(false);
  });

  it('looks the key up by hash, never by the raw token', async () => {
    const prisma = makePrisma(makeRow());
    await svc(prisma).resolve('ggk_secret');
    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashApiKey('ggk_secret') },
      }),
    );
  });

  it('applies capability overrides like the JWT path', async () => {
    const prisma = makePrisma(makeRow());
    prisma.userCapabilityOverride.findMany.mockResolvedValue([
      { capability: 'can_manage_basemaps', enabled: true },
    ]);
    const user = await svc(prisma).resolve('ggk_x');
    expect(user.capabilities.has('can_manage_basemaps')).toBe(true);
  });

  it('carries the read-only flag through to the guard', async () => {
    const user = await svc(makePrisma(makeRow({ readOnly: true }))).resolve(
      'ggk_x',
    );
    expect(user.apiKeyReadOnly).toBe(true);
  });

  describe('rejections', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown key', {}],
      ['revoked key', { revokedAt: new Date(NOW - HOUR) }],
      ['expired key', { expiresAt: new Date(NOW - HOUR) }],
      [
        'deleted owner',
        { user: { ...makeRow().user, deletedAt: new Date(NOW - HOUR) } },
      ],
      [
        'auto-disabled owner',
        {
          user: {
            ...makeRow().user,
            autoDisableAt: new Date(NOW - HOUR),
          },
        },
      ],
    ];

    it.each(cases)('rejects a %s', async (label, overrides) => {
      const row = label === 'unknown key' ? null : makeRow(overrides);
      await expect(svc(makePrisma(row)).resolve('ggk_x')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('gives every rejection the same message, leaking nothing', async () => {
      const messages = await Promise.all(
        cases.map(async ([label, overrides]) => {
          const row = label === 'unknown key' ? null : makeRow(overrides);
          try {
            await svc(makePrisma(row)).resolve('ggk_x');
            return 'no throw';
          } catch (err) {
            return (err as Error).message;
          }
        }),
      );
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('Invalid API key.');
    });

    it('still honours an admin exemption from auto-disable', async () => {
      const row = makeRow({
        user: {
          ...makeRow().user,
          orgRole: 'admin' as const,
          autoDisableAt: new Date(NOW - HOUR),
        },
      });
      await expect(svc(makePrisma(row)).resolve('ggk_x')).resolves.toBeTruthy();
    });

    it('accepts a future expiry', async () => {
      const row = makeRow({ expiresAt: new Date(NOW + HOUR) });
      await expect(svc(makePrisma(row)).resolve('ggk_x')).resolves.toBeTruthy();
    });
  });

  it('throttles last-used writes rather than writing every request', async () => {
    const prisma = makePrisma(makeRow());
    const service = svc(prisma);
    for (let i = 0; i < 5; i++) await service.resolve('ggk_x');
    // Fire-and-forget inside resolve; let the microtasks drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(prisma.apiKey.update).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeyService.create', () => {
  it('returns the token once and stores only its hash', async () => {
    const prisma = makePrisma(makeRow());
    prisma.apiKey.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeRow(), ...data, id: 'new-key' }),
    );
    const user = { id: 'user-1' } as AuthUser;
    const out = await svc(prisma).create(user, { name: '  nightly  ' });

    expect(out.token).toMatch(/^ggk_/);
    const stored = prisma.apiKey.create.mock.calls[0]![0].data;
    expect(stored.tokenHash).toBe(hashApiKey(out.token));
    // The plaintext must never reach the row.
    expect(JSON.stringify(stored)).not.toContain(out.token);
    expect(stored.name).toBe('nightly');
    expect(stored.expiresAt).toBeNull();
  });

  it('converts expiresInDays into a concrete future timestamp', async () => {
    const prisma = makePrisma(makeRow());
    prisma.apiKey.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeRow(), ...data }),
    );
    await svc(prisma).create({ id: 'user-1' } as AuthUser, {
      name: 'k',
      expiresInDays: 30,
    });
    const stored = prisma.apiKey.create.mock.calls[0]![0].data;
    const days = (stored.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('ApiKeyService.revoke', () => {
  it('scopes the lookup to the owner so ids cannot be guessed across users', async () => {
    const prisma = makePrisma(makeRow());
    await svc(prisma).revoke('user-1', 'key-1');
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 'key-1', userId: 'user-1' },
    });
  });

  it('rejects a key that is not the caller’s', async () => {
    const prisma = makePrisma(null);
    await expect(svc(prisma).revoke('user-2', 'key-1')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('is idempotent: re-revoking keeps the original timestamp', async () => {
    const first = new Date(NOW - HOUR);
    const prisma = makePrisma(makeRow({ revokedAt: first }));
    const out = await svc(prisma).revoke('user-1', 'key-1');
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
    expect(out.revokedAt).toBe(first);
  });
});

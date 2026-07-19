// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException } from '@nestjs/common';

import { OnboardingService } from './onboarding.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  SmtpConfig,
  SystemSettingsService,
} from '../notifications/system-settings.service.js';

/**
 * The service is thin glue over four queries; the interesting
 * behavior is the derivation rules (what counts as "done"), the
 * manual-vs-derived completion boundary, and defensive parsing of
 * the stored JSON. All of that is testable with plain stubs.
 */

interface StubWorld {
  smtp: SmtpConfig | null;
  userCount: number;
  hasMapOrSample: boolean;
  onboarding: unknown;
  writes: unknown[];
}

function makeService(world: StubWorld): OnboardingService {
  const prisma = {
    user: {
      count: jest.fn(async () => world.userCount),
    },
    item: {
      findFirst: jest.fn(async () =>
        world.hasMapOrSample ? { id: 'item-1' } : null,
      ),
    },
    organization: {
      findUniqueOrThrow: jest.fn(async () => ({
        onboarding: world.onboarding,
      })),
      update: jest.fn(async (args: { data: { onboarding: unknown } }) => {
        world.writes.push(args.data.onboarding);
        world.onboarding = args.data.onboarding;
        return {};
      }),
    },
  } as unknown as PrismaService;
  const settings = {
    getSmtpConfig: jest.fn(async () => world.smtp),
  } as unknown as SystemSettingsService;
  return new OnboardingService(prisma, settings);
}

function smtpConfigured(): SmtpConfig {
  return {
    enabled: true,
    host: 'smtp.example.org',
    port: 587,
    secure: false,
    fromAddress: 'noreply@example.org',
    fromDisplayName: 'Example',
    user: 'mailer',
    hasPassword: true,
  };
}

function freshWorld(overrides: Partial<StubWorld> = {}): StubWorld {
  return {
    smtp: null,
    userCount: 1,
    hasMapOrSample: false,
    onboarding: {},
    writes: [],
    ...overrides,
  };
}

const ORG = 'org-1';

describe('OnboardingService.getStatus derivation', () => {
  it('fresh org: everything open, badge counts all four', async () => {
    const svc = makeService(freshWorld());
    const status = await svc.getStatus(ORG);
    expect(status.items).toHaveLength(4);
    expect(status.items.every((i) => !i.done && !i.dismissed)).toBe(true);
    expect(status.openCount).toBe(4);
  });

  it('smtp row present but disabled does not count as done', async () => {
    const world = freshWorld({
      smtp: { ...smtpConfigured(), enabled: false },
    });
    const svc = makeService(world);
    const status = await svc.getStatus(ORG);
    const email = status.items.find((i) => i.key === 'configure-email');
    expect(email?.done).toBe(false);
    expect(email?.detail.smtpEnabled).toBe(false);
  });

  it('enabled smtp with a host counts as done', async () => {
    const svc = makeService(freshWorld({ smtp: smtpConfigured() }));
    const status = await svc.getStatus(ORG);
    expect(
      status.items.find((i) => i.key === 'configure-email')?.done,
    ).toBe(true);
  });

  it('invite-team flips at more than one member and reports the count', async () => {
    const solo = await makeService(freshWorld()).getStatus(ORG);
    expect(solo.items.find((i) => i.key === 'invite-team')?.done).toBe(false);

    const team = await makeService(freshWorld({ userCount: 3 })).getStatus(ORG);
    const invite = team.items.find((i) => i.key === 'invite-team');
    expect(invite?.done).toBe(true);
    expect(invite?.detail.memberCount).toBe(3);
  });

  it('first-map derives from map/sample existence', async () => {
    const with_ = await makeService(
      freshWorld({ hasMapOrSample: true }),
    ).getStatus(ORG);
    expect(with_.items.find((i) => i.key === 'first-map')?.done).toBe(true);
  });

  it('done and dismissed items both leave the badge count', async () => {
    const world = freshWorld({
      smtp: smtpConfigured(),
      onboarding: { dismissed: ['invite-team'] },
    });
    const status = await makeService(world).getStatus(ORG);
    expect(status.openCount).toBe(2); // first-map + admin-docs
  });

  it('hand-mangled stored state cannot crash the read', async () => {
    for (const bad of [null, 42, 'nope', [], { completed: 'x', dismissed: 9 }]) {
      const status = await makeService(
        freshWorld({ onboarding: bad }),
      ).getStatus(ORG);
      expect(status.openCount).toBe(4);
    }
  });
});

describe('mutations', () => {
  it('dismiss stores the key once and is idempotent', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    await svc.dismiss(ORG, 'invite-team');
    await svc.dismiss(ORG, 'invite-team');
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]).toEqual({
      completed: [],
      dismissed: ['invite-team'],
    });
  });

  it('complete works for the manual item and marks it done', async () => {
    const world = freshWorld();
    const svc = makeService(world);
    const status = await svc.complete(ORG, 'admin-docs');
    expect(status.items.find((i) => i.key === 'admin-docs')?.done).toBe(true);
  });

  it('complete rejects derived items', async () => {
    const svc = makeService(freshWorld());
    await expect(svc.complete(ORG, 'configure-email')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('restore clears both dismissal and manual completion', async () => {
    const world = freshWorld({
      onboarding: { completed: ['admin-docs'], dismissed: ['admin-docs'] },
    });
    const svc = makeService(world);
    const status = await svc.restore(ORG, 'admin-docs');
    const docs = status.items.find((i) => i.key === 'admin-docs');
    expect(docs?.done).toBe(false);
    expect(docs?.dismissed).toBe(false);
  });

  it('assertValidKey rejects unknown keys with a 400', () => {
    const svc = makeService(freshWorld());
    expect(() => svc.assertValidKey('drop-tables')).toThrow(
      BadRequestException,
    );
    expect(svc.assertValidKey('first-map')).toBe('first-map');
  });
});

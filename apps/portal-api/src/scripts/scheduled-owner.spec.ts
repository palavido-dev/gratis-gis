// SPDX-License-Identifier: AGPL-3.0-or-later
import { ScriptsService } from './scripts.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { SharingService } from '../items/sharing.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * A scheduled run acts as the script's owner, so a disabled owner
 * pauses the schedule. Disabling only flips Keycloak `enabled` plus
 * the local `disabled_at`; the script check has to read the latter.
 */
function build(owner: { deletedAt: Date | null; disabledAt: Date | null }) {
  const runs: Array<{ state: string; error?: string }> = [];
  const prisma = {
    item: {
      findFirst: jest.fn(async () => ({
        id: 's1',
        orgId: 'o1',
        ownerId: 'u1',
        data: { source: 'print(1)' },
      })),
    },
    user: {
      findFirst: jest.fn(
        async (args: { where: { deletedAt?: null; disabledAt?: null } }) => {
          if ('deletedAt' in args.where && owner.deletedAt !== null) return null;
          if ('disabledAt' in args.where && owner.disabledAt !== null) return null;
          return { id: 'u1' };
        },
      ),
    },
    scriptRun: {
      create: jest.fn(async ({ data }: { data: { state: string; error?: string } }) => {
        runs.push(data);
        return { id: 'r1' };
      }),
      findFirst: jest.fn(async () => null),
    },
  };
  const svc = new ScriptsService(
    prisma as unknown as PrismaService,
    {} as ItemsService,
    {} as SharingService,
  );
  return { svc, runs };
}

describe('ScriptsService.enqueueScheduled owner check', () => {
  it('skips the run when the owner is disabled', async () => {
    const { svc, runs } = build({ deletedAt: null, disabledAt: new Date() });
    await expect(svc.enqueueScheduled('s1')).resolves.toBeNull();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('skipped');
  });

  it('skips the run when the owner is deleted', async () => {
    const { svc, runs } = build({ deletedAt: new Date(), disabledAt: null });
    await expect(svc.enqueueScheduled('s1')).resolves.toBeNull();
    expect(runs[0]?.state).toBe('skipped');
  });

  it('queues the run for an enabled owner', async () => {
    const { runs, svc } = build({ deletedAt: null, disabledAt: null });
    await svc.enqueueScheduled('s1');
    expect(runs.some((r) => r.state === 'skipped')).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ROLE_BASELINES, type CapabilityKey } from '../auth/capabilities.js';
import { ItemsService } from '../items/items.service.js';
import { ScriptsService } from './scripts.service.js';

/**
 * A scheduled run executes with a key minted for the script's OWNER.
 * Anyone with edit access can change the source, so without these rules
 * an editor could write code and have it run on the next tick with the
 * owner's authority.
 */

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const EDITOR = '00000000-0000-0000-0000-0000000000e1';
const ORG = '00000000-0000-0000-0000-0000000000bb';
const NIGHTLY = { mode: 'daily', hour: 3, minute: 0 };

function user(id: string): AuthUser {
  return {
    id,
    orgId: ORG,
    orgRole: 'contributor',
    capabilities: new Set<CapabilityKey>(ROLE_BASELINES.contributor),
  } as unknown as AuthUser;
}

function itemsServiceFor(existing: { data: unknown }, captured: {
  data?: unknown;
}): ItemsService {
  const svc = Object.create(ItemsService.prototype) as ItemsService;
  const row = {
    id: 'script-1',
    orgId: ORG,
    ownerId: OWNER,
    type: 'script',
    title: 'Nightly',
    tags: [],
    data: existing.data,
    updatedAt: new Date(),
  };
  const prisma: Record<string, unknown> = {
    itemShare: { findMany: async () => [] },
    item: {
      findUnique: async () => row,
      update: async (args: { data: { data?: unknown } }) => {
        captured.data = args.data.data;
        return { ...row, ...args.data };
      },
    },
    // update() writes under the item row lock (lockItemRow), which
    // reads the stored data and updated_at as epoch ms.
    $queryRaw: async () => [
      { data: row.data, updated_at_ms: row.updatedAt.getTime() },
    ],
  };
  prisma.$transaction = async (fn: (tx: unknown) => unknown) => fn(prisma);
  Object.assign(svc, {
    get: async () => row,
    sharing: { canEdit: () => true },
    prisma,
  });
  return svc;
}

describe('ItemsService.update on a script', () => {
  const before = { version: 1, source: 'print("owner")', schedule: NIGHTLY };

  it('records an editor as the author of code they change', async () => {
    const captured: { data?: unknown } = {};
    await itemsServiceFor({ data: before }, captured).update(
      user(EDITOR),
      'script-1',
      { data: { ...before, source: 'steal()' } } as never,
    );
    expect((captured.data as { sourceEditedBy: string }).sourceEditedBy).toBe(
      EDITOR,
    );
  });

  it('ignores an author the client tries to set', async () => {
    const captured: { data?: unknown } = {};
    await itemsServiceFor({ data: before }, captured).update(
      user(EDITOR),
      'script-1',
      {
        data: { ...before, source: 'steal()', sourceEditedBy: OWNER },
      } as never,
    );
    expect((captured.data as { sourceEditedBy: string }).sourceEditedBy).toBe(
      EDITOR,
    );
  });

  it('keeps the previous author when an editor saves unchanged code', async () => {
    const captured: { data?: unknown } = {};
    await itemsServiceFor(
      { data: { ...before, sourceEditedBy: OWNER } },
      captured,
    ).update(user(EDITOR), 'script-1', {
      data: { ...before, notes: 'tidy' },
    } as never);
    expect((captured.data as { sourceEditedBy: string }).sourceEditedBy).toBe(
      OWNER,
    );
  });

  it('lets the owner approve code by saving it', async () => {
    const captured: { data?: unknown } = {};
    await itemsServiceFor(
      { data: { ...before, sourceEditedBy: EDITOR } },
      captured,
    ).update(user(OWNER), 'script-1', { data: { ...before } } as never);
    expect((captured.data as { sourceEditedBy: string }).sourceEditedBy).toBe(
      OWNER,
    );
  });

  it('refuses an editor adding or changing a schedule', async () => {
    const unscheduled = { version: 1, source: 'x' };
    await expect(
      itemsServiceFor({ data: unscheduled }, {}).update(
        user(EDITOR),
        'script-1',
        { data: { ...unscheduled, schedule: NIGHTLY } } as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      itemsServiceFor({ data: before }, {}).update(user(EDITOR), 'script-1', {
        data: { ...before, schedule: { ...NIGHTLY, hour: 4 } },
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an editor turn a schedule off', async () => {
    const captured: { data?: unknown } = {};
    await itemsServiceFor({ data: before }, captured).update(
      user(EDITOR),
      'script-1',
      { data: { version: 1, source: before.source } } as never,
    );
    expect(captured.data).toBeDefined();
  });
});

describe('ItemsService.revertToSnapshot on a script', () => {
  // A revert is an ordinary data save, so the provenance rules apply.
  function withSnapshot(svc: ItemsService, data: unknown): ItemsService {
    Object.assign(svc, {
      snapshots: {
        get: async () => ({ id: 'snap-1', itemId: 'script-1', data }),
        snapshot: async () => undefined,
      },
    });
    return svc;
  }

  it('makes a non-owner who reverts the author of the restored code', async () => {
    const captured: { data?: unknown } = {};
    const current = { version: 1, source: 'new()' };
    await withSnapshot(
      itemsServiceFor({ data: current }, captured),
      { version: 1, source: 'old()', sourceEditedBy: OWNER },
    ).revertToSnapshot(user(EDITOR), 'script-1', 'snap-1');
    expect(captured.data).toEqual({
      version: 1,
      source: 'old()',
      sourceEditedBy: EDITOR,
    });
  });

  it('refuses a non-owner revert that would bring back a schedule', async () => {
    await expect(
      withSnapshot(
        itemsServiceFor({ data: { version: 1, source: 'new()' } }, {}),
        { version: 1, source: 'old()', schedule: NIGHTLY },
      ).revertToSnapshot(user(EDITOR), 'script-1', 'snap-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ScriptsService.enqueueScheduled', () => {
  function serviceFor(data: unknown) {
    const created: Array<{ state?: string; error?: string }> = [];
    const prisma = {
      item: {
        findFirst: async () => ({ id: 'script-1', orgId: ORG, ownerId: OWNER, data }),
      },
      user: { findFirst: async () => ({ id: OWNER }) },
      scriptRun: {
        findFirst: async () => null,
        create: async (args: { data: { state?: string; error?: string } }) => {
          created.push(args.data);
          return { id: 'run-1' };
        },
      },
    };
    const svc = new ScriptsService(prisma as never, {} as never, {} as never);
    return { svc, created };
  }

  it('skips code someone other than the owner wrote', async () => {
    const { svc, created } = serviceFor({
      source: 'steal()',
      schedule: NIGHTLY,
      sourceEditedBy: EDITOR,
    });
    await expect(svc.enqueueScheduled('script-1')).resolves.toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe('skipped');
    expect(created[0]!.error).toMatch(/someone other than the owner/);
  });

  it('runs code the owner wrote', async () => {
    const { svc, created } = serviceFor({
      source: 'ok()',
      schedule: NIGHTLY,
      sourceEditedBy: OWNER,
    });
    await expect(svc.enqueueScheduled('script-1')).resolves.toBe('run-1');
    expect(created[0]!.state).toBeUndefined();
  });

  it('skips code with no recorded author until the owner saves it', async () => {
    const { svc, created } = serviceFor({ source: 'old()', schedule: NIGHTLY });
    await expect(svc.enqueueScheduled('script-1')).resolves.toBeNull();
    expect(created[0]!.state).toBe('skipped');
  });
});

describe('ItemsService.reassignOwner on a script', () => {
  const ADMIN = '00000000-0000-0000-0000-0000000000ad';

  function serviceFor(data: unknown) {
    const written: Array<{ ownerId?: string; data?: unknown }> = [];
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    const row = { id: 'script-1', orgId: ORG, ownerId: OWNER, type: 'script', data };
    const tx = {
      item: {
        update: async (args: { data: { ownerId?: string; data?: unknown } }) => {
          written.push(args.data);
          return { ...row, ...args.data };
        },
      },
      itemShare: { upsert: async () => ({}) },
    };
    Object.assign(svc, {
      get: async () => row,
      sharing: { canAdmin: () => true },
      noteAudit: () => undefined,
      prisma: {
        user: {
          findUnique: async () => ({
            id: ADMIN,
            orgId: ORG,
            orgRole: 'admin',
            deletedAt: null,
            capabilityOverrides: [],
          }),
        },
        $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
    });
    return { svc, written };
  }

  it('keeps the previous owner as the author, so an old script does not run as the new owner', async () => {
    const { svc, written } = serviceFor({ source: 'old()', schedule: NIGHTLY });
    await svc.reassignOwner(user(ADMIN), 'script-1', { newOwnerId: ADMIN });
    const stored = written[0]!;
    expect(stored.ownerId).toBe(ADMIN);
    expect(stored.data).toMatchObject({ sourceEditedBy: OWNER });
    // And the scheduler refuses it for the new owner.
    const { scheduledRunBlockedReason } = require('./script-provenance.js') as typeof import('./script-provenance.js');
    expect(
      scheduledRunBlockedReason({ ownerId: ADMIN, data: stored.data }),
    ).not.toBeNull();
  });
});

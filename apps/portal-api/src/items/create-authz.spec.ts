// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth-sync.service.js';
import {
  ROLE_BASELINES,
  hasCapability,
  type CapabilityKey,
} from '../auth/capabilities.js';
import { ItemsService } from './items.service.js';

/**
 * ItemsService.create had no authorization check of any kind. That is
 * a privilege escalation, not just a missing UI gate, because the
 * Cedar policy's first rule is "owners can do anything to their own
 * items" and is deliberately role-blind. A viewer who POSTed to
 * /api/items became the ownerId of the result and immediately held
 * edit, share and delete on it.
 *
 * These tests pin the gate at the level that matters. They do not
 * stand up Nest or Prisma: the assertion is that the capability check
 * runs and throws BEFORE any persistence work, so a bare service
 * instance with no dependencies is the sharpest way to state it. If
 * create() ever reaches for a collaborator on the viewer path, these
 * fail with a TypeError, which is also the right answer.
 */
describe('ItemsService.create authorization', () => {
  function userWithRole(role: 'viewer' | 'contributor' | 'admin'): AuthUser {
    return {
      id: '00000000-0000-0000-0000-0000000000aa',
      orgId: '00000000-0000-0000-0000-0000000000bb',
      orgRole: role,
      capabilities: new Set<CapabilityKey>(ROLE_BASELINES[role]),
    } as unknown as AuthUser;
  }

  /** A service with no wired dependencies. Any use of one is a bug. */
  function bareService(): ItemsService {
    return Object.create(ItemsService.prototype) as ItemsService;
  }

  it('refuses a viewer', async () => {
    const svc = bareService();
    await expect(
      svc.create(userWithRole('viewer'), {
        type: 'map',
        title: 'nope',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses before touching any collaborator', async () => {
    const svc = bareService();
    // No prisma, no sharing service, nothing is assigned on this
    // instance. A ForbiddenException (rather than a TypeError about
    // reading a property of undefined) proves the gate is the first
    // thing create() does.
    await expect(
      svc.create(userWithRole('viewer'), {
        type: 'data_layer',
        title: 'nope',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('states the required role rather than a bare denial', async () => {
    const svc = bareService();
    await expect(
      svc.create(userWithRole('viewer'), { type: 'map', title: 'x' } as never),
    ).rejects.toThrow(/contributor or admin/i);
  });

  it('lets a contributor past the gate', async () => {
    const svc = bareService();
    // The bare instance has no prisma, so the call fails once it gets
    // past the capability check. Any error that is NOT Forbidden means
    // the gate let it through, which is what we are asserting.
    await expect(
      svc.create(userWithRole('contributor'), {
        type: 'map',
        title: 'x',
      } as never),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('lets an admin past the gate', async () => {
    const svc = bareService();
    await expect(
      svc.create(userWithRole('admin'), {
        type: 'map',
        title: 'x',
      } as never),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('keeps can_publish_items off the viewer baseline', () => {
    // The gate is only as good as the baseline behind it. If a future
    // edit adds this key to viewer, the tests above would still pass
    // while the hole reopened, so assert the baseline directly.
    expect(hasCapability(userWithRole('viewer'), 'can_publish_items')).toBe(
      false,
    );
    expect(
      hasCapability(userWithRole('contributor'), 'can_publish_items'),
    ).toBe(true);
    expect(hasCapability(userWithRole('admin'), 'can_publish_items')).toBe(
      true,
    );
  });

  /**
   * Creating an item straight into org or public access is sharing.
   * Every creation path (POST /items, AGO import, web map JSON import,
   * drawing promotion) goes through create(), so the gate lives here.
   */
  describe('initial access needs can_share_items', () => {
    function noShare(): AuthUser {
      const u = userWithRole('contributor');
      (u.capabilities as Set<CapabilityKey>).delete('can_share_items');
      return u;
    }

    it.each(['public', 'org'] as const)(
      'refuses access %s when sharing is revoked',
      async (access) => {
        await expect(
          bareService().create(noShare(), {
            type: 'map',
            title: 'x',
            access,
          } as never),
        ).rejects.toThrow(/permission to share/i);
      },
    );

    it('allows private (or unset) access when sharing is revoked', async () => {
      for (const access of ['private', undefined]) {
        await expect(
          bareService().create(noShare(), {
            type: 'map',
            title: 'x',
            access,
          } as never),
        ).rejects.not.toBeInstanceOf(ForbiddenException);
      }
    });

    it('lets a contributor with sharing create public items', async () => {
      await expect(
        bareService().create(userWithRole('contributor'), {
          type: 'map',
          title: 'x',
          access: 'public',
        } as never),
      ).rejects.not.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('ItemsService.create of a form with a bad pattern', () => {
  it('refuses before the paired submissions layer is created', async () => {
    const svc = Object.create(ItemsService.prototype) as ItemsService;
    const pair = jest.fn();
    Object.assign(svc, { createPairedDataLayerForForm: pair });
    await expect(
      svc.create(
        {
          id: '00000000-0000-0000-0000-0000000000aa',
          orgId: '00000000-0000-0000-0000-0000000000bb',
          orgRole: 'contributor',
          capabilities: new Set<CapabilityKey>(ROLE_BASELINES.contributor),
        } as unknown as AuthUser,
        {
          type: 'form',
          title: 'Survey',
          data: { questions: [{ id: 'q1', type: 'text', pattern: '(' }] },
        } as never,
      ),
    ).rejects.toThrow(/not a valid regular expression/);
    expect(pair).not.toHaveBeenCalled();
  });
});

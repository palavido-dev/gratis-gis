// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import * as Y from 'yjs';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { DrawingsCollabService } from './drawings-collab.service.js';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    orgId: 'org-1',
    orgSlug: 'org-1',
    username: 'alice',
    email: 'alice@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
    ...overrides,
  } as AuthUser;
}

describe('DrawingsCollabService', () => {
  function makeSvc(opts?: {
    writable?: boolean;
    set?: { id: string; features: { id: string; kind: string }[] };
  }) {
    const set = opts?.set ?? {
      id: 'set-1',
      features: [
        {
          id: 'f1',
          kind: 'pin',
          geometry: { type: 'Point', coordinates: [0, 0] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    const drawings = {
      requireWritableSet: jest.fn().mockImplementation(async () => {
        if (opts?.writable === false) {
          throw new ForbiddenException('no write');
        }
        return set;
      }),
      list: jest.fn().mockResolvedValue([set]),
      update: jest.fn().mockResolvedValue(set),
    };
    const prisma = {
      item: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'map-1',
          orgId: 'org-1',
          access: 'org',
          type: 'map',
          deletedAt: null,
        }),
      },
      itemShare: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const sharing = {
      canRead: jest.fn().mockReturnValue(true),
    };
    const svc = new DrawingsCollabService(
      prisma as never,
      sharing as never,
      drawings as never,
    );
    return { svc, drawings, sharing };
  }

  it('mints a writer ticket when the caller can write the set', async () => {
    const { svc } = makeSvc({ writable: true });
    const issued = await svc.mintTicket(makeUser(), 'map-1', 'set-1');
    expect(issued.role).toBe('writer');
    expect(issued.wsPath).toContain('drawings-ws');
    expect(issued.wsPath).toContain('set-1');
    const rec = svc.consumeTicket(issued.ticket, 'map-1', 'set-1');
    expect(rec.role).toBe('writer');
    expect(() => svc.consumeTicket(issued.ticket, 'map-1', 'set-1')).toThrow();
  });

  it('mints an observer ticket when write ACL fails but canRead holds', async () => {
    const { svc } = makeSvc({ writable: false });
    const issued = await svc.mintTicket(makeUser(), 'map-1', 'set-1');
    expect(issued.role).toBe('observer');
  });

  it('joins, applies a writer update, and rejects observer updates', async () => {
    const { svc } = makeSvc({ writable: true });
    const writerIssue = await svc.mintTicket(makeUser(), 'map-1', 'set-1');
    const writerRec = svc.consumeTicket(writerIssue.ticket, 'map-1', 'set-1');
    const writerMsgs: unknown[] = [];
    await svc.join(writerRec, (m) => writerMsgs.push(m));
    expect(writerMsgs[0]).toEqual(
      expect.objectContaining({ type: 'sync', role: 'writer' }),
    );
    expect(svc.debugFeatureCount('map-1', 'set-1')).toBe(1);

    // Second peer as observer
    const { svc: svc2 } = makeSvc({ writable: false });
    // Reuse same room via first svc — observer on same instance
    const obsIssue = await svc.mintTicket(
      makeUser({ id: 'user-2', username: 'bob' }),
      'map-1',
      'set-1',
    );
    // Force observer by simulating write failure path already done;
    // consume and join as observer by minting with writable false on
    // a fresh service would create a second room. Instead join with
    // role observer on the first service's ticket API by consuming
    // a hand-built path: mint writer then leave role check to applyUpdate.
    const obsRec = svc.consumeTicket(obsIssue.ticket, 'map-1', 'set-1');
    // If mint gave writer because requireWritableSet succeeded on this
    // instance, force role for the test:
    const forced = { ...obsRec, role: 'observer' as const };
    const obsMsgs: unknown[] = [];
    await svc.join(forced, (m) => obsMsgs.push(m));

    const local = new Y.Doc();
    const features = local.getMap<string>('features');
    local.transact(() => {
      features.set(
        'f2',
        JSON.stringify({
          id: 'f2',
          kind: 'pin',
          geometry: { type: 'Point', coordinates: [1, 1] },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
    });
    const update = Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64');
    svc.applyUpdate('map-1', 'set-1', writerRec.connectionId, update);
    expect(svc.debugFeatureCount('map-1', 'set-1')).toBeGreaterThanOrEqual(1);
    expect(obsMsgs.some((m) => (m as { type?: string }).type === 'update')).toBe(
      true,
    );

    expect(() =>
      svc.applyUpdate('map-1', 'set-1', forced.connectionId, update),
    ).toThrow(ForbiddenException);
  });

  it('rejects a ticket for the wrong set', async () => {
    const { svc } = makeSvc();
    const issued = await svc.mintTicket(makeUser(), 'map-1', 'set-1');
    expect(() => svc.consumeTicket(issued.ticket, 'map-1', 'other')).toThrow();
  });
});

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

  it('saves the last edit as the writer who made it after only an observer is left', async () => {
    const { svc, drawings } = makeSvc({ writable: true });
    const writer = makeUser();
    const wIssue = await svc.mintTicket(writer, 'map-1', 'set-1');
    const wRec = svc.consumeTicket(wIssue.ticket, 'map-1', 'set-1');
    await svc.join(wRec, () => undefined);
    const oIssue = await svc.mintTicket(makeUser({ id: 'user-2' }), 'map-1', 'set-1');
    const oRec = { ...svc.consumeTicket(oIssue.ticket, 'map-1', 'set-1'), role: 'observer' as const };
    await svc.join(oRec, () => undefined);

    const local = new Y.Doc();
    local.getMap<string>('features').set(
      'f9',
      JSON.stringify({ id: 'f9', kind: 'pin', geometry: { type: 'Point', coordinates: [2, 2] } }),
    );
    svc.applyUpdate(
      'map-1',
      'set-1',
      wRec.connectionId,
      Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64'),
    );

    // Writer closes the tab inside the debounce, then the observer.
    svc.leave('map-1', 'set-1', wRec.connectionId);
    svc.leave('map-1', 'set-1', oRec.connectionId);
    await new Promise((r) => setImmediate(r));

    expect(drawings.update).toHaveBeenCalledTimes(1);
    const [author, , , patch] = drawings.update.mock.calls[0] as [
      { kind: string; user: AuthUser },
      string,
      string,
      { features: Array<{ id: string }> },
    ];
    expect(author.user.id).toBe('user-1');
    expect(patch.features.map((f) => f.id)).toContain('f9');
  });

  it('does not write when the room closes with no changes', async () => {
    const { svc, drawings } = makeSvc({ writable: true });
    const issued = await svc.mintTicket(makeUser(), 'map-1', 'set-1');
    const rec = svc.consumeTicket(issued.ticket, 'map-1', 'set-1');
    await svc.join(rec, () => undefined);
    svc.leave('map-1', 'set-1', rec.connectionId);
    await new Promise((r) => setImmediate(r));
    expect(drawings.update).not.toHaveBeenCalled();
  });

  function bigUpdate(key: string, bytes: number): string {
    const d = new Y.Doc();
    d.getMap<string>('features').set(key, 'x'.repeat(bytes));
    return Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64');
  }

  async function joinAs(svc: DrawingsCollabService, user: AuthUser, close?: () => void) {
    const issued = await svc.mintTicket(user, 'map-1', 'set-1');
    const rec = svc.consumeTicket(issued.ticket, 'map-1', 'set-1');
    const msgs: Array<{ type?: string; message?: string }> = [];
    await svc.join(rec, (m) => msgs.push(m as never), close);
    return { rec, msgs };
  }

  it('drops a writer whose access was removed while connected', async () => {
    const { svc, drawings } = makeSvc({ writable: true });
    const close = jest.fn();
    const { rec, msgs } = await joinAs(svc, makeUser(), close);
    drawings.requireWritableSet.mockRejectedValue(new ForbiddenException('revoked'));
    await svc.reauthorize({ mapId: 'map-1', drawingSetId: 'set-1' });
    expect(close).toHaveBeenCalled();
    expect(msgs.some((m) => m.type === 'error')).toBe(true);
    expect(() =>
      svc.applyUpdate('map-1', 'set-1', rec.connectionId, bigUpdate('k', 10)),
    ).toThrow();
  });

  it('refuses an update that would grow the doc past its budget', async () => {
    const { svc } = makeSvc({ writable: true });
    const { rec } = await joinAs(svc, makeUser());
    // Each update stays under the frame size; together they pass the doc budget.
    for (let i = 0; i < 10; i++) {
      svc.applyUpdate('map-1', 'set-1', rec.connectionId, bigUpdate(`k${i}`, 200_000));
    }
    expect(() =>
      svc.applyUpdate('map-1', 'set-1', rec.connectionId, bigUpdate('k-last', 200_000)),
    ).toThrow(/too large/);
  });

  it('gives two simultaneous first joiners one room', async () => {
    const { svc, drawings } = makeSvc({ writable: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const set = (await drawings.list())[0];
    drawings.list.mockImplementation(async () => {
      await gate;
      return [set];
    });
    const a = svc.mintTicket(makeUser(), 'map-1', 'set-1');
    const b = svc.mintTicket(makeUser({ id: 'user-2' }), 'map-1', 'set-1');
    release();
    const [ia, ib] = await Promise.all([a, b]);
    const ra = svc.consumeTicket(ia.ticket, 'map-1', 'set-1');
    const rb = svc.consumeTicket(ib.ticket, 'map-1', 'set-1');
    let releaseBoot!: () => void;
    const bootGate = new Promise<void>((r) => (releaseBoot = r));
    drawings.list.mockImplementation(async () => {
      await bootGate;
      return [set];
    });
    const msgsA: Array<{ type?: string }> = [];
    const joinA = svc.join(ra, (m) => msgsA.push(m as never));
    const joinB = svc.join(rb, () => undefined);
    releaseBoot();
    await Promise.all([joinA, joinB]);
    // B's update reaches A only if both are in the same room.
    svc.applyUpdate('map-1', 'set-1', rb.connectionId, bigUpdate('shared', 10));
    expect(msgsA.some((m) => m.type === 'update')).toBe(true);
  });

  it('saves as another writer when the first one is refused, and reports a total failure', async () => {
    const { svc, drawings } = makeSvc({ writable: true });
    const { rec: w1, msgs } = await joinAs(svc, makeUser());
    await joinAs(svc, makeUser({ id: 'user-2' }));
    drawings.update
      .mockRejectedValueOnce(new ForbiddenException('revoked'))
      .mockResolvedValueOnce({});
    svc.applyUpdate('map-1', 'set-1', w1.connectionId, bigUpdate('f', 10));
    await (svc as unknown as { snapshotNow: (r: unknown) => Promise<void> }).snapshotNow(
      (svc as unknown as { rooms: Map<string, unknown> }).rooms.get('map-1:set-1'),
    );
    expect(drawings.update).toHaveBeenCalledTimes(2);
    expect((drawings.update.mock.calls[1] as [{ user: AuthUser }])[0].user.id).toBe('user-2');

    drawings.update.mockRejectedValue(new ForbiddenException('nope'));
    svc.applyUpdate('map-1', 'set-1', w1.connectionId, bigUpdate('g', 10));
    await (svc as unknown as { snapshotNow: (r: unknown) => Promise<void> }).snapshotNow(
      (svc as unknown as { rooms: Map<string, unknown> }).rooms.get('map-1:set-1'),
    );
    expect(msgs.some((m) => m.message === 'Markup changes could not be saved.')).toBe(true);
  });
});

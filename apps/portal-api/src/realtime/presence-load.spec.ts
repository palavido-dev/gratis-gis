// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import { resetTenancyModeForTests } from '../common/tenancy.js';
import { PRESENCE_MAX_FRAMES_PER_SEC, RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/**
 * Every cursor frame used to load the whole map row (inline drawings
 * and all) plus its shares, with no limit on how fast a client sent.
 */
describe('presence load', () => {
  it('reads only the policy columns, and reuses a pass for a few seconds', async () => {
    const findFirst = jest.fn(async () => ({
      id: 'm1',
      orgId: 'o1',
      ownerId: 'u1',
      access: 'org',
    }));
    const prisma = {
      item: { findFirst },
      itemShare: { findMany: jest.fn(async () => []) },
      user: { findUnique: jest.fn(async () => ({ fullName: 'A', username: 'a' })) },
    };
    const svc = new RealtimeService(
      prisma as never,
      { canRead: () => true } as never,
    );
    const user = { id: 'u1', orgId: 'o1', username: 'a' } as never;
    for (let i = 0; i < 5; i++) {
      await svc.heartbeat(user, 'm1', { connectionId: 'u1-c', cursor: { lng: 1, lat: 1 } });
    }
    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = (findFirst.mock.calls[0] as unknown as [{ select: Record<string, boolean> }])[0];
    expect(args.select).toEqual({ id: true, orgId: true, ownerId: true, access: true });
  });

  it('drops frames above the per-connection rate', async () => {
    const heartbeat = jest.fn(async () => ({ members: [] }));
    const realtime = {
      consumeTicket: jest.fn(() => ({ user: { id: 'u1' }, connectionId: 'c1' })),
      subscribe: jest.fn(() => () => undefined),
      heartbeat,
      leave: jest.fn(async () => undefined),
    };
    const handlers: Record<string, (raw: unknown) => void> = {};
    const client = {
      readyState: 1,
      send: jest.fn(),
      close: jest.fn(),
      on: (event: string, fn: (raw: unknown) => void) => {
        handlers[event] = fn;
      },
    };
    const gateway = new RealtimeGateway(realtime as unknown as RealtimeService);
    await gateway.handleConnection(client as unknown as WebSocket, {
      url: '/api/realtime/ws?mapId=m1&ticket=t1',
    } as IncomingMessage);
    heartbeat.mockClear();
    for (let i = 0; i < 200; i++) {
      handlers.message!(JSON.stringify({ type: 'cursor', cursor: { lng: 0, lat: 0 } }));
    }
    await new Promise((r) => setImmediate(r));
    expect(heartbeat.mock.calls.length).toBeLessThanOrEqual(PRESENCE_MAX_FRAMES_PER_SEC);
  });
});

describe('presence across organizations', () => {
  const before = process.env.GRATIS_TENANCY;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });

  function service(): RealtimeService {
    const prisma = {
      item: { findFirst: jest.fn(async () => ({ id: 'm1', orgId: 'oA', ownerId: 'a1', access: 'public' })) },
      itemShare: { findMany: jest.fn(async () => []) },
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
          fullName: `Name of ${where.id}`,
          username: where.id,
        })),
      },
    };
    return new RealtimeService(prisma as never, { canRead: () => true } as never);
  }

  const a1 = { id: 'a1', orgId: 'oA', username: 'a1' } as never;
  const a2 = { id: 'a2', orgId: 'oA', username: 'a2' } as never;
  const b1 = { id: 'b1', orgId: 'oB', username: 'b1' } as never;

  it('many organizations: another organization is counted, not named', async () => {
    process.env.GRATIS_TENANCY = 'multi';
    resetTenancyModeForTests();
    const svc = service();
    const pushed: unknown[] = [];
    svc.subscribe('m1', (m) => pushed.push(m), 'oA');
    await svc.heartbeat(a1, 'm1', { connectionId: 'a1-c', cursor: { lng: 1, lat: 1 } });
    await svc.heartbeat(a2, 'm1', { connectionId: 'a2-c' });
    const asB = await svc.heartbeat(b1, 'm1', { connectionId: 'b1-c', cursor: { lng: 2, lat: 2 } });
    expect(asB.members).toHaveLength(3);
    const seenByB = asB.members.filter((m) => m.connectionId !== 'b1-c');
    expect(seenByB.every((m) => m.displayName === 'Guest' && m.userId === '' && m.cursor === null)).toBe(true);
    expect(JSON.stringify(asB.members)).not.toContain('Name of a');
    const asA = await svc.list(a1, 'm1');
    expect(asA.find((m) => m.connectionId === 'a2-c')?.displayName).toBe('Name of a2');
    expect(asA.find((m) => m.connectionId === 'b1-c')?.displayName).toBe('Guest');
    // The socket push to A's subscriber hides B the same way.
    const last = pushed[pushed.length - 1] as Array<{ connectionId: string; displayName: string }>;
    expect(last.find((m) => m.connectionId === 'b1-c')?.displayName).toBe('Guest');
    expect(last.find((m) => m.connectionId === 'a2-c')?.displayName).toBe('Name of a2');
  });

  it('one organization: every member is named, as before', async () => {
    delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
    const svc = service();
    await svc.heartbeat(a1, 'm1', { connectionId: 'a1-c' });
    const r = await svc.heartbeat(b1, 'm1', { connectionId: 'b1-c' });
    expect(r.members.find((m) => m.connectionId === 'a1-c')?.displayName).toBe('Name of a1');
  });
});

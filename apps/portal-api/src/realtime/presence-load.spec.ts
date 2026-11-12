// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

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

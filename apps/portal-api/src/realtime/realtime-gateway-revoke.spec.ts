// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import { RealtimeGateway } from './realtime.gateway.js';
import type { RealtimeService } from './realtime.service.js';

/**
 * The presence socket was authorized once, at connect. A user whose
 * share was revoked kept receiving collaborators' names and cursors
 * until they disconnected. A heartbeat that fails the read check now
 * closes the socket and stops the roster pushes.
 */
describe('RealtimeGateway after access is revoked', () => {
  it('closes the socket and unsubscribes when a heartbeat is refused', async () => {
    const unsubscribe = jest.fn();
    const realtime = {
      consumeTicket: jest.fn(() => ({ user: { id: 'u1' }, connectionId: 'c1' })),
      subscribe: jest.fn(() => unsubscribe),
      heartbeat: jest
        .fn()
        .mockResolvedValueOnce({ members: [] })
        .mockRejectedValueOnce(new ForbiddenException('You do not have access to this map')),
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
    expect(client.close).not.toHaveBeenCalled();

    handlers.message!(JSON.stringify({ type: 'heartbeat' }));
    await new Promise((r) => setImmediate(r));

    expect(unsubscribe).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });
});

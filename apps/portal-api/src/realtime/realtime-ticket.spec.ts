// SPDX-License-Identifier: AGPL-3.0-or-later
import { UnauthorizedException } from '@nestjs/common';
import { RealtimeService } from './realtime.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

function fakeUser(id = 'u1'): AuthUser {
  return {
    id,
    orgId: 'o1',
    orgSlug: 'demo',
    username: 'alice',
    email: 'a@example.com',
    orgRole: 'contributor',
    groupIds: [],
    capabilities: new Set(),
  };
}

describe('RealtimeService tickets', () => {
  it('mints and consumes a single-use ticket for the same map', async () => {
    const prisma = {
      item: {
        findFirst: jest.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          type: 'map',
          deletedAt: null,
          orgId: 'o1',
          access: 'org',
          ownerId: 'u1',
        }),
      },
      itemShare: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const sharing = { canRead: jest.fn().mockReturnValue(true) };
    const svc = new RealtimeService(prisma as never, sharing as never);
    const mapId = '11111111-1111-4111-8111-111111111111';
    const issued = await svc.mintTicket(fakeUser(), mapId);
    expect(issued.ticket.length).toBeGreaterThan(10);
    expect(issued.wsPath).toContain(mapId);
    expect(issued.wsPath).toContain(issued.ticket);

    const consumed = svc.consumeTicket(issued.ticket, mapId);
    expect(consumed.connectionId).toBe(issued.connectionId);
    expect(consumed.user.id).toBe('u1');

    expect(() => svc.consumeTicket(issued.ticket, mapId)).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a ticket for a different mapId', async () => {
    const prisma = {
      item: {
        findFirst: jest.fn().mockResolvedValue({
          id: '11111111-1111-4111-8111-111111111111',
          type: 'map',
          deletedAt: null,
          orgId: 'o1',
          access: 'org',
          ownerId: 'u1',
        }),
      },
      itemShare: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const sharing = { canRead: jest.fn().mockReturnValue(true) };
    const svc = new RealtimeService(prisma as never, sharing as never);
    const mapId = '11111111-1111-4111-8111-111111111111';
    const issued = await svc.mintTicket(fakeUser(), mapId);
    expect(() =>
      svc.consumeTicket(
        issued.ticket,
        '22222222-2222-4222-8222-222222222222',
      ),
    ).toThrow(UnauthorizedException);
  });
});

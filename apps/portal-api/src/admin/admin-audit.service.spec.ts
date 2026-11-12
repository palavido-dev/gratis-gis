// SPDX-License-Identifier: AGPL-3.0-or-later
import { AdminAuditService, sanitizeAuditDetail } from './admin-audit.service.js';

describe('sanitizeAuditDetail', () => {
  it('keeps the camelCase keys the item owner and share events send', () => {
    expect(
      sanitizeAuditDetail({
        previousOwnerId: 'u-1',
        ownerId: 'u-2',
        principalType: 'group',
        principalId: 'g-1',
      }),
    ).toEqual({
      previousOwnerId: 'u-1',
      ownerId: 'u-2',
      principalType: 'group',
      principalId: 'g-1',
    });
  });

  it('still drops secret-looking keys and email values', () => {
    expect(
      sanitizeAuditDetail({
        apiToken: 'abc',
        smtpPassword: 'x',
        contact: 'a@b.org',
        kept: 'yes',
      }),
    ).toEqual({ kept: 'yes' });
  });

  it('refuses keys that do not start with a lower-case letter', () => {
    expect(sanitizeAuditDetail({ Owner: 'x', _id: 'y', ok: 1 })).toEqual({ ok: 1 });
  });
});

describe('AdminAuditService.list', () => {
  it('passes Prisma a whole number for a fractional limit', async () => {
    const findMany = jest.fn(async () => []);
    const svc = new AdminAuditService({
      adminAuditEvent: { findMany, deleteMany: jest.fn(async () => ({ count: 0 })) },
    } as never);
    await svc.list('org-1', { limit: 1.5 });
    expect((findMany.mock.calls[0] as unknown as [{ take: number }])[0].take).toBe(2);
  });
});

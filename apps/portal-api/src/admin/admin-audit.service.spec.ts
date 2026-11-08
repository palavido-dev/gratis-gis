// SPDX-License-Identifier: AGPL-3.0-or-later
import { sanitizeAuditDetail } from './admin-audit.service.js';

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

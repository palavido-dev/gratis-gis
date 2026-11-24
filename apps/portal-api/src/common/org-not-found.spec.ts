// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { inCallerOrgOrNotFound, refuseAccess } from './org-not-found.js';

const caller = { orgId: 'org-1' };

describe('inCallerOrgOrNotFound', () => {
  it('returns a row of the caller org', () => {
    const row = { id: 'r', orgId: 'org-1' };
    expect(inCallerOrgOrNotFound(row, caller, 'Thing not found')).toBe(row);
  });

  it('answers a row of another org exactly like a missing row', () => {
    const other = (() => {
      try {
        inCallerOrgOrNotFound({ orgId: 'org-2' }, caller, 'Thing not found');
      } catch (e) {
        return e;
      }
    })();
    const missing = (() => {
      try {
        inCallerOrgOrNotFound(null, caller, 'Thing not found');
      } catch (e) {
        return e;
      }
    })();
    expect(other).toBeInstanceOf(NotFoundException);
    expect((other as NotFoundException).getResponse()).toEqual(
      (missing as NotFoundException).getResponse(),
    );
  });
});

describe('refuseAccess', () => {
  it('answers not found for a row of another org', () => {
    expect(() => refuseAccess(caller, { orgId: 'org-2' }, 'Thing not found', 'No access')).toThrow(
      NotFoundException,
    );
  });

  it('keeps forbidden, with its reason, inside the caller org', () => {
    expect(() => refuseAccess(caller, { orgId: 'org-1' }, 'Thing not found', 'No access')).toThrow(
      new ForbiddenException('No access'),
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ItemShare } from '@gratis-gis/shared-types';
import {
  EVERYONE_ELSE,
  matrixEntryFor,
  principalHasItemAccess,
  writeMatrixEntry,
} from './map-access-matrix';

const bob = { type: 'user' as const, id: 'bob' };
const crew = { type: 'group' as const, id: 'crew' };

describe('writeMatrixEntry', () => {
  it('keeps every other principal on the layer when one cell changes', () => {
    const next = writeMatrixEntry(undefined, [bob, crew], bob, { query: false }, true);
    expect(next.policy).toBe('custom');
    expect(matrixEntryFor(next, bob)).toMatchObject({ view: true, query: false });
    expect(matrixEntryFor(next, crew)).toMatchObject({ view: true, query: true });
  });

  it('changes only the one entry on a layer that is already custom', () => {
    const start = writeMatrixEntry(undefined, [bob, crew], bob, { query: false }, true);
    const next = writeMatrixEntry(start, [bob, crew], crew, { view: false }, true);
    expect(matrixEntryFor(next, bob)).toMatchObject({ view: true, query: false });
    expect(matrixEntryFor(next, crew)).toMatchObject({ view: false });
  });

  it('never stores edit on a layer that cannot be edited', () => {
    const next = writeMatrixEntry(undefined, [bob], bob, { edit: true }, false);
    expect(matrixEntryFor(next, bob).edit).toBe(false);
  });
});

describe('principalHasItemAccess', () => {
  const none: ItemShare[] = [];

  it('counts org-wide and public items and the owner as reachable', () => {
    expect(principalHasItemAccess(none, { access: 'public' }, bob, {})).toBe(true);
    expect(principalHasItemAccess(none, { access: 'org' }, crew, {})).toBe(true);
    expect(principalHasItemAccess(none, { access: 'private', ownerId: 'bob' }, bob, {})).toBe(true);
    expect(principalHasItemAccess(none, { access: 'private' }, bob, {})).toBe(false);
  });

  it('counts a share to one of the user\'s groups', () => {
    const shares = [{ principalType: 'group', principalId: 'crew' }] as ItemShare[];
    expect(principalHasItemAccess(shares, { access: 'private' }, bob, { bob: ['crew'] })).toBe(true);
  });
});

describe('Everyone else column', () => {
  it('is seeded with the inherited access when a layer turns custom', () => {
    const next = writeMatrixEntry(undefined, [bob, crew, EVERYONE_ELSE], bob, { view: false }, true);
    expect(next.entries.find((e) => e.principalType === 'everyone')).toMatchObject({
      principalId: '*',
      view: true,
      query: true,
    });
  });

  it('can be narrowed on its own', () => {
    const start = writeMatrixEntry(undefined, [bob, EVERYONE_ELSE], bob, { query: false }, true);
    const next = writeMatrixEntry(start, [bob, EVERYONE_ELSE], EVERYONE_ELSE, { view: false }, true);
    expect(matrixEntryFor(next, EVERYONE_ELSE).view).toBe(false);
    expect(matrixEntryFor(next, bob)).toMatchObject({ view: true, query: false });
  });

  it('is what an unlisted principal sees on a custom layer, as on the server', () => {
    const access = {
      policy: 'custom' as const,
      entries: [{ principalType: 'everyone' as const, principalId: '*', view: true, query: false, edit: false }],
    };
    expect(matrixEntryFor(access, crew)).toMatchObject({ principalType: 'group', view: true, query: false });
  });

  it('has item access only through the item access level', () => {
    expect(principalHasItemAccess([], { access: 'private' }, EVERYONE_ELSE, {})).toBe(false);
    expect(principalHasItemAccess([], { access: 'org' }, EVERYONE_ELSE, {})).toBe(true);
  });
});

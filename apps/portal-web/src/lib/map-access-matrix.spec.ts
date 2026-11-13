// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  matrixEntryFor,
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

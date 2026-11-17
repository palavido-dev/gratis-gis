// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  addRepeatInstance,
  applyValueUpdate,
  moveRankedItem,
  removeRepeatInstance,
  updateGroupAnswer,
  updateRepeatInstance,
} from './form-value-update';

/** A tiny stand-in for React's functional setState. */
function store<T>(initial: T) {
  let state = initial;
  return {
    get: () => state,
    set: (u: unknown) => {
      state = applyValueUpdate(u, state) as T;
    },
  };
}

describe('late writes inside a repeat group', () => {
  it('keeps notes typed while a photo uploaded', () => {
    const trees = store<unknown>([{ notes: '' }, { notes: '' }]);
    // The upload starts; meanwhile the collector types in both
    // instances.
    trees.set((p: unknown) => updateRepeatInstance(p, 0, 'notes', 'oak'));
    trees.set((p: unknown) => updateRepeatInstance(p, 1, 'notes', 'pine'));
    // The upload resolves and appends to the latest photo list.
    trees.set((p: unknown) =>
      updateRepeatInstance(p, 0, 'photos', (prev: unknown) => [
        ...(Array.isArray(prev) ? prev : []),
        { url: 'u1' },
      ]),
    );
    expect(trees.get()).toEqual([
      { notes: 'oak', photos: [{ url: 'u1' }] },
      { notes: 'pine' },
    ]);
  });

  it('does not resurrect an instance removed during an upload', () => {
    const trees = store<unknown>([{ a: 1 }, { a: 2 }]);
    trees.set((p: unknown) => addRepeatInstance(p));
    trees.set((p: unknown) => removeRepeatInstance(p, 1));
    trees.set((p: unknown) => updateRepeatInstance(p, 0, 'b', 'x'));
    expect(trees.get()).toEqual([{ a: 1, b: 'x' }, {}]);
  });

  it('drops a write for an instance that no longer exists', () => {
    const trees = store<unknown>([{ a: 1 }, { a: 2 }]);
    // Instance 1 had an upload in flight; instance 0 is removed, so
    // the old index 1 is past the end of the array.
    trees.set((p: unknown) => removeRepeatInstance(p, 0));
    trees.set((p: unknown) => updateRepeatInstance(p, 1, 'photo', 'u1'));
    expect(trees.get()).toEqual([{ a: 2 }]);
  });

  it('keeps both photos when two uploads finish back to back', () => {
    const answer = store<unknown>([]);
    const append = (photo: unknown) => (prev: unknown) => [
      ...(Array.isArray(prev) ? prev : []),
      photo,
    ];
    answer.set(append({ url: 'a' }));
    answer.set(append({ url: 'b' }));
    expect(answer.get()).toEqual([{ url: 'a' }, { url: 'b' }]);
  });

  it('updates a group from the latest value', () => {
    expect(updateGroupAnswer({ x: 1 }, 'y', 2)).toEqual({ x: 1, y: 2 });
    expect(updateGroupAnswer(undefined, 'y', (p: unknown) => (p ?? 0) as number)).toEqual({
      y: 0,
    });
  });
});

describe('moveRankedItem', () => {
  it('moves down by one, to the end, and up', () => {
    expect(moveRankedItem(['A', 'B', 'C'], 0, 1)).toEqual(['B', 'A', 'C']);
    expect(moveRankedItem(['A', 'B', 'C'], 0, 2)).toEqual(['B', 'C', 'A']);
    expect(moveRankedItem(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B']);
  });

  it('ignores a move out of range', () => {
    expect(moveRankedItem(['A', 'B'], 1, 2)).toEqual(['A', 'B']);
  });
});

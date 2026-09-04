// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  foldQueuedChain,
  foldQueuedEdits,
  type FoldableEdit,
} from './queue-fold.js';

// Shaped like a GeoJSON Point without depending on the ambient
// namespace: folding treats geometry as opaque and only ever decides
// whether to carry it forward.
const pt = (x: number) => ({ type: 'Point' as const, coordinates: [x, 0] });

const insert = (props: Record<string, unknown>, x = 1): FoldableEdit => ({
  op: 'insert',
  geometry: pt(x),
  properties: props,
});
const update = (
  props: Record<string, unknown>,
  geometry: unknown | null = null,
): FoldableEdit => ({ op: 'update', geometry, properties: props });
const del = (): FoldableEdit => ({
  op: 'delete',
  geometry: null,
  properties: null,
});

describe('foldQueuedEdits', () => {
  // This is the case that shipped as data loss: an offline capture
  // edited before it synced. The fold has to keep it an insert, or
  // replay PATCHes a globalId the server has never seen.
  it('keeps an edited-but-unsynced capture an insert', () => {
    const r = foldQueuedEdits(
      insert({ species: 'oak', dbh: 10 }),
      update({ dbh: 12 }),
    );
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.op).toBe('insert');
    expect(r.edit.properties).toEqual({ species: 'oak', dbh: 12 });
  });

  it('does not let an attribute-only edit erase the capture position', () => {
    // An edit with no geometry change sends geometry: null. Taking it
    // literally would strand the feature at null coordinates.
    const r = foldQueuedEdits(insert({ a: 1 }, 5), update({ a: 2 }, null));
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.geometry).toEqual(pt(5));
  });

  it('takes a moved geometry from the later edit', () => {
    const r = foldQueuedEdits(insert({ a: 1 }, 5), update({ a: 1 }, pt(9)));
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.geometry).toEqual(pt(9));
  });

  it('preserves keys the later form did not render', () => {
    // A preset parent FK is set at capture and not surfaced by the
    // edit form. A replace-the-bag merge would drop it and orphan the
    // related row.
    const r = foldQueuedEdits(
      insert({ parent_id: 'p1', note: 'first' }),
      update({ note: 'second' }),
    );
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.properties).toEqual({ parent_id: 'p1', note: 'second' });
  });

  it('annihilates a capture deleted before it ever synced', () => {
    expect(foldQueuedEdits(insert({ a: 1 }), del()).kind).toBe('annihilated');
  });

  it('lets a delete win over a pending update', () => {
    const r = foldQueuedEdits(update({ a: 1 }), del());
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.op).toBe('delete');
    expect(r.edit.properties).toBeNull();
    expect(r.edit.geometry).toBeNull();
  });

  it('merges two updates and keeps them an update', () => {
    const r = foldQueuedEdits(update({ a: 1, b: 1 }), update({ b: 2 }));
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.op).toBe('update');
    expect(r.edit.properties).toEqual({ a: 1, b: 2 });
  });

  it('treats a write after an undrained delete as an update', () => {
    // The delete has not reached the server, so the row is still
    // there. Sending an insert would depend on the server tolerating a
    // globalId it already holds.
    const r = foldQueuedEdits(del(), insert({ a: 1 }));
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.op).toBe('update');
  });
});

describe('foldQueuedChain', () => {
  it('collapses a long edit chain on one unsynced capture', () => {
    const r = foldQueuedChain([
      insert({ a: 1 }),
      update({ b: 2 }),
      update({ c: 3 }),
      update({ a: 9 }),
    ]);
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit.op).toBe('insert');
    expect(r.edit.properties).toEqual({ a: 9, b: 2, c: 3 });
  });

  it('stays annihilated even when edits follow the delete', () => {
    // Anything after the cancelling pair describes a feature the user
    // has deleted, so resurrecting it would contradict them.
    const r = foldQueuedChain([insert({ a: 1 }), del(), update({ a: 2 })]);
    expect(r.kind).toBe('annihilated');
  });

  it('returns a single edit unchanged', () => {
    const only = insert({ a: 1 });
    const r = foldQueuedChain([only]);
    expect(r.kind).toBe('replace');
    if (r.kind !== 'replace') return;
    expect(r.edit).toEqual(only);
  });

  it('refuses an empty chain rather than inventing an op', () => {
    expect(() => foldQueuedChain([])).toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { deltaChangeProperties, nextDeltaStep, type DeltaChangeLike } from './delta-sync.js';

const change = (over: Partial<DeltaChangeLike> = {}): DeltaChangeLike => ({
  observationId: 'obs-1',
  entity: 'ent-1',
  kind: 'update',
  syncVersion: 7,
  txTime: '2026-11-08T10:00:00.000Z',
  authorSub: 'boss',
  geometry: null,
  properties: { name: 'a' },
  ...over,
});

describe('nextDeltaStep', () => {
  it('stores the head when the page is complete', () => {
    expect(nextDeltaStep({ syncVersion: 9, changes: [], truncated: false }, 3)).toEqual({
      kind: 'done',
      cursor: 9,
    });
  });

  it('resumes inside a version with the composite cursor', () => {
    const page = {
      syncVersion: 9,
      changes: [change({ syncVersion: 7, observationId: 'last' })],
      truncated: true,
      nextSince: 7,
      nextAfter: 'last',
    };
    expect(nextDeltaStep(page, 3)).toEqual({
      kind: 'next',
      since: 7,
      after: 'last',
      safeCursor: 6,
    });
  });

  it('on a continuation page inside one version, keeps that version unfinished', () => {
    // The walk is in the middle of version 7 (since = 7 came from the
    // previous page). Storing 7 would skip the rest of it.
    const page = {
      syncVersion: 9,
      changes: [change({ syncVersion: 7 })],
      truncated: true,
      nextSince: 7,
      nextAfter: 'x',
    };
    expect(nextDeltaStep(page, 7)).toMatchObject({ kind: 'next', safeCursor: 6 });
  });

  it('on an older server, re-reads the last version from its start', () => {
    const page = {
      syncVersion: 9,
      changes: [change({ syncVersion: 4 }), change({ syncVersion: 6 })],
      truncated: true,
    };
    expect(nextDeltaStep(page, 3)).toEqual({ kind: 'next', since: 5, safeCursor: 5 });
  });

  it('on an older server, stalls when a page is all one version', () => {
    // Advancing to since=4 would skip the rest of version 4; this is
    // the loss the composite cursor exists to prevent.
    const page = {
      syncVersion: 9,
      changes: [change({ syncVersion: 4 }), change({ syncVersion: 4 })],
      truncated: true,
    };
    expect(nextDeltaStep(page, 3)).toEqual({ kind: 'stalled', safeCursor: 3 });
  });
});

describe('deltaChangeProperties', () => {
  it('carries the conflict token and editor fields a full read inlines', () => {
    expect(
      deltaChangeProperties(
        change({ createdBy: 'worker', createdAt: '2026-11-01T00:00:00.000Z' }),
      ),
    ).toEqual({
      name: 'a',
      _global_id: 'ent-1',
      _observation_id: 'obs-1',
      _edited_by: 'boss',
      _edited_at: '2026-11-08T10:00:00.000Z',
      _created_by: 'worker',
      _created_at: '2026-11-01T00:00:00.000Z',
    });
  });

  it('keeps the cached creation fields when an older server sends none', () => {
    const props = deltaChangeProperties(change(), {
      _created_by: 'worker',
      _created_at: '2026-11-01T00:00:00.000Z',
    });
    expect(props._created_by).toBe('worker');
    expect(props._created_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('uses the change itself for a create with no creation fields', () => {
    const props = deltaChangeProperties(change({ kind: 'create' }));
    expect(props._created_by).toBe('boss');
    expect(props._created_at).toBe('2026-11-08T10:00:00.000Z');
  });

  it('lets the server own underscore keys over stale attrs', () => {
    const props = deltaChangeProperties(
      change({ properties: { _observation_id: 'stale', _global_id: 'stale' } }),
    );
    expect(props._observation_id).toBe('obs-1');
    expect(props._global_id).toBe('ent-1');
  });
});

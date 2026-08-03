// SPDX-License-Identifier: AGPL-3.0-or-later
import { groupDanglingRefs } from './dangling-refs.js';

const referrer = (id: string, title: string, refs: string[]) => ({
  id,
  type: 'map',
  title,
  refs,
});

describe('groupDanglingRefs', () => {
  const live = new Set(['ok-1', 'ok-2']);
  const trash = new Set(['tr-1']);

  it('reports only referrers with unresolved refs', () => {
    const out = groupDanglingRefs(
      [
        referrer('m1', 'Healthy map', ['ok-1', 'ok-2']),
        referrer('m2', 'Broken map', ['ok-1', 'gone-1']),
      ],
      live,
      trash,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('m2');
    expect(out[0]!.missing).toEqual(['gone-1']);
    expect(out[0]!.trashed).toEqual([]);
  });

  it('splits hard-missing from trashed (recoverable)', () => {
    const out = groupDanglingRefs(
      [referrer('m1', 'Mixed', ['gone-1', 'tr-1', 'ok-1'])],
      live,
      trash,
    );
    expect(out[0]!.missing).toEqual(['gone-1']);
    expect(out[0]!.trashed).toEqual(['tr-1']);
  });

  it('de-dupes repeated refs and sorts hard breakage first', () => {
    const out = groupDanglingRefs(
      [
        referrer('a', 'Zeta trash-only', ['tr-1', 'tr-1']),
        referrer('b', 'Alpha missing', ['gone-2']),
      ],
      live,
      trash,
    );
    expect(out.map((r) => r.title)).toEqual([
      'Alpha missing',
      'Zeta trash-only',
    ]);
    expect(out[1]!.trashed).toEqual(['tr-1']);
  });

  it('returns empty for an org with no unresolved refs', () => {
    expect(
      groupDanglingRefs([referrer('m1', 'Fine', ['ok-1'])], live, trash),
    ).toEqual([]);
  });
});

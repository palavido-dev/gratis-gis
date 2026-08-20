// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  groupDanglingRefs,
  type DanglingRefCandidate,
} from './dangling-refs.js';

const referrer = (
  id: string,
  title: string,
  refs: string[],
): DanglingRefCandidate => ({
  id,
  type: 'map',
  title,
  scope: 'item',
  href: `/items/${id}`,
  refs,
});

const settingsReferrer = (refs: string[]): DanglingRefCandidate => ({
  id: 'org:landing-featured',
  type: 'Landing page',
  title: 'Featured items',
  scope: 'settings',
  href: '/admin/branding',
  note: 'The landing page silently skips featured items it cannot resolve.',
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

  // #238: the settings scope is the reason this takes a descriptor at
  // all. The client branches on `scope` to decide whether `type` is an
  // ItemType to look up or a label to print, and follows `href`
  // instead of deriving /items/<id> from the row id.
  it('carries the settings descriptor through to the row', () => {
    const out = groupDanglingRefs(
      [settingsReferrer(['gone-1', 'ok-1'])],
      live,
      trash,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'org:landing-featured',
      type: 'Landing page',
      scope: 'settings',
      href: '/admin/branding',
      missing: ['gone-1'],
    });
    expect(out[0]!.note).toMatch(/silently skips/);
  });

  it('leaves note absent (not undefined) on rows without one', () => {
    const out = groupDanglingRefs([referrer('m1', 'M', ['gone-1'])], live, trash);
    // A present-but-undefined key serializes as `"note": undefined`
    // dropped by JSON, but breaks exactOptionalPropertyTypes callers
    // that spread the row. Assert absence, not falsiness.
    expect(Object.hasOwn(out[0]!, 'note')).toBe(false);
  });

  it('reports item and settings referrers together', () => {
    const out = groupDanglingRefs(
      [referrer('m1', 'A broken map', ['gone-1']), settingsReferrer(['gone-2'])],
      live,
      trash,
    );
    expect(out.map((r) => r.scope).sort()).toEqual(['item', 'settings']);
  });
});

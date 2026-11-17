// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
import { LocalPreviews } from './form-local-previews';

describe('LocalPreviews', () => {
  function make() {
    let n = 0;
    const revoked: string[] = [];
    const previews = new LocalPreviews(
      () => `blob:local/${(n += 1)}`,
      (u) => revoked.push(u),
    );
    return { previews, revoked };
  }

  const uploaded = {
    url: '/api/portal/storage/private/feature-attachment/k1',
    key: 'feature-attachment/k1',
  };

  it('shows the local copy of a file this device uploaded, not the private url', () => {
    const { previews } = make();
    expect(previews.srcFor(uploaded)).toBe(uploaded.url);
    previews.remember(uploaded.key, new Blob(['x']));
    expect(previews.srcFor(uploaded)).toBe('blob:local/1');
  });

  it('falls back to inline bytes for an offline capture', () => {
    const { previews } = make();
    expect(previews.srcFor({ dataUrl: 'data:image/png;base64,AA==' })).toBe(
      'data:image/png;base64,AA==',
    );
  });

  it('releases every object URL on clear', () => {
    const { previews, revoked } = make();
    previews.remember('a', new Blob(['1']));
    previews.remember('a', new Blob(['2']));
    previews.remember('b', new Blob(['3']));
    expect(revoked).toEqual(['blob:local/1']);
    previews.clear();
    expect(revoked).toEqual(['blob:local/1', 'blob:local/2', 'blob:local/3']);
    expect(previews.srcFor({ key: 'a', url: '/x' })).toBe('/x');
  });
});

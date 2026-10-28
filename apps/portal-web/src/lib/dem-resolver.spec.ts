// SPDX-License-Identifier: AGPL-3.0-or-later
import { mapHasElevationSource } from './dem-resolver';

describe('mapHasElevationSource', () => {
  it('is false for missing / empty terrain', () => {
    expect(mapHasElevationSource(null)).toBe(false);
    expect(mapHasElevationSource(undefined)).toBe(false);
    expect(mapHasElevationSource({})).toBe(false);
    expect(mapHasElevationSource({ stack: [] })).toBe(false);
  });

  it('is true when a stack entry or legacy tileUrl is present', () => {
    expect(
      mapHasElevationSource({
        stack: [{ itemId: 'a', tileUrl: 'cog:///x' }],
      }),
    ).toBe(true);
    expect(
      mapHasElevationSource({
        itemId: 'a',
        tileUrl: 'cog:///x',
      }),
    ).toBe(true);
  });
});

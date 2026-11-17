// SPDX-License-Identifier: AGPL-3.0-or-later
import { textEnv } from './env.js';

describe('textEnv', () => {
  it('uses the fallback when Compose passes an unset setting as empty', () => {
    expect(textEnv(undefined, 'GratisGIS')).toBe('GratisGIS');
    expect(textEnv('', 'GratisGIS')).toBe('GratisGIS');
    expect(textEnv('   ', 'GratisGIS')).toBe('GratisGIS');
  });

  it('returns a set value without surrounding space', () => {
    expect(textEnv(' County GIS ', 'GratisGIS')).toBe('County GIS');
  });
});

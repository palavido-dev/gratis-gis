// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchAnchoredPattern } from '@gratis-gis/form-schema';
import { REGEX_PRESET_DEFS } from './regex-presets';

describe('regex presets', () => {
  it.each(REGEX_PRESET_DEFS)('$id matches its own sample', (p) => {
    expect(matchAnchoredPattern(p.pattern, p.flags ?? '', p.sample)).toBe(true);
  });

  it('24-hour time takes any valid time and nothing else', () => {
    const p = REGEX_PRESET_DEFS.find((d) => d.id === 'time24h')!.pattern;
    for (const ok of ['00:00', '09:05', '14:30', '23:59', '14:30:59']) {
      expect(matchAnchoredPattern(p, '', ok)).toBe(true);
    }
    for (const bad of ['14', '24:00', '9:05', '23:60']) {
      expect(matchAnchoredPattern(p, '', bad)).toBe(false);
    }
  });
});

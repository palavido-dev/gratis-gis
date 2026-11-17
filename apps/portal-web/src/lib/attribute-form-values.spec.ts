// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FeatureField } from '@gratis-gis/shared-types';
import { coerceArrayCodes, isMissingValue, seedFieldValue } from './attribute-form-values';

const field = (type: FeatureField['type']) => ({ name: 'f', type, nullable: true }) as FeatureField;

describe('attribute form values', () => {
  it('reads JSON array text from a map tile as codes', () => {
    expect(coerceArrayCodes('["a","b"]')).toEqual(['a', 'b']);
    expect(coerceArrayCodes('a, b')).toEqual(['a', 'b']);
    expect(coerceArrayCodes(['a', null, 2])).toEqual(['a', '2']);
  });

  it('types template presets for the field', () => {
    expect(seedFieldValue(field('boolean'), 'false')).toBe(false);
    expect(seedFieldValue(field('boolean'), 'No')).toBe(false);
    expect(seedFieldValue(field('boolean'), '1')).toBe(true);
    expect(seedFieldValue(field('boolean'), 'maybe')).toBeNull();
    expect(seedFieldValue(field('number'), '12.5')).toBe(12.5);
    expect(seedFieldValue(field('number'), 'abc')).toBeNull();
    expect(seedFieldValue(field('string'), 'x')).toBe('x');
    expect(seedFieldValue(field('boolean'), null)).toBeNull();
  });

  it('counts an empty pick as missing', () => {
    expect(isMissingValue([])).toBe(true);
    expect(isMissingValue('')).toBe(true);
    expect(isMissingValue(false)).toBe(false);
    expect(isMissingValue(['a'])).toBe(false);
  });
});

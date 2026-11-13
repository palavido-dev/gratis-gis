// SPDX-License-Identifier: AGPL-3.0-or-later
import { finalIdentifier, typingIdentifier } from './identifier-input';

/** Feed a string one key at a time through a controlled input. */
function typeInto(text: string): string {
  let value = '';
  for (const ch of text) value = typingIdentifier(value + ch);
  return value;
}

describe('identifier inputs', () => {
  it('keeps an underscore or space typed between words', () => {
    expect(typeInto('parcel_id')).toBe('parcel_id');
    expect(typeInto('site name')).toBe('site_name');
  });

  it('lets the box be emptied while typing', () => {
    expect(typingIdentifier('')).toBe('');
  });

  it('tidies the ends on blur', () => {
    expect(finalIdentifier(' Parcel ID_ ')).toBe('parcel_id');
    expect(finalIdentifier('__a__b__')).toBe('a_b');
  });

  it('uses the fallback only when given one', () => {
    expect(finalIdentifier('')).toBe('');
    expect(finalIdentifier('***', 'layer')).toBe('layer');
  });

  it('caps the length', () => {
    expect(finalIdentifier('a'.repeat(80))).toHaveLength(60);
  });
});

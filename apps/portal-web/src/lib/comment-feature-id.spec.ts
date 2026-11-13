// SPDX-License-Identifier: AGPL-3.0-or-later
import { commentFeatureIdForKey, stableFeatureId } from './comment-feature-id';

describe('commentFeatureIdForKey', () => {
  const features = [
    { id: 1, properties: {} },
    { id: 2, properties: {} },
    { properties: { id: 'p-3' } },
    { properties: { name: 'no id' } },
    { id: 5, properties: {} },
  ];

  it('translates a position key into that feature id', () => {
    // Position 4 holds the feature whose id is 5, not 4.
    expect(commentFeatureIdForKey(4, features)).toBe('5');
    expect(commentFeatureIdForKey(2, features)).toBe('p-3');
  });

  it('refuses a position whose feature has no id or is not loaded', () => {
    expect(commentFeatureIdForKey(3, features)).toBeNull();
    expect(commentFeatureIdForKey(9, features)).toBeNull();
    expect(commentFeatureIdForKey(0, null)).toBeNull();
  });

  it('keeps a global id key as it is', () => {
    expect(commentFeatureIdForKey('0190-abc', null)).toBe('0190-abc');
  });

  it('reads the same id the pin lookup reads', () => {
    expect(stableFeatureId({ id: 'a', properties: { _global_id: 'b' } })).toBe('a');
    expect(stableFeatureId({ properties: { _global_id: 'b', id: 'c' } })).toBe('b');
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  attributeLine,
  inlineFeatures,
  parseFeatureAnswer,
  questionTokens,
  UnusableFeatureAnswer,
} from './feature-ask';

describe('feature ask', () => {
  it('keeps distinctive words from the question', () => {
    expect(questionTokens('How many open hydrants are near the park?')).toEqual([
      'open',
      'hydrants',
      'park',
    ]);
  });

  it('reads v1 features stored on the item and skips their geometry', () => {
  const rows = inlineFeatures({
    version: 1,
    fields: [],
    data: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [1, 2] },
          properties: { name: 'Main Office' },
        },
      ],
    },
  });
  expect(rows).toEqual([{ id: 'row-1', properties: { name: 'Main Office' } }]);
  expect(inlineFeatures({ version: 3, layers: [] })).toEqual([]);
});

  it('keeps string attributes and skips geometry', () => {
    const line = attributeLine('abc', {
      status: 'open',
      geometry: { type: 'Point', coordinates: [1, 2] },
      note: '  north  side ',
    });
    expect(line.line).toBe('id=abc status=open note=north side');
    expect(line.attributes).toEqual({ status: 'open', note: 'north side' });
  });

  it('keeps only ids that were in the sample', () => {
    const parsed = parseFeatureAnswer(
      '```json\n{"answer":"Two are open.","ids":["a","nope","a","b"]}\n```',
      new Set(['a', 'b']),
    );
    expect(parsed).toEqual({ answer: 'Two are open.', ids: ['a', 'b'] });
  });

  it('refuses a reply that is not an answer', () => {
    expect(() => parseFeatureAnswer('hello', new Set(['a']))).toThrow(UnusableFeatureAnswer);
  });
});

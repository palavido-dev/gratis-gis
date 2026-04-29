import { extractDependencies } from './dependency-extractor.js';

describe('extractDependencies for derived_layer', () => {
  it('emits the source data layer as a hard forward edge', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: {
          kind: 'data_layer',
          itemId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
        pipeline: [
          { tool: 'buffer', params: { distance: 100, unit: 'meters' } },
        ],
        featureLimit: 1000,
        outputSchema: [],
        bbox: [],
      },
    });
    expect(result.itemIds).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
    expect(result.urls).toEqual([]);
  });

  it('returns no edges when the source ref is missing', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: { version: 1, pipeline: [] },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });

  it('returns no edges when source.itemId is the empty string', () => {
    const result = extractDependencies({
      type: 'derived_layer' as const,
      data: {
        version: 1,
        source: { kind: 'data_layer', itemId: '' },
        pipeline: [],
      },
    });
    expect(result).toEqual({ itemIds: [], urls: [] });
  });
});

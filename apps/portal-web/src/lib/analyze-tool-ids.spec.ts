// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  analyzeToolDeepLink,
  parseAnalyzeToolId,
} from './analyze-tool-ids';

describe('analyze-tool-ids', () => {
  it('parses known tool ids case-insensitively', () => {
    expect(parseAnalyzeToolId('buffer')).toBe('buffer');
    expect(parseAnalyzeToolId('Convex-Hull')).toBe('convex-hull');
    expect(parseAnalyzeToolId(' group-by ')).toBe('group-by');
  });

  it('rejects unknown tool ids', () => {
    expect(parseAnalyzeToolId(null)).toBeNull();
    expect(parseAnalyzeToolId('')).toBeNull();
    expect(parseAnalyzeToolId('watershed')).toBeNull();
  });

  it('builds a Data-tab deep link with tool and layer', () => {
    expect(analyzeToolDeepLink('abc', 'buffer', 'sites')).toBe(
      '/items/abc?tool=buffer&layer=sites#data',
    );
    expect(analyzeToolDeepLink('abc', 'centroid')).toBe(
      '/items/abc?tool=centroid#data',
    );
  });
});

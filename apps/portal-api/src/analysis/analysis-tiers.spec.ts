// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAnalysisEnabled } from './analysis-tiers.js';

describe('isAnalysisEnabled (#225)', () => {
  it('is off when ANALYSIS_TIERS is unset or empty', () => {
    expect(isAnalysisEnabled(undefined)).toBe(false);
    expect(isAnalysisEnabled('')).toBe(false);
    expect(isAnalysisEnabled('  ')).toBe(false);
  });

  it('is on when server-heavy is listed', () => {
    expect(isAnalysisEnabled('server-heavy')).toBe(true);
    expect(isAnalysisEnabled('browser,server-heavy')).toBe(true);
    expect(isAnalysisEnabled(' server-heavy , browser ')).toBe(true);
  });

  it('ignores unrelated tiers', () => {
    expect(isAnalysisEnabled('browser')).toBe(false);
    expect(isAnalysisEnabled('server-light')).toBe(false);
  });
});

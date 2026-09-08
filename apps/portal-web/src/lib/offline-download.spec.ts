// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="jest" />
/**
 * The pure parts of the download manager.
 *
 * `downloadDeployment` itself is a long fetch walk and is exercised by
 * hand; the two pieces below are the decisions it makes that a unit
 * test can pin. The estimate matters because the pre-flight quota
 * guard is the only thing standing between a collector and a download
 * that cannot fit, and it once left tiles out entirely.
 */
import { estimateDownloadBytes, isQuotaError } from './offline-download';
import { estimateTileCount, WARMER_MAX_TILES } from './offline-tile-warmer';

const BBOX: [number, number, number, number] = [-122.5, 37.7, -122.3, 37.9];

describe('estimateDownloadBytes', () => {
  it('charges features and headroom with no tiles configured', () => {
    // 2 layers * 50 assumed features * 800 bytes, plus the 5 MB
    // forms-and-pick-lists headroom.
    expect(estimateDownloadBytes({ layers: [{}, {}] })).toBe(
      2 * 50 * 800 + 5 * 1024 * 1024,
    );
  });

  it('adds the warmer tile walk, once per template', () => {
    const base = estimateDownloadBytes({ layers: [{}] });
    const one = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
    });
    const two = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png', 'https://b/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
    });
    const perTemplate = estimateTileCount(BBOX, [12, 14]) * 25_000;
    expect(perTemplate).toBeGreaterThan(0);
    expect(one - base).toBe(perTemplate);
    // The warmer fetches the bbox once per source, so the estimate
    // has to as well.
    expect(two - base).toBe(2 * perTemplate);
  });

  it('caps the tile count where the warmer caps its walk', () => {
    // A continent at z19 would enumerate billions of tiles; the warmer
    // stops at WARMER_MAX_TILES, so an estimate above that would refuse
    // a download the warmer would have truncated to fit.
    const huge = estimateDownloadBytes({
      layers: [],
      bbox: [-180, -85, 180, 85],
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 19],
    });
    expect(huge).toBe(5 * 1024 * 1024 + WARMER_MAX_TILES * 25_000);
  });

  it('ignores tiles when no bbox is given', () => {
    // The warmer cannot walk an unbounded area, and the download
    // manager skips warming without a bbox, so nothing to charge.
    expect(
      estimateDownloadBytes({
        layers: [{}],
        tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      }),
    ).toBe(estimateDownloadBytes({ layers: [{}] }));
  });

  it('charges prepared packages instead of tiles when both are present', () => {
    // A prepared package replaces tile warming outright in
    // downloadDeployment, so the two are never both paid for.
    const est = estimateDownloadBytes({
      layers: [{}],
      bbox: BBOX,
      tileUrlTemplates: ['https://a/{z}/{x}/{y}.png'],
      tileZoomRange: [12, 14],
      preparedPackages: [
        { areaId: 'a', packageId: 'p1' },
        { areaId: 'b', packageId: 'p2' },
      ],
    });
    expect(est).toBe(50 * 800 + 5 * 1024 * 1024 + 2 * 25 * 1024 * 1024);
  });
});

describe('isQuotaError', () => {
  it('recognises the standard DOMException name', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(
      true,
    );
  });

  it('recognises the legacy Firefox name and code 22', () => {
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
    expect(isQuotaError({ name: 'AbortError' })).toBe(false);
  });
});

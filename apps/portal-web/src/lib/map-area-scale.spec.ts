// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AREA_SCALE_MAX_PX,
  AREA_SCALE_MIN_PX,
  areaDecadeLadder,
  areaUnitIsImperial,
  defaultAreaScaleUnit,
  formatAreaScaleLabel,
  metersPerPixel,
  nextAreaScaleUnit,
  pickAreaScale,
} from '@/lib/map-area-scale';
import { SQM_PER_ACRE } from '@/lib/measure';

describe('metersPerPixel', () => {
  it('matches the equatorial z0 tile width', () => {
    // At z0 equator, one 256px tile spans the full circumference.
    const mpp = metersPerPixel(0, 0);
    expect(mpp).toBeCloseTo(40_075_016.686 / 256, 5);
  });

  it('halves when zoom increases by one', () => {
    const a = metersPerPixel(33, 10);
    const b = metersPerPixel(33, 11);
    expect(b).toBeCloseTo(a / 2, 10);
  });
});

describe('areaDecadeLadder', () => {
  it('is powers of ten', () => {
    const ladder = areaDecadeLadder('acres', 0.1, 1000);
    expect(ladder).toEqual([0.1, 1, 10, 100, 1000]);
  });
});

describe('pickAreaScale', () => {
  it('picks 1 acre near a typical parcel zoom', () => {
    // Side of 1 ac ≈ 63.6 m. Want that around ~40–60 px.
    const sideM = Math.sqrt(SQM_PER_ACRE);
    const mpp = sideM / 50; // 1 ac → 50 px
    const pick = pickAreaScale(mpp, 'acres');
    expect(pick).not.toBeNull();
    expect(pick!.value).toBe(1);
    expect(pick!.unit).toBe('acres');
    expect(pick!.label).toBe('1 ac');
    expect(pick!.sidePx).toBeCloseTo(50, 5);
  });

  it('steps up to 10 / 100 / 1000 acres as the map zooms out', () => {
    const side1 = Math.sqrt(SQM_PER_ACRE);
    // 1 ac would be ~8 px (too small); 10 ac → ~25 px still under
    // min; 100 ac → ~80 px over max — so with max 72, 10 ac at
    // ~25 px is the largest that fits (under max, even if under min).
    const mpp = side1 / 8;
    const pick = pickAreaScale(mpp, 'acres');
    expect(pick!.value).toBe(10);
    expect(pick!.sidePx).toBeLessThanOrEqual(AREA_SCALE_MAX_PX);
  });

  it('steps to 100 acres further out', () => {
    const side1 = Math.sqrt(SQM_PER_ACRE);
    // 1 ac → 2 px; 10 → ~6.3; 100 → 20; 1000 → 63.2. Readable pick: 1000.
    const mpp = side1 / 2;
    const pick = pickAreaScale(mpp, 'acres');
    expect(pick!.value).toBe(1000);
    expect(pick!.sidePx).toBeGreaterThanOrEqual(AREA_SCALE_MIN_PX);
    expect(pick!.sidePx).toBeLessThanOrEqual(AREA_SCALE_MAX_PX);
  });

  it('picks hectares on the metric ladder', () => {
    // 1 ha = 10_000 m² → side 100 m. Target ~40 px → mpp = 2.5.
    const pick = pickAreaScale(2.5, 'hectares');
    expect(pick!.value).toBe(1);
    expect(pick!.label).toBe('1 ha');
    expect(pick!.sidePx).toBeCloseTo(40, 5);
  });

  it('never lies about the drawn size vs the label', () => {
    const mpp = 5;
    const pick = pickAreaScale(mpp, 'acres')!;
    const expectedSide = Math.sqrt(pick.value * SQM_PER_ACRE) / mpp;
    expect(pick.sidePx).toBeCloseTo(expectedSide, 10);
  });

  it('returns null for bad meters-per-pixel', () => {
    expect(pickAreaScale(0, 'acres')).toBeNull();
    expect(pickAreaScale(-1, 'acres')).toBeNull();
    expect(pickAreaScale(Number.NaN, 'acres')).toBeNull();
  });
});

describe('formatAreaScaleLabel / unit cycle', () => {
  it('formats decade labels', () => {
    expect(formatAreaScaleLabel(1, 'acres')).toBe('1 ac');
    expect(formatAreaScaleLabel(10, 'hectares')).toBe('10 ha');
    expect(formatAreaScaleLabel(1000, 'square-meters')).toBe('1000 m²');
    expect(formatAreaScaleLabel(0.1, 'square-kilometers')).toBe('0.1 km²');
  });

  it('cycles acres → hectares → … → acres', () => {
    expect(nextAreaScaleUnit('acres')).toBe('hectares');
    expect(nextAreaScaleUnit('square-feet')).toBe('acres');
  });

  it('defaults from profile units', () => {
    expect(defaultAreaScaleUnit('metric')).toBe('hectares');
    expect(defaultAreaScaleUnit('imperial')).toBe('acres');
    expect(defaultAreaScaleUnit(null)).toBe('acres');
  });

  it('classifies imperial area units', () => {
    expect(areaUnitIsImperial('acres')).toBe(true);
    expect(areaUnitIsImperial('hectares')).toBe(false);
  });
});

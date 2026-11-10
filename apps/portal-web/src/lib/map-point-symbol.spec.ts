// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BACKGROUND_DIAMETER_PER_ICON_SIZE,
  ICON_IMAGE_SIZE_PX,
  ROUNDED_SQUARE_CORNER_FRACTION,
  alphaToSdfPixels,
  backgroundImageId,
  containRect,
  isRasterIconRef,
  pointBackgroundLayout,
  sizeSvgForRaster,
  svgIntrinsicSize,
} from './map-point-symbol';

describe('pointBackgroundLayout', () => {
  it.each([0.5, 1, 1.5, 3])('fits the icon box inside a circle at size %p', (size) => {
    const l = pointBackgroundLayout(size, 'circle', 1.5);
    expect(l.diameter).toBeCloseTo(BACKGROUND_DIAMETER_PER_ICON_SIZE * size);
    expect(l.circleRadius).toBeCloseTo(l.diameter / 2);
    // The rendered icon box is icon-size times the image size.
    expect(l.iconScale * ICON_IMAGE_SIZE_PX).toBeCloseTo(l.iconBox);
    // Even a full-bleed square image keeps its corners inside the
    // disc: half the box diagonal is under the radius.
    expect((l.iconBox * Math.SQRT2) / 2).toBeLessThan(l.circleRadius);
    // And there is visible padding on the flat sides.
    expect(l.circleRadius - l.iconBox / 2).toBeGreaterThan(l.diameter * 0.1);
  });

  it.each([0.5, 1, 2])('fits the icon box inside a rounded square at size %p', (size) => {
    const l = pointBackgroundLayout(size, 'rounded-square', 0);
    const half = l.diameter / 2;
    const corner = l.diameter * ROUNDED_SQUARE_CORNER_FRACTION;
    expect(l.cornerRadius).toBeCloseTo(corner);
    // The box corner must sit inside the rounded corner's arc.
    const arcCenter = half - corner;
    const boxCorner = l.iconBox / 2;
    const distance = Math.SQRT2 * Math.max(0, boxCorner - arcCenter);
    expect(boxCorner).toBeLessThan(half);
    expect(distance).toBeLessThan(corner);
  });

  it('scales the icon with the background, so padding stays proportional', () => {
    const a = pointBackgroundLayout(1, 'circle');
    const b = pointBackgroundLayout(2, 'circle');
    expect(b.iconScale / a.iconScale).toBeCloseTo(2);
    expect(b.diameter / a.diameter).toBeCloseTo(2);
  });

  it('puts the selection halo outside the outline', () => {
    const thin = pointBackgroundLayout(1, 'circle', 0);
    const thick = pointBackgroundLayout(1, 'circle', 4);
    expect(thin.haloRadius).toBeGreaterThan(thin.circleRadius);
    expect(thick.haloRadius - thin.haloRadius).toBeCloseTo(4);
  });

  it('falls back to size 1 for a bad icon size', () => {
    expect(pointBackgroundLayout(Number.NaN, 'circle').diameter).toBe(
      BACKGROUND_DIAMETER_PER_ICON_SIZE,
    );
    expect(pointBackgroundLayout(-2, 'circle').diameter).toBe(
      BACKGROUND_DIAMETER_PER_ICON_SIZE,
    );
  });
});

describe('containRect', () => {
  it('centers a wide source and keeps its aspect ratio', () => {
    expect(containRect(200, 100, 96, 96)).toEqual({ x: 0, y: 24, w: 96, h: 48 });
  });

  it('centers a tall source', () => {
    expect(containRect(10, 40, 96, 96)).toEqual({ x: 36, y: 0, w: 24, h: 96 });
  });

  it('scales a small square up to fill the box', () => {
    expect(containRect(16, 16, 96, 96)).toEqual({ x: 0, y: 0, w: 96, h: 96 });
  });

  it('fills the box when the source has no size', () => {
    expect(containRect(0, 0, 96, 96)).toEqual({ x: 0, y: 0, w: 96, h: 96 });
  });
});

describe('isRasterIconRef', () => {
  it('spots raster uploads by their .png key', () => {
    expect(isRasterIconRef('upload:map-icon/0f8fad5b-d9cb-469f-a165-70867728950e.png')).toBe(true);
  });

  it('treats bundled icons and older SVG uploads as vector', () => {
    expect(isRasterIconRef('map-pin')).toBe(false);
    expect(isRasterIconRef('upload:map-icon/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false);
    expect(isRasterIconRef('')).toBe(false);
    expect(isRasterIconRef(undefined)).toBe(false);
  });
});

describe('backgroundImageId', () => {
  it('changes with every input that changes the pixels', () => {
    const base = backgroundImageId(28, '#fff', '#111', 1.5);
    expect(backgroundImageId(42, '#fff', '#111', 1.5)).not.toBe(base);
    expect(backgroundImageId(28, '#000', '#111', 1.5)).not.toBe(base);
    expect(backgroundImageId(28, '#fff', '#222', 1.5)).not.toBe(base);
    expect(backgroundImageId(28, '#fff', '#111', 2)).not.toBe(base);
    expect(backgroundImageId(28, '#fff', '#111', 1.5)).toBe(base);
  });
});

describe('svgIntrinsicSize and sizeSvgForRaster', () => {
  it('reads the viewBox before width and height', () => {
    expect(
      svgIntrinsicSize('<svg viewBox="0 0 100 50" width="10" height="10"></svg>'),
    ).toEqual({ width: 100, height: 50 });
  });

  it('falls back to numeric width and height', () => {
    expect(svgIntrinsicSize('<svg width="30px" height="60"></svg>')).toEqual({
      width: 30,
      height: 60,
    });
    expect(svgIntrinsicSize('<svg width="100%" height="100%"></svg>')).toBeNull();
  });

  it('sizes a wide SVG to the target on its long side', () => {
    const out = sizeSvgForRaster(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="5cm"><path d="M0 0"/></svg>',
      96,
    );
    expect([out.width, out.height]).toEqual([96, 48]);
    expect(out.svg).toContain('width="96" height="48"');
    expect(out.svg).not.toContain('5cm');
    expect(out.svg).toContain('viewBox="0 0 200 100"');
    expect(out.svg).toContain('<path d="M0 0"/>');
  });

  it('adds a viewBox when only width and height were given', () => {
    const out = sizeSvgForRaster('<svg width="24" height="24"><circle r="1"/></svg>', 96);
    expect(out.svg).toContain('width="96" height="96" viewBox="0 0 24 24"');
  });
});

describe('alphaToSdfPixels', () => {
  /** A w x h raster with an opaque square from lo to hi (exclusive). */
  function square(w: number, lo: number, hi: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * w * 4);
    for (let y = lo; y < hi; y += 1) {
      for (let x = lo; x < hi; x += 1) d[(y * w + x) * 4 + 3] = 255;
    }
    return d;
  }
  const alphaAt = (out: Uint8ClampedArray, w: number, x: number, y: number) =>
    out[(y * w + x) * 4 + 3]!;

  it('puts the edge at 192 and moves about 32 levels per texel', () => {
    // MapLibre's SDF shader treats 192 as the edge and assumes
    // 255 / 8 levels per texel. The old encoder used about 5, which
    // smeared the edge over many pixels: the blur in #686.
    const w = 32;
    const out = alphaToSdfPixels(square(w, 8, 24), w, w);
    const row = 16;
    const inside = alphaAt(out, w, 8, row);
    const outside = alphaAt(out, w, 7, row);
    // Pixel centers half a texel either side of the edge.
    expect(inside).toBe(192 + 16);
    expect(outside).toBe(192 - 16);
    const step = alphaAt(out, w, 6, row) - alphaAt(out, w, 5, row);
    expect(step).toBe(32);
  });

  it('saturates deep inside and far outside', () => {
    const w = 32;
    const out = alphaToSdfPixels(square(w, 8, 24), w, w);
    expect(alphaAt(out, w, 16, 16)).toBe(255);
    expect(alphaAt(out, w, 0, 0)).toBe(0);
  });

  it('uses partial coverage to place the edge between texels', () => {
    const w = 16;
    const data = square(w, 4, 12);
    // A column at 25% coverage just outside the right edge.
    for (let y = 4; y < 12; y += 1) data[(y * w + 12) * 4 + 3] = 64;
    const out = alphaToSdfPixels(data, w, w);
    const soft = alphaAt(out, w, 12, 8);
    expect(soft).toBeGreaterThan(192 - 16);
    expect(soft).toBeLessThan(192);
  });

  it('writes white RGB so the tint is not darkened at the edges', () => {
    const w = 8;
    const out = alphaToSdfPixels(square(w, 2, 6), w, w);
    for (let i = 0; i < w * w; i += 1) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([255, 255, 255]);
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure geometry and encoding for map point symbols (#686).
 *
 * The map canvas registers every point icon with MapLibre as a square
 * image and draws an optional background shape under it. The numbers
 * that decide how big that image is, where it sits, and how it fits
 * inside the background live here, away from the DOM, so they can be
 * unit tested and shared by every surface that draws a map.
 */

/**
 * Logical size, in CSS pixels, of a registered icon image at
 * icon-size 1. Every icon (bundled, uploaded SVG, uploaded PNG or
 * JPEG) is drawn into a square box of this size so one icon-size
 * value means the same thing for all of them.
 */
export const ICON_IMAGE_SIZE_PX = 48;

/**
 * Texels per CSS pixel in a registered icon image. Passed to
 * MapLibre as `pixelRatio`, so the image keeps its logical size while
 * carrying enough detail for a 2x screen.
 */
export const ICON_IMAGE_PIXEL_RATIO = 2;

/** Side of the square icon raster, in texels. */
export const ICON_RASTER_PX = ICON_IMAGE_SIZE_PX * ICON_IMAGE_PIXEL_RATIO;

/**
 * Background diameter, in CSS pixels, per unit of icon size. A
 * marker at icon-size 1 is a 32 px disc or square.
 */
export const BACKGROUND_DIAMETER_PER_ICON_SIZE = 32;

/**
 * Share of the background's diameter that the icon box may use.
 * The circle value keeps the box corners inside the disc:
 * 0.66 x sqrt(2) = 0.93, so a full-bleed square image still clears
 * the edge. The rounded square leaves a similar visual margin.
 */
export const BACKGROUND_ICON_FRACTION = {
  circle: 0.66,
  'rounded-square': 0.7,
} as const;

/** Corner radius of the rounded square, as a share of its side. */
export const ROUNDED_SQUARE_CORNER_FRACTION = 0.22;

export type PointBackgroundShape = 'none' | 'circle' | 'rounded-square';

export interface PointBackgroundLayout {
  /** Diameter (circle) or side (square) of the fill, in CSS px. */
  diameter: number;
  /** MapLibre circle-radius for the circle background. */
  circleRadius: number;
  /** MapLibre icon-size for the icon so it fits inside the shape. */
  iconScale: number;
  /** Side of the box the icon image occupies, in CSS px. */
  iconBox: number;
  /** Radius of the selection halo drawn around the marker. */
  haloRadius: number;
  /** Corner radius of the rounded square, in CSS px. */
  cornerRadius: number;
}

/**
 * Size the background and the icon together so the icon sits in the
 * middle of the shape with even padding on every side. Both layers
 * are anchored on the point itself, so centering needs no offsets.
 */
export function pointBackgroundLayout(
  iconSize: number,
  shape: Exclude<PointBackgroundShape, 'none'>,
  strokeWidth = 0,
): PointBackgroundLayout {
  const size = Number.isFinite(iconSize) && iconSize > 0 ? iconSize : 1;
  const stroke = Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 0;
  const diameter = BACKGROUND_DIAMETER_PER_ICON_SIZE * size;
  const iconBox = diameter * BACKGROUND_ICON_FRACTION[shape];
  return {
    diameter,
    circleRadius: diameter / 2,
    iconScale: iconBox / ICON_IMAGE_SIZE_PX,
    iconBox,
    // MapLibre draws circle-stroke outside the radius, so the halo
    // clears the outline as well as the fill.
    haloRadius: diameter / 2 + stroke + 3,
    cornerRadius: diameter * ROUNDED_SQUARE_CORNER_FRACTION,
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Fit a source of any aspect ratio inside a box, centered, without
 * stretching. Used for uploaded SVGs with a non-square viewBox and
 * for PNG or JPEG icons.
 */
export function containRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
): Rect {
  if (!(srcW > 0) || !(srcH > 0)) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/**
 * Uploaded raster icons are stored under a key that ends in `.png`
 * (the server re-encodes PNG and JPEG uploads to PNG). SVG uploads
 * keep the bare UUID key they always had, so older saved maps read
 * as SVG with no migration.
 */
export function isRasterIconRef(name: string | null | undefined): boolean {
  return (
    typeof name === 'string' &&
    name.startsWith('upload:') &&
    /\.png$/i.test(name)
  );
}

/**
 * Stable image id for a baked rounded-square background. Every input
 * that changes the pixels is part of the id, so a style edit
 * registers a new image instead of reusing a stale one.
 */
export function backgroundImageId(
  diameter: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
): string {
  const d = Math.round(diameter * 100) / 100;
  const w = Math.round(strokeWidth * 100) / 100;
  return `gg:icon-bg:rounded-square:${d}:${w}:${fill}:${stroke}`;
}

/**
 * Read the intrinsic aspect ratio of an SVG document from its root
 * element: the viewBox first, then numeric width and height. Returns
 * null when neither is usable. Uploaded SVGs often have a wide or
 * tall viewBox and no width or height, and a browser then lays them
 * out in a 300 x 150 box, which stretched them when drawn square.
 */
const SVG_UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

export function svgIntrinsicSize(
  svg: string,
): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return null;
  const vb = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1];
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! };
    }
  }
  // Absolute CSS units, in px. With no viewBox the drawing's user units
  // are px, so a `24pt` wide root holds a 32 px wide drawing. Relative
  // units (%, em) have no size of their own here and give null.
  const num = (attr: string): number | null => {
    const m = new RegExp(
      `\\b${attr}\\s*=\\s*["']\\s*([0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)\\s*(px|pt|pc|mm|cm|in)?\\s*["']`,
      'i',
    ).exec(root);
    if (!m) return null;
    const n = Number(m[1]) * SVG_UNIT_PX[(m[2] ?? 'px').toLowerCase()]!;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const w = num('width');
  const h = num('height');
  return w && h ? { width: w, height: h } : null;
}

/**
 * Give an SVG's root element an explicit width and height that keep
 * its aspect ratio, with the long side at `px`. The browser then
 * reports a true natural size, and the rasterizer can fit it into
 * the icon box without distortion.
 *
 * When no size can be worked out (no viewBox and no absolute width and
 * height) the SVG is returned unchanged with width and height 0, and
 * the caller uses the loaded image's natural size. Guessing 1 x 1 here
 * used to add `viewBox="0 0 1 1"`, which drew only the top-left corner
 * of the icon.
 */
export function sizeSvgForRaster(svg: string, px: number): {
  svg: string;
  width: number;
  height: number;
} {
  const intrinsic = svgIntrinsicSize(svg);
  if (!intrinsic) return { svg, width: 0, height: 0 };
  const box = containRect(intrinsic.width, intrinsic.height, px, px);
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const out = svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    // Without a viewBox the content would not scale to the new size.
    const vb = /\bviewBox\s*=/i.test(cleaned)
      ? ''
      : ` viewBox="0 0 ${intrinsic.width} ${intrinsic.height}"`;
    return `<svg${cleaned} width="${width}" height="${height}"${vb}>`;
  });
  return { svg: out, width, height };
}

/**
 * Texels of distance that span the full inside or outside range of
 * the encoded value. MapLibre's SDF shader (SDF_PX = 8) expects one
 * texel to move the value by 255 / 8, about 32. That is 64 / 2, so
 * the boundary value 192 reaches 255 two texels inside the edge.
 *
 * The old encoder used size / 8 here (12 texels on a 96 px icon),
 * which made one texel worth about 5 levels instead of 32. MapLibre
 * then spread the anti-aliased edge over six times as many pixels,
 * which is the blur seen on tinted icons.
 */
export const SDF_CUTOFF_TEXELS = 2;

/**
 * Encode an RGBA raster's alpha as a signed distance field in the
 * layout MapLibre's SDF shader reads: value in the alpha channel,
 * 192 on the edge, about 32 levels per texel, RGB white.
 *
 * Distances come from a two-pass chamfer transform over a binary
 * mask. Pixels right on the edge use their own anti-aliased coverage
 * instead, which places the edge at sub-texel precision so curves
 * stay smooth after tinting.
 */
export function alphaToSdfPixels(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  cutoff = SDF_CUTOFF_TEXELS,
): Uint8ClampedArray<ArrayBuffer> {
  const n = w * h;
  const INF = w + h;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mask[i] = data[i * 4 + 3]! > 127 ? 1 : 0;

  // dOut: distance from an outside pixel to the nearest inside one.
  // dIn: distance from an inside pixel to the nearest outside one.
  const dOut = new Float32Array(n);
  const dIn = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    dOut[i] = mask[i] ? 0 : INF;
    dIn[i] = mask[i] ? INF : 0;
  }
  const relax = (arr: Float32Array, from: number, to: number, step: number) => {
    const c = arr[from]! + step;
    if (c < arr[to]!) arr[to] = c;
  };
  const D = Math.SQRT2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      for (const arr of [dOut, dIn]) {
        if (x > 0) relax(arr, i - 1, i, 1);
        if (y > 0) {
          relax(arr, i - w, i, 1);
          if (x > 0) relax(arr, i - w - 1, i, D);
          if (x < w - 1) relax(arr, i - w + 1, i, D);
        }
      }
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      for (const arr of [dOut, dIn]) {
        if (x < w - 1) relax(arr, i + 1, i, 1);
        if (y < h - 1) {
          relax(arr, i + w, i, 1);
          if (x > 0) relax(arr, i + w - 1, i, D);
          if (x < w - 1) relax(arr, i + w + 1, i, D);
        }
      }
    }
  }

  const out = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  const perTexel = 64 / cutoff;
  for (let i = 0; i < n; i += 1) {
    const a = data[i * 4 + 3]! / 255;
    const nearEdge = mask[i] ? dIn[i]! <= D : dOut[i]! <= D;
    // The edge sits half way between an inside and an outside pixel
    // center. On the edge itself, coverage says where exactly.
    const signed = nearEdge && a > 0 && a < 1
      ? a - 0.5
      : mask[i]
        ? dIn[i]! - 0.5
        : -(dOut[i]! - 0.5);
    out[i * 4] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(192 + signed * perTexel)));
  }
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Browser-side rasterizers for map point symbols (#73, #146, #686).
 *
 * Every icon becomes a square ICON_RASTER_PX image registered with
 * MapLibre at ICON_IMAGE_PIXEL_RATIO. The source is fitted inside that
 * square, centered and without stretching, whatever its own shape.
 * The sizing math lives in lib/map-point-symbol.ts.
 */

import {
  ICON_RASTER_PX,
  containRect,
  sizeSvgForRaster,
  type PointBackgroundLayout,
} from '@/lib/map-point-symbol';

function loadImage(blob: Blob): Promise<{ img: HTMLImageElement; done: () => void }> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ img, done: () => URL.revokeObjectURL(url) });
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function drawContained(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): ImageData {
  const px = ICON_RASTER_PX;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const r = containRect(srcW, srcH, px, px);
  ctx.drawImage(source, r.x, r.y, r.w, r.h);
  return ctx.getImageData(0, 0, px, px);
}

/**
 * Rasterize an SVG icon. The root element gets an explicit size that
 * keeps its aspect ratio, so the browser draws the vector straight at
 * the target resolution instead of scaling a smaller bitmap.
 */
export async function rasterizeSvgIcon(svg: string): Promise<ImageData> {
  const sized = sizeSvgForRaster(svg, ICON_RASTER_PX);
  const { img, done } = await loadImage(
    new Blob([sized.svg], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    // No size from the markup: use what the browser loaded, and the
    // icon box if even that is unknown.
    return drawContained(
      img,
      sized.width || img.naturalWidth || ICON_RASTER_PX,
      sized.height || img.naturalHeight || ICON_RASTER_PX,
    );
  } finally {
    done();
  }
}

/**
 * Rasterize an uploaded PNG icon (JPEG uploads are re-encoded to PNG
 * by the server). Large images are scaled down with high quality
 * smoothing; small ones are scaled up to fill the box.
 */
export async function rasterizeBitmapIcon(blob: Blob): Promise<ImageData> {
  const { img, done } = await loadImage(blob);
  try {
    return drawContained(img, img.naturalWidth, img.naturalHeight);
  } finally {
    done();
  }
}

/**
 * Bake a rounded-square background as an image. MapLibre has no
 * rounded rectangle primitive, so the shape is drawn on a canvas at
 * its final on-screen size and registered with the given pixel ratio.
 * The outline sits outside the fill, the same way MapLibre draws a
 * circle's stroke, so both shapes read the same size.
 */
export function drawRoundedSquareBackground(
  layout: PointBackgroundLayout,
  fill: string,
  stroke: string,
  strokeWidth: number,
  pixelRatio: number,
): ImageData {
  const sw = strokeWidth > 0 ? strokeWidth : 0;
  const outer = layout.diameter + sw * 2;
  // One CSS pixel of transparent margin keeps the outline from
  // touching the image edge, where texture sampling would clip it.
  const sideCss = Math.ceil(outer) + 2;
  const side = Math.max(1, Math.round(sideCss * pixelRatio));
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2D unavailable');
  ctx.scale(pixelRatio, pixelRatio);
  const c = sideCss / 2;
  const roundRect = (size: number, radius: number) => {
    ctx.beginPath();
    ctx.roundRect(c - size / 2, c - size / 2, size, size, radius);
  };
  if (sw > 0) {
    roundRect(outer, layout.cornerRadius + sw);
    ctx.fillStyle = stroke;
    ctx.fill();
    // Cut the middle out of the outline so a see-through fill does
    // not show the outline color behind it.
    ctx.globalCompositeOperation = 'destination-out';
    roundRect(layout.diameter, layout.cornerRadius);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  roundRect(layout.diameter, layout.cornerRadius);
  ctx.fillStyle = fill;
  ctx.fill();
  return ctx.getImageData(0, 0, side, side);
}

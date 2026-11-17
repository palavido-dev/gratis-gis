// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime signed-distance-field images for tintable point icons.
 *
 * MapLibre's symbol layer supports `icon-color` tinting only when the
 * registered image is flagged as SDF via `addImage(id, img, {sdf: true})`.
 * The shader samples the image's alpha channel and treats 192/255 as
 * the edge of the shape, with about 32 levels per texel of distance.
 *
 * The encoding itself is pure and lives in lib/map-point-symbol.ts so
 * it can be unit tested. See SDF_CUTOFF_TEXELS there for why the old
 * encoding made tinted icons blurry (#686).
 */

import { alphaToSdfPixels } from '@/lib/map-point-symbol';
import { rasterizeSvgIcon } from './icon-raster';

/** Turn a rasterized icon into its SDF twin. */
export function alphaToSdf(imageData: ImageData): ImageData {
  const { data, width, height } = imageData;
  return new ImageData(alphaToSdfPixels(data, width, height), width, height);
}

/**
 * Rasterize an SVG in solid black at the standard icon size and
 * encode its coverage as an SDF. Used for both bundled and uploaded
 * vector icons, so a tinted copy lines up exactly with the plain one.
 */
export async function svgToSdf(svg: string): Promise<ImageData> {
  return alphaToSdf(await rasterizeSvgIcon(svg));
}

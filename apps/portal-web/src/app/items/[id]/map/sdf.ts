/**
 * Runtime signed-distance-field generator for point icons.
 *
 * MapLibre's symbol layer supports `icon-color` tinting only when the
 * registered image is flagged as SDF via `addImage(id, img, {sdf: true})`.
 * For an SDF image MapLibre expects the pixel value to encode the
 * signed distance to the shape boundary, with the alpha channel
 * carrying coverage.
 *
 * We derive the distance field at load time from a rasterized SVG's
 * alpha mask via a two-pass sequential chamfer transform:
 *
 *   - Forward pass accumulates distances from top-left.
 *   - Backward pass refines from bottom-right.
 *   - 3-4 Chamfer kernel (axis step = 3, diagonal step = 4) is a
 *     standard cheap approximation of Euclidean distance, good enough
 *     that a 48 px rendered icon doesn't betray the approximation.
 *
 * The encoded image uses MapLibre's SDF convention: the *alpha*
 * channel carries the remap of the signed distance, with values
 * around 192/256 falling on the shape boundary. That matches the
 * contract MapLibre's symbol_sdf shader expects: it samples
 * `texture2D(u_texture, v_tex).a` and thresholds near (256-64)/256
 * = 0.75 to decide inside/outside. RGB is set to white so when
 * MapLibre lerps through the image sampler it doesn't drag color
 * toward black at the edges.
 *
 * Previous iterations wrote the remap to the red channel and left
 * alpha at 255 everywhere: which made MapLibre treat every pixel
 * as fully inside the shape, rendering a solid square of the
 * icon-color. Lesson learned: alpha is the payload.
 */

export interface SdfOptions {
  /** How many pixels past the edge still register as "inside the buffer". */
  buffer?: number;
  /** Max distance to encode; farther pixels clamp to the extremes. */
  cutoff?: number;
}

export function alphaToSdf(
  imageData: ImageData,
  opts: SdfOptions = {},
): ImageData {
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const INF = w + h;
  const buffer = opts.buffer ?? 0;
  // Matches tiny-sdf's default (1/8 of the texture size). A tighter
  // cutoff makes the edge smoothstep span fewer pixels, giving a
  // sharper icon: min(w,h)/4 was too generous and showed up as a
  // visible halo/haze around tinted icons.
  const cutoff = opts.cutoff ?? Math.min(w, h) / 8;

  // Binary mask from alpha. Anything above 127 is "inside the shape".
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    mask[i] = data[i * 4 + 3]! > 127 ? 1 : 0;
  }

  // Two separate distance maps: outside-to-inside, and inside-to-outside.
  const dOut = new Float32Array(n);
  const dIn = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    dOut[i] = mask[i] ? 0 : INF;
    dIn[i] = mask[i] ? INF : 0;
  }

  const updatePair = (
    from: Float32Array,
    fromIdx: number,
    toIdx: number,
    step: number,
  ) => {
    const cand = from[fromIdx]! + step;
    if (cand < from[toIdx]!) from[toIdx] = cand;
  };

  // Forward pass: look up/left.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x > 0) {
        updatePair(dOut, i - 1, i, 1);
        updatePair(dIn, i - 1, i, 1);
      }
      if (y > 0) {
        updatePair(dOut, i - w, i, 1);
        updatePair(dIn, i - w, i, 1);
        if (x > 0) {
          updatePair(dOut, i - w - 1, i, Math.SQRT2);
          updatePair(dIn, i - w - 1, i, Math.SQRT2);
        }
        if (x < w - 1) {
          updatePair(dOut, i - w + 1, i, Math.SQRT2);
          updatePair(dIn, i - w + 1, i, Math.SQRT2);
        }
      }
    }
  }

  // Backward pass: look down/right.
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (x < w - 1) {
        updatePair(dOut, i + 1, i, 1);
        updatePair(dIn, i + 1, i, 1);
      }
      if (y < h - 1) {
        updatePair(dOut, i + w, i, 1);
        updatePair(dIn, i + w, i, 1);
        if (x > 0) {
          updatePair(dOut, i + w - 1, i, Math.SQRT2);
          updatePair(dIn, i + w - 1, i, Math.SQRT2);
        }
        if (x < w - 1) {
          updatePair(dOut, i + w + 1, i, Math.SQRT2);
          updatePair(dIn, i + w + 1, i, Math.SQRT2);
        }
      }
    }
  }

  // Encode in MapLibre's expected format. We match tiny-sdf's
  // convention: the value is 192 at the boundary and scales out in
  // both directions by the cutoff, written into the *alpha* channel
  // (that's what MapLibre's SDF shader samples). RGB is kept at
  // white so edge blending in the texture sampler doesn't drag the
  // tint toward black.
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    const signed = mask[i] ? dIn[i]! : -dOut[i]!;
    // Positive = inside the shape, negative = outside.
    // At the boundary (signed=0) we want ~192/256; 1 px inside moves
    // the value up, 1 px outside moves it down, with `buffer` pixels
    // of padding near the edge before we start crossing the threshold.
    const v = 192 + ((signed - buffer) * 64) / cutoff;
    const clamped = Math.max(0, Math.min(255, Math.round(v)));
    out[i * 4 + 0] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = clamped;
  }
  return new ImageData(out, w, h);
}

/**
 * Rasterize an SVG onto a canvas filled in black, then feed the
 * alpha mask into the SDF encoder. Used for both built-in and
 * uploaded vector icons: rasterized copies of the same SVG look
 * identical regardless of source.
 */
export async function svgToSdf(svg: string, size: number): Promise<ImageData> {
  const scale = 2;
  const w = size * scale;
  const h = size * scale;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    return alphaToSdf(pixels);
  } finally {
    URL.revokeObjectURL(url);
  }
}

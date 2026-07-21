// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Magic outline (SAM) browser half. Click a spot on imagery and get
 * a clean polygon of the thing under the cursor:
 *
 *   1. ensure/fetch the 1024px window's image embedding (computed
 *      by the analysis worker, cached forever in MinIO),
 *   2. run the MobileSAM mask decoder in the browser via
 *      onnxruntime-web (~10ms after warmup, so repeat clicks in the
 *      same window feel instant),
 *   3. trace the mask's clicked component into a polygon, simplify,
 *      and hand back WGS84 coordinates.
 *
 * Window addressing matches the server: "supertiles" of 1024px on
 * the web-mercator grid, i.e. tile coords at (z - 2). The ort wasm
 * runtime and the decoder model are both self-hosted under
 * /models/ (no CDN; prod runs air-gapped).
 */

const WEBMERC_HALF = 20037508.342789244;
const WINDOW = 1024;
const EMBED_SHAPE = [1, 256, 64, 64] as const;

export interface SupertileKey {
  z: number;
  gx: number;
  gy: number;
}

export interface OutlineResult {
  /** WGS84 polygon ring, closed (first == last). */
  ring: Array<[number, number]>;
  /** Model confidence 0..1 for the returned mask. */
  score: number;
}

function toMerc(lng: number, lat: number): [number, number] {
  const x = (lng * Math.PI * 6378137) / 180;
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function fromMerc(x: number, y: number): [number, number] {
  const lng = (x / 6378137) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}

/** Supertile containing a lng/lat at zoom z, plus the in-window px. */
export function supertileFor(
  lng: number,
  lat: number,
  z: number,
): { key: SupertileKey; px: number; py: number } {
  const [mx, my] = toMerc(lng, lat);
  const n = 2 ** (z - 2);
  const size = (2 * WEBMERC_HALF) / n;
  const fx = (mx + WEBMERC_HALF) / size;
  const fy = (WEBMERC_HALF - my) / size;
  const gx = Math.min(n - 1, Math.max(0, Math.floor(fx)));
  const gy = Math.min(n - 1, Math.max(0, Math.floor(fy)));
  return {
    key: { z, gx, gy },
    px: (fx - gx) * WINDOW,
    py: (fy - gy) * WINDOW,
  };
}

function supertileBounds(key: SupertileKey) {
  const n = 2 ** (key.z - 2);
  const size = (2 * WEBMERC_HALF) / n;
  const x0 = -WEBMERC_HALF + key.gx * size;
  const y1 = WEBMERC_HALF - key.gy * size;
  return { x0, y0: y1 - size, x1: x0 + size, y1, size };
}

// ---- Embedding ensure/fetch --------------------------------------

const embedCache = new Map<string, Float32Array>();

function cacheKey(itemId: string, k: SupertileKey): string {
  return `${itemId}/${k.z}/${k.gx}/${k.gy}`;
}

/**
 * Make sure the window's embedding exists (queueing the worker job
 * on first visit) and download it. Polls every 1.5s while the
 * worker computes; a fresh window takes a few seconds of CPU.
 */
export async function ensureEmbedding(
  itemId: string,
  key: SupertileKey,
  onProgress?: (msg: string) => void,
): Promise<Float32Array> {
  const ck = cacheKey(itemId, key);
  const cached = embedCache.get(ck);
  if (cached) return cached;

  const ensureRes = await fetch(`/api/portal/items/${itemId}/sam/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(key),
  });
  if (!ensureRes.ok) {
    const body = (await ensureRes.json().catch(() => null)) as {
      message?: string | string[];
    } | null;
    const msg = Array.isArray(body?.message)
      ? body.message.join(' ')
      : body?.message;
    throw new Error(msg || 'The outline tool could not start.');
  }
  let { state } = (await ensureRes.json()) as { state: string };
  const stateUrl = `/api/portal/items/${itemId}/sam/embedding/${key.z}/${key.gx}/${key.gy}/state`;
  const started = Date.now();
  while (state !== 'ready') {
    if (Date.now() - started > 120_000) {
      throw new Error('Preparing this area took too long. Try again.');
    }
    onProgress?.('Reading this area (first click here takes a moment)...');
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(stateUrl);
    if (!res.ok) throw new Error('The outline tool lost the connection.');
    const s = (await res.json()) as { state: string; error?: string | null };
    if (s.state === 'failed') {
      throw new Error(s.error || 'Preparing this area failed.');
    }
    state = s.state === 'ready' ? 'ready' : 'working';
  }

  const binRes = await fetch(
    `/api/portal/items/${itemId}/sam/embedding/${key.z}/${key.gx}/${key.gy}`,
  );
  if (!binRes.ok) throw new Error('The embedding could not be loaded.');
  const buf = await binRes.arrayBuffer();
  const expected =
    EMBED_SHAPE.reduce<number>((a, b) => a * b, 1) * 4;
  if (buf.byteLength !== expected) {
    throw new Error('The embedding for this view looks corrupted.');
  }
  const arr = new Float32Array(buf);
  // Keep a handful of windows warm; each is 4 MiB.
  if (embedCache.size > 6) {
    const first = embedCache.keys().next().value;
    if (first) embedCache.delete(first);
  }
  embedCache.set(ck, arr);
  return arr;
}

// ---- Decoder -----------------------------------------------------

type OrtModule = typeof import('onnxruntime-web');
let ortPromise: Promise<OrtModule> | null = null;
let sessionPromise: Promise<import('onnxruntime-web').InferenceSession> | null =
  null;

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // Self-hosted wasm binaries (copied out of the package at
      // image build); never reach for a CDN.
      ort.env.wasm.wasmPaths = '/models/ort/';
      return ort;
    });
  }
  return ortPromise;
}

async function loadSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrt();
      const head = await fetch('/models/mobilesam-decoder.onnx', {
        method: 'HEAD',
      });
      if (!head.ok) {
        throw new Error(
          'The outline tool is not installed on this portal (missing decoder model).',
        );
      }
      return ort.InferenceSession.create('/models/mobilesam-decoder.onnx', {
        executionProviders: ['wasm'],
      });
    })();
    sessionPromise.catch(() => {
      // Allow a retry after transient failures.
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

/** Run the decoder for one click. Returns the mask + score. */
async function decodeMask(
  embedding: Float32Array,
  px: number,
  py: number,
): Promise<{ mask: Float32Array; w: number; h: number; score: number }> {
  const ort = await loadOrt();
  const session = await loadSession();
  const feeds: Record<string, import('onnxruntime-web').Tensor> = {
    image_embeddings: new ort.Tensor('float32', embedding, [...EMBED_SHAPE]),
    // One foreground click plus the required padding point.
    point_coords: new ort.Tensor(
      'float32',
      new Float32Array([px, py, 0, 0]),
      [1, 2, 2],
    ),
    point_labels: new ort.Tensor('float32', new Float32Array([1, -1]), [1, 2]),
    mask_input: new ort.Tensor(
      'float32',
      new Float32Array(256 * 256),
      [1, 1, 256, 256],
    ),
    has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
    orig_im_size: new ort.Tensor(
      'float32',
      new Float32Array([WINDOW, WINDOW]),
      [2],
    ),
  };
  const out = await session.run(feeds);
  const masks = out['masks'] ?? out[session.outputNames[0]!]!;
  const scores = out['iou_predictions'] ?? out[session.outputNames[1]!]!;
  const dims = masks.dims;
  return {
    mask: masks.data as Float32Array,
    w: dims[dims.length - 1]!,
    h: dims[dims.length - 2]!,
    score: (scores.data as Float32Array)[0] ?? 0,
  };
}

// ---- Mask -> polygon ---------------------------------------------

/**
 * Trace the boundary of the mask component containing the click
 * with marching squares, walking the contour between inside and
 * outside cells. Vertices land on pixel edges; the follow-up
 * simplification removes the stair-stepping.
 */
function traceComponent(
  mask: Uint8Array,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
): Array<[number, number]> | null {
  const idx = (x: number, y: number) => y * w + x;
  if (!mask[idx(seedX, seedY)]) return null;

  // Flood fill the clicked component so islands elsewhere in the
  // window don't leak into the outline.
  const comp = new Uint8Array(w * h);
  const stack = [idx(seedX, seedY)];
  comp[stack[0]!] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0 && mask[i - 1] && !comp[i - 1]) {
      comp[i - 1] = 1;
      stack.push(i - 1);
    }
    if (x < w - 1 && mask[i + 1] && !comp[i + 1]) {
      comp[i + 1] = 1;
      stack.push(i + 1);
    }
    if (y > 0 && mask[i - w] && !comp[i - w]) {
      comp[i - w] = 1;
      stack.push(i - w);
    }
    if (y < h - 1 && mask[i + w] && !comp[i + w]) {
      comp[i + w] = 1;
      stack.push(i + w);
    }
  }

  // Find the topmost-leftmost boundary pixel of the component, then
  // Moore-neighbor trace clockwise around it.
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (comp[idx(x, y)]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;

  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ] as const;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && comp[idx(x, y)] === 1;

  const ring: Array<[number, number]> = [];
  let cx = sx;
  let cy = sy;
  let dir = 6; // came from below-ish; start scanning upward
  const maxSteps = w * h;
  for (let step = 0; step < maxSteps; step += 1) {
    ring.push([cx, cy]);
    let found = false;
    // Scan neighbors clockwise starting just after the direction we
    // arrived from (standard Moore tracing).
    for (let k = 0; k < 8; k += 1) {
      const d = (dir + 6 + k) % 8;
      const nx = cx + dirs[d]![0];
      const ny = cy + dirs[d]![1];
      if (inside(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break; // single-pixel component
    if (cx === sx && cy === sy && ring.length > 2) break;
  }
  return ring.length >= 3 ? ring : null;
}

/** Douglas-Peucker in pixel space. */
function simplify(
  pts: Array<[number, number]>,
  epsilon: number,
): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!;
    const [bx, by] = pts[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstD = epsilon;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = pts[i]!;
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Full click-to-polygon pipeline against one imagery item. zoom is
 * the map's current zoom; the analysis window matches what the
 * user is looking at.
 */
export async function outlineAt(
  itemId: string,
  lng: number,
  lat: number,
  zoom: number,
  onProgress?: (msg: string) => void,
): Promise<OutlineResult> {
  const z = Math.min(22, Math.max(14, Math.round(zoom)));
  const { key, px, py } = supertileFor(lng, lat, z);
  const embedding = await ensureEmbedding(itemId, key, onProgress);
  onProgress?.('Outlining...');
  const { mask, w, h, score } = await decodeMask(embedding, px, py);

  const binary = new Uint8Array(w * h);
  for (let i = 0; i < binary.length; i += 1) {
    binary[i] = mask[i]! > 0 ? 1 : 0;
  }
  const sx = Math.min(w - 1, Math.max(0, Math.round((px / WINDOW) * w)));
  const sy = Math.min(h - 1, Math.max(0, Math.round((py / WINDOW) * h)));
  const traced = traceComponent(binary, w, h, sx, sy);
  if (!traced) {
    throw new Error(
      "Nothing distinct under that click. Try clicking the middle of what you're outlining.",
    );
  }
  // ~1.5px tolerance at mask scale keeps corners while dropping the
  // pixel stair-steps.
  const simplified = simplify(traced, 1.5);
  if (simplified.length < 3) {
    throw new Error('The outline came out too small to keep.');
  }

  const { x0, y1, size } = supertileBounds(key);
  const ring = simplified.map(([mx, my]) => {
    const wx = x0 + ((mx + 0.5) / w) * size;
    const wy = y1 - ((my + 0.5) / h) * size;
    return fromMerc(wx, wy);
  });
  ring.push(ring[0]!);
  return { ring, score };
}

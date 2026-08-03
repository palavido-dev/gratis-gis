// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared "which elevation layer covers this spot" lookup, used by
 * the elevation profile tool in the map builder and the web-app
 * runtime widget. Resolution order:
 *
 *   1. The map's own terrain layer, when set. It is literally the
 *      ground the user is looking at, so the profile must read the
 *      same surface.
 *   2. Any elevation-flagged tile layer in the org whose extent
 *      covers the queried bbox. This keeps the tool useful on flat
 *      2D maps that never turned 3D on.
 *
 * The `cog://` prefix on stored tile urls is the map renderer's
 * protocol marker; readers want the plain http url underneath.
 */

export interface DemRef {
  /** Portal item id of the elevation layer. */
  itemId: string;
  url: string;
  title?: string;
}

/**
 * #211: with a multi-entry terrain stack, the entry that owns the
 * ground under the queried bbox is the first one (priority order)
 * whose stamped footprint touches it, mirroring the mosaic's
 * first-wins rule. An entry whose bbox we can't learn counts as
 * covering (same "terrain is the ground you're looking at"
 * assumption the single-source path always made).
 */
async function resolveFromStack(
  stack: Array<{ itemId: string; tileUrl: string }>,
  bbox: [number, number, number, number],
): Promise<DemRef | null> {
  const [w, s, e, n] = bbox;
  for (const entry of stack) {
    let title: string | undefined;
    let itemBbox: [number, number, number, number] | undefined;
    try {
      const res = await fetch(`/api/portal/items/${entry.itemId}`);
      if (res.ok) {
        const item = (await res.json()) as {
          title?: string;
          data?: { bbox?: [number, number, number, number] } | null;
        };
        title = item.title;
        if (Array.isArray(item.data?.bbox) && item.data.bbox.length === 4) {
          itemBbox = item.data.bbox;
        }
      }
    } catch {
      /* metadata is best-effort; the entry still counts as covering */
    }
    if (itemBbox) {
      const [bw, bs, be, bn] = itemBbox;
      if (!(bw <= e && be >= w && bs <= n && bn >= s)) continue;
    }
    return {
      itemId: entry.itemId,
      url: entry.tileUrl.replace(/^cog:\/\//, ''),
      ...(title ? { title } : {}),
    };
  }
  return null;
}

export async function resolveDemForBbox(
  rawTerrain:
    | {
        itemId: string;
        tileUrl: string;
        stack?: Array<{ itemId: string; tileUrl: string }>;
        enabled?: boolean;
      }
    | undefined
    | null,
  bbox: [number, number, number, number],
): Promise<DemRef | null> {
  // Terrain toggled off is not "the ground you're looking at"
  // (#211 follow-up): fall through to the org-wide lookup, same as
  // a map that never turned 3D on. Centralized here so every
  // profile surface agrees.
  const terrain = rawTerrain && rawTerrain.enabled !== false ? rawTerrain : null;
  if (terrain?.stack && terrain.stack.length > 1) {
    const fromStack = await resolveFromStack(terrain.stack, bbox);
    if (fromStack) return fromStack;
    // No stack entry touches the bbox; fall through to the org-wide
    // lookup below so a profile outside the stack's coverage can
    // still find ground.
  } else if (terrain?.tileUrl) {
    let title: string | undefined;
    try {
      const res = await fetch(`/api/portal/items/${terrain.itemId}`);
      if (res.ok) {
        title = ((await res.json()) as { title?: string }).title;
      }
    } catch {
      /* title is cosmetic */
    }
    return {
      itemId: terrain.itemId,
      url: terrain.tileUrl.replace(/^cog:\/\//, ''),
      ...(title ? { title } : {}),
    };
  }
  const [w, s, e, n] = bbox;
  try {
    const res = await fetch('/api/portal/items?type=tile_layer&full=1');
    if (!res.ok) return null;
    const items = (await res.json()) as Array<{
      id: string;
      title: string;
      data?: {
        dem?: boolean;
        tileUrl?: string;
        bbox?: [number, number, number, number];
      } | null;
    }>;
    const match = items.find((i) => {
      if (!i.data?.dem || !i.data.tileUrl || !i.data.bbox) return false;
      const [bw, bs, be, bn] = i.data.bbox;
      return bw < e && be > w && bs < n && bn > s;
    });
    if (!match) return null;
    return {
      itemId: match.id,
      url: match.data!.tileUrl!.replace(/^cog:\/\//, ''),
      title: match.title,
    };
  } catch {
    return null;
  }
}

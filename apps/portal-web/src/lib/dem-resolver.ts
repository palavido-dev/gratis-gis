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
  url: string;
  title?: string;
}

export async function resolveDemForBbox(
  terrain: { itemId: string; tileUrl: string } | undefined | null,
  bbox: [number, number, number, number],
): Promise<DemRef | null> {
  if (terrain?.tileUrl) {
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
      url: terrain.tileUrl.replace(/^cog:\/\//, ''),
      ...(title ? { title } : {}),
    };
  }
  const [w, s, e, n] = bbox;
  try {
    const res = await fetch('/api/portal/items?type=tile_layer');
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
      url: match.data!.tileUrl!.replace(/^cog:\/\//, ''),
      title: match.title,
    };
  } catch {
    return null;
  }
}

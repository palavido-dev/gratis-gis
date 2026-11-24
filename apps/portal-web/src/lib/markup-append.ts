// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  defaultDrawingSetTitle,
  type DrawingFeature,
  type DrawingSet,
} from '@gratis-gis/shared-types';

import { portalJson } from '@/lib/portal-json';

/** What a map tool needs to add a shape to the map's markup. */
export interface MarkupSaveContext {
  mapId: string;
  currentUser: { id: string; displayName: string };
  /** Map editors may add to any markup set; others only to their own. */
  canEditMap: boolean;
  drawings: DrawingSet[];
  onDrawingsChange: (next: DrawingSet[]) => void;
}

/**
 * Add one shape to markup: the user's most recent visible set they may
 * write to (their own first), or a new set when there is none. Returns
 * the set it went into, and hands the new list to onDrawingsChange.
 */
export async function appendToMarkup(
  ctx: MarkupSaveContext,
  feature: DrawingFeature,
): Promise<DrawingSet> {
  const base = `/api/portal/items/${ctx.mapId}/drawings`;
  const mine = ctx.drawings
    .filter((s) => s.visible && (ctx.canEditMap || s.authorId === ctx.currentUser.id))
    .sort((a, b) => {
      const own =
        Number(b.authorId === ctx.currentUser.id) - Number(a.authorId === ctx.currentUser.id);
      return own !== 0 ? own : b.updatedAt.localeCompare(a.updatedAt);
    });
  let target = mine[0] ?? null;
  let sets = ctx.drawings;
  if (!target) {
    target = await portalJson<DrawingSet>(base, {
      method: 'POST',
      body: JSON.stringify({ title: defaultDrawingSetTitle(ctx.currentUser.displayName) }),
    });
    sets = [...sets, target];
  }
  const updated = await portalJson<DrawingSet>(`${base}/${target.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ appendFeatures: [feature] }),
  });
  const targetId = target.id;
  ctx.onDrawingsChange(sets.map((s) => (s.id === targetId ? updated : s)));
  return updated;
}

/** Vertices in a geometry, for the server's per-shape cap. */
export function vertexCount(g: GeoJSON.Geometry): number {
  if (g.type === 'GeometryCollection') return g.geometries.reduce((n, x) => n + vertexCount(x), 0);
  const walk = (c: unknown): number =>
    Array.isArray(c) ? (typeof c[0] === 'number' ? 1 : c.reduce((n: number, x) => n + walk(x), 0)) : 0;
  return walk(g.coordinates);
}

/** The server keeps at most this many vertices in one markup shape. */
export const MAX_MARKUP_VERTICES = 10_000;

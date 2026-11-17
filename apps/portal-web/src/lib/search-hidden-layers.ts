// SPDX-License-Identifier: AGPL-3.0-or-later
// Map search covers hidden layers as well as visible ones, so a user
// can find a parcel without first hunting for the layer that holds
// it. Results from a hidden layer are labelled as hidden, and picking
// one turns that layer on, so the map shows what the user picked.

export interface SearchVisibilityLayer {
  id: string;
  visible: boolean;
  groupId?: string | null;
}

/**
 * Ids of layers that do not draw right now. Hiding a group hides
 * every descendant (lib/layer-group-toggle), so the layer's own flag
 * is the whole answer; a hidden parent group is checked too in case
 * a child was saved visible under a hidden group.
 */
export function hiddenLayerIds(
  layers: readonly SearchVisibilityLayer[],
): Set<string> {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const out = new Set<string>();
  for (const l of layers) {
    if (ancestry(l, byId).some((x) => x.visible === false)) out.add(l.id);
  }
  return out;
}

/**
 * Turns `layerId` on along with every group above it. Other layers,
 * siblings included, keep their state. Returns the same array when
 * nothing had to change.
 */
export function showLayerAndParents<T extends SearchVisibilityLayer>(
  layers: T[],
  layerId: string,
): T[] {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const target = byId.get(layerId);
  if (!target) return layers;
  const ids = new Set(ancestry(target, byId).map((l) => l.id));
  let changed = false;
  const next = layers.map((l) => {
    if (!ids.has(l.id) || l.visible !== false) return l;
    changed = true;
    return { ...l, visible: true };
  });
  return changed ? next : layers;
}

/** The layer itself, then its parent group, then that group's parent. */
function ancestry<T extends SearchVisibilityLayer>(
  layer: T,
  byId: Map<string, T>,
): T[] {
  const out: T[] = [layer];
  const seen = new Set([layer.id]);
  let cur = layer.groupId ? byId.get(layer.groupId) : undefined;
  // `seen` stops a malformed saved map whose groups point at each
  // other from looping forever.
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.groupId ? byId.get(cur.groupId) : undefined;
  }
  return out;
}

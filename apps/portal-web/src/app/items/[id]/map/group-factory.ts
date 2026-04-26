import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
} from '@gratis-gis/shared-types';
import type { MapLayer } from '@gratis-gis/shared-types';

/**
 * Build an empty group-layer row (#70, #72). All the editor's
 * defaults flow through here so add-from-button, drag-into-new-group,
 * and the "move to new group" kebab action stay in lockstep on
 * future schema additions.
 */
export function makeEmptyGroupLayer(title: string): MapLayer {
  return {
    id: crypto.randomUUID(),
    title,
    visible: true,
    opacity: 1,
    source: { kind: 'group' },
    style: structuredClone(DEFAULT_LAYER_STYLE),
    renderer: structuredClone(DEFAULT_LAYER_RENDERER),
    popup: structuredClone(DEFAULT_LAYER_POPUP),
    interactions: structuredClone(DEFAULT_LAYER_INTERACTIONS),
    labels: structuredClone(DEFAULT_LAYER_LABELS),
    search: structuredClone(DEFAULT_LAYER_SEARCH),
    scale: structuredClone(DEFAULT_LAYER_SCALE),
    access: structuredClone(DEFAULT_LAYER_ACCESS),
    filter: null,
  };
}

/**
 * Pick a non-conflicting title for a new group. Walks existing
 * group titles in the layer list and appends " 2", " 3", etc. so
 * back-to-back creates produce "New group", "New group 2", "New
 * group 3" instead of asking the author to rename each one.
 */
export function uniqueGroupTitle(layers: MapLayer[], base: string): string {
  const existing = new Set(
    layers
      .filter((l) => l.source.kind === 'group')
      .map((l) => l.title.trim()),
  );
  let title = base;
  let n = 2;
  while (existing.has(title)) {
    title = `${base} ${n}`;
    n += 1;
  }
  return title;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Comment thread anchoring (#155).
 *
 * Threads live on an item and optionally pin to a sub-entity via
 * `parentKind` + `parentId`. Phase 1 only wrote map-level threads
 * (`parentKind = 'map'`, `parentId = itemId`). Phase 2 opens
 * feature and drawing anchors; the composite encodings below keep
 * feature ids unique across layers without a schema change.
 */

export type CommentParentKind = 'map' | 'layer' | 'feature' | 'drawing';

/**
 * Encode a data-layer (or map-layer) feature anchor.
 * Format: `<mapLayerId>:<featureId>` so two layers that both carry
 * OBJECTID 1 do not collide. Feature ids may be UUID strings or
 * numeric indexes depending on the source.
 */
export function encodeFeatureCommentParent(
  mapLayerId: string,
  featureId: string | number,
): string {
  return `${mapLayerId}:${String(featureId)}`;
}

export function decodeFeatureCommentParent(
  parentId: string,
): { mapLayerId: string; featureId: string } | null {
  const idx = parentId.indexOf(':');
  if (idx <= 0 || idx === parentId.length - 1) return null;
  return {
    mapLayerId: parentId.slice(0, idx),
    featureId: parentId.slice(idx + 1),
  };
}

/** Drawing features already carry a stable UUID; parentId is that id. */
export function encodeDrawingCommentParent(drawingFeatureId: string): string {
  return drawingFeatureId;
}

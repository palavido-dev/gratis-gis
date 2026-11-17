// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ArcgisServiceData } from '@gratis-gis/shared-types';

/**
 * Layer selection after a probe: keep the previous choice for layers
 * that were already known and select the layers the probe newly
 * found. With no previous choice, or when nothing would be left,
 * everything is selected.
 */
export function probeSelection(
  prev: Pick<ArcgisServiceData, 'selectedLayerIds' | 'layers'>,
  probedIds: number[],
): number[] {
  if (!prev.selectedLayerIds) return probedIds;
  const kept = new Set(prev.selectedLayerIds.map(String));
  const keptOrAdded = probedIds.filter(
    (id) => kept.has(String(id)) || !prev.layers.some((l) => l.id === id),
  );
  return keptOrAdded.length > 0 ? keptOrAdded : probedIds;
}

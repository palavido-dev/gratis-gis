// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which sublayers of a v3 data layer are related tables of a given
 * parent layer, for the field app's "Add related" buttons.
 *
 * The field page used to offer every sublayer with a parent key column
 * under every spatial layer of the same data layer. On a hydrant it
 * offered the trees' inspections table and wrote the hydrant's id into
 * `tree_id`, an orphan no tree ever shows. `parentLayerId` names the
 * parent, and the other surfaces (feature browser, form designer)
 * already go by it.
 */
export interface ChildLayerCandidate {
  id: string;
  geometryType: string | null;
  parentLayerId?: string;
  parentFkColumn?: string;
}

export function childLayersOf<T extends ChildLayerCandidate>(
  layers: readonly T[],
  parentId: string,
): T[] {
  const spatialCount = layers.filter((l) => l.geometryType !== null).length;
  return layers.filter((l) => {
    if (l.id === parentId) return false;
    if (typeof l.parentFkColumn !== 'string' || l.parentFkColumn.length === 0) {
      return false;
    }
    if (typeof l.parentLayerId === 'string' && l.parentLayerId.length > 0) {
      return l.parentLayerId === parentId;
    }
    // Older rows carry only the key column. With one spatial layer the
    // parent can only be that layer; with several there is no telling
    // which one, and guessing wrong writes orphans.
    return spatialCount === 1;
  });
}

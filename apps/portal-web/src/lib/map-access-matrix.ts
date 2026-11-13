// SPDX-License-Identifier: AGPL-3.0-or-later
// Decisions behind the web map's per-layer access matrix.
//
// Kept out of the dialog so they can be tested: changing one cell
// used to turn a layer's policy to custom with only that one entry,
// which hid the layer from everyone else on the map, and the "no item
// access" warning ignored org-wide and public items and their owners.
import type {
  ItemAccess,
  ItemShare,
  MapLayerAccess,
  MapLayerAccessEntry,
} from '@gratis-gis/shared-types';
import { DEFAULT_LAYER_ACCESS } from '@gratis-gis/shared-types';

export interface MatrixPrincipalRef {
  type: 'user' | 'group';
  id: string;
}

/** Who can reach a backing item without an explicit share. */
export interface ItemReach {
  access?: ItemAccess | undefined;
  ownerId?: string | undefined;
}

/** What a principal gets on a layer that has no entry for it. */
function inheritedEntry(p: MatrixPrincipalRef): MapLayerAccessEntry {
  return {
    principalType: p.type,
    principalId: p.id,
    view: true,
    query: true,
    edit: false,
  };
}

/** The access a principal has on a layer, as the matrix shows it. */
export function matrixEntryFor(
  access: MapLayerAccess | undefined,
  p: MatrixPrincipalRef,
): MapLayerAccessEntry {
  const acc = access ?? DEFAULT_LAYER_ACCESS;
  const found = acc.entries.find(
    (e) => e.principalType === p.type && e.principalId === p.id,
  );
  if (found) return found;
  if (acc.policy === 'custom') {
    return {
      principalType: p.type,
      principalId: p.id,
      view: false,
      query: false,
      edit: false,
    };
  }
  return inheritedEntry(p);
}

/**
 * Change one principal's access on a layer. A layer moving from
 * inherit to custom first gets an entry for every principal in the
 * matrix with what they inherited, so changing one person's cell does
 * not take the layer away from everyone else the map is shared with.
 */
export function writeMatrixEntry(
  access: MapLayerAccess | undefined,
  principals: readonly MatrixPrincipalRef[],
  p: MatrixPrincipalRef,
  patch: Partial<MapLayerAccessEntry>,
  editable: boolean,
): MapLayerAccess {
  const acc = access ?? DEFAULT_LAYER_ACCESS;
  const entries =
    acc.policy === 'custom'
      ? [...acc.entries]
      : principals.map((pp) => matrixEntryFor(acc, pp));
  const idx = entries.findIndex(
    (e) => e.principalType === p.type && e.principalId === p.id,
  );
  const merged: MapLayerAccessEntry = { ...matrixEntryFor(acc, p), ...patch };
  // Clamp edit for non-editable layers so the stored matrix matches
  // what the UI offers.
  if (!editable) merged.edit = false;
  if (idx >= 0) entries[idx] = merged;
  else entries.push(merged);
  return { policy: 'custom', entries };
}

/**
 * Can this principal read the backing item? An explicit share to the
 * user or one of their groups counts, and so does what the server's
 * canRead allows without a share: an org-wide or public item, and the
 * item's owner. `shares` undefined means not loaded yet (no warning).
 */
export function principalHasItemAccess(
  shares: readonly ItemShare[] | undefined,
  reach: ItemReach | undefined,
  p: MatrixPrincipalRef,
  groupMemberships: Record<string, string[]>,
): boolean {
  if (!shares) return true;
  if (reach?.access === 'public' || reach?.access === 'org') return true;
  if (p.type === 'user') {
    if (reach?.ownerId === p.id) return true;
    if (shares.some((s) => s.principalType === 'user' && s.principalId === p.id)) {
      return true;
    }
    const myGroups = groupMemberships[p.id] ?? [];
    return myGroups.some((gid) =>
      shares.some((s) => s.principalType === 'group' && s.principalId === gid),
    );
  }
  return shares.some((s) => s.principalType === 'group' && s.principalId === p.id);
}

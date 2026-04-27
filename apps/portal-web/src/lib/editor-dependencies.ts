import type { Item, ItemShare, ItemType } from '@gratis-gis/shared-types';

/**
 * One node in an editor's dependency chain. The matrix renders one
 * row per node. Carries enough metadata for the client-side
 * `hasAccess` predicate: item.access + orgId + share rows. The
 * `rationale` line tells the author *why* this row is here -- the
 * referenced map, an editing target, a layer underneath the
 * referenced map -- so the chain reads as a story not a flat list.
 */
export interface EditorDependencyNode {
  id: string;
  title: string;
  type: ItemType;
  access: 'private' | 'org' | 'public';
  orgId: string;
  shares: ItemShare[];
  rationale: string;
}

/**
 * Walk an editor's dependency chain (one level + map's own layers)
 * and return the full set of items the editor needs at runtime,
 * each annotated with the metadata needed to evaluate per-principal
 * access. Used by the editor's share-time hard prompt and the
 * detail-page item-access matrix.
 *
 * Walks:
 *   editor.data.mapId            -> map item (rationale: "Referenced map")
 *   editor.data.targets[].dataLayerId -> data_layer items ("Editing target")
 *   map.data.basemap             -> basemap item ("Basemap of <map>")
 *   map.data.layers[].source.itemId  -> data_layer / arcgis_service items
 *                                       ("Layer in <map>")
 *
 * Stops there. Does not chase the editor's targets' own layer-source
 * dependencies because target data_layers are themselves the
 * authoritative items for editing -- they don't sit on top of yet
 * another item the way map layers do.
 *
 * Dedupes by id; the rationale of the first occurrence wins (the
 * highest-level reason this item is in the chain).
 *
 * Auth: the caller must have visibility on the editor item itself
 * (the request goes through visibleWhere). Dep items the caller
 * cannot see fall out of the result silently -- those rows would
 * not be actionable from the matrix anyway because the caller
 * cannot grant access to items they cannot see. The composite
 * surface flags this with a "could not resolve N items" line.
 */
export async function loadEditorDependencyChain(
  editorId: string,
): Promise<{ nodes: EditorDependencyNode[]; unresolvedCount: number }> {
  // 1. Pull the editor item itself so we know mapId + targets.
  const editorRes = await fetch(`/api/portal/items/${editorId}`);
  if (!editorRes.ok) {
    throw new Error(`Failed to load editor (${editorRes.status})`);
  }
  const editor = (await editorRes.json()) as Item & {
    data?: {
      mapId?: string;
      targets?: Array<{ dataLayerId?: string }>;
    } | null;
  };
  const editorData = editor.data ?? {};

  // 2. Collect direct dep ids + their rationales. We track rationale
  //    + insertion order side-by-side so the dedupe step can
  //    preserve the highest-level reason.
  type Pending = { id: string; rationale: string };
  const direct: Pending[] = [];
  const mapId =
    typeof editorData.mapId === 'string' ? editorData.mapId : null;
  if (mapId) direct.push({ id: mapId, rationale: 'Referenced map' });
  for (const t of editorData.targets ?? []) {
    if (typeof t?.dataLayerId === 'string') {
      direct.push({ id: t.dataLayerId, rationale: 'Editing target' });
    }
  }

  // 3. Walk one hop deeper through the referenced map's own deps so
  //    the matrix surfaces gaps a sharee will actually hit at
  //    runtime. The map's `/dependencies` endpoint already returns
  //    its layer items (data_layer / arcgis_service) plus the
  //    basemap item id. A failure here is non-fatal: we still
  //    surface the editor's direct deps even if the map's hop
  //    can't be resolved.
  let mapTitle = 'referenced map';
  if (mapId) {
    try {
      const mapRes = await fetch(`/api/portal/items/${mapId}`);
      if (mapRes.ok) {
        const m = (await mapRes.json()) as Item;
        if (m.title) mapTitle = m.title;
      }
      const depRes = await fetch(`/api/portal/items/${mapId}/dependencies`);
      if (depRes.ok) {
        const layerDeps = (await depRes.json()) as Array<{
          id: string;
          type: ItemType;
        }>;
        for (const d of layerDeps) {
          if (d.type === 'basemap') {
            direct.push({ id: d.id, rationale: `Basemap of ${mapTitle}` });
          } else {
            direct.push({ id: d.id, rationale: `Layer in ${mapTitle}` });
          }
        }
      }
    } catch {
      /* non-fatal: editor's direct deps still surface */
    }
  }

  // 4. Dedupe (first-seen rationale wins) and fetch each surviving
  //    item with its shares. Done in parallel; the matrix can
  //    render incrementally if we wanted but the lists are small
  //    in practice (a referenced map with ~20 layers is the high
  //    end of normal). The editor item itself is excluded -- we're
  //    auditing what the EDITOR depends on, not the editor itself,
  //    and including it would muddle the gap count.
  const seen = new Map<string, string>();
  for (const p of direct) {
    if (p.id === editorId) continue;
    if (!seen.has(p.id)) seen.set(p.id, p.rationale);
  }
  const ids = Array.from(seen.keys());
  if (ids.length === 0) return { nodes: [], unresolvedCount: 0 };

  const settled = await Promise.allSettled(
    ids.map((id) => fetch(`/api/portal/items/${id}`)),
  );

  const nodes: EditorDependencyNode[] = [];
  let unresolvedCount = 0;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i]!;
    const r = settled[i];
    if (!r || r.status !== 'fulfilled' || !r.value.ok) {
      unresolvedCount += 1;
      continue;
    }
    let item: (Item & { shares?: ItemShare[] }) | null = null;
    try {
      item = (await r.value.json()) as Item & { shares?: ItemShare[] };
    } catch {
      unresolvedCount += 1;
      continue;
    }
    if (!item) {
      unresolvedCount += 1;
      continue;
    }
    nodes.push({
      id: item.id,
      title: item.title,
      type: item.type,
      access: item.access,
      orgId: item.orgId,
      shares: item.shares ?? [],
      rationale: seen.get(id) ?? '',
    });
  }
  return { nodes, unresolvedCount };
}

/**
 * Pure access predicate matching the server's visibleWhere logic
 * for a single (item, principal) pair. The matrix and the share-
 * time hard prompt both call this so the gap definition stays in
 * one place.
 *
 * Mirrors sharing.service.ts visibleWhere(): public, org-same,
 * direct user share, group share for any of the principal's
 * groups. Expired shares are filtered upstream by the API; if a
 * caller has stale share rows in hand they should drop expired
 * ones before passing them in.
 *
 * This is intentionally a pure function rather than a server call:
 * we want to evaluate it for every cell in the matrix without
 * issuing N x M HTTP probes. Trade-off: this duplicates the
 * server's predicate. That's fine because the server still
 * authoritatively gates access on the actual fetch -- the matrix
 * is a UI hint, not the security boundary.
 */
export function principalHasItemAccess(
  item: Pick<EditorDependencyNode, 'access' | 'orgId' | 'shares'>,
  principal: { type: 'user' | 'group'; id: string; orgId: string },
  groupMemberships: Record<string, string[]>,
): boolean {
  if (item.access === 'public') return true;
  if (item.access === 'org' && item.orgId === principal.orgId) return true;
  for (const s of item.shares) {
    if (s.principalType === principal.type && s.principalId === principal.id) {
      return true;
    }
    if (
      principal.type === 'user' &&
      s.principalType === 'group' &&
      (groupMemberships[principal.id] ?? []).includes(s.principalId)
    ) {
      return true;
    }
  }
  return false;
}

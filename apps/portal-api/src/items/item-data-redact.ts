// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fields inside `item.data` that a reader must not receive verbatim.
 *
 *   - `drawings[].anonymousAuthorToken` (map): the cookie value that
 *     proves an anonymous reviewer wrote a markup set. Anyone holding
 *     it can edit or delete that set, so it never leaves the server,
 *     for any reader. ItemsService.update puts it back on a map Save.
 *   - `layers[].syncConflicts` (data_layer): conflict artifacts carry
 *     full copies of both sides of a conflicted feature, including
 *     rows a row-scoped or geo-limited viewer may not read. Only
 *     callers who can edit the layer (and so resolve the conflicts)
 *     AND read every feature of that layer get them. An edit share
 *     limited to own rows or to an area still passes canEdit.
 *
 * Every read path that returns `data` (item detail, list with full
 * data, the public item endpoint) runs through this one function.
 */
export function redactItemData(
  type: string,
  data: unknown,
  opts: {
    canEdit: boolean;
    /** Whether the reader sees every feature of a layer with this
     *  editing policy. Absent means yes (callers that only pass
     *  canEdit: false never keep conflicts anyway). */
    readsAllFeatures?: (layerPolicy: 'all-rows' | 'own-rows-only') => boolean;
  },
): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  if (type === 'map' && Array.isArray(obj.drawings)) {
    return {
      ...obj,
      drawings: obj.drawings.map((set: unknown) => {
        if (!set || typeof set !== 'object') return set;
        const { anonymousAuthorToken: _token, ...rest } = set as Record<string, unknown>;
        void _token;
        return rest;
      }),
    };
  }
  if (type === 'data_layer' && Array.isArray(obj.layers)) {
    return {
      ...obj,
      layers: obj.layers.map((layer: unknown) => {
        if (!layer || typeof layer !== 'object') return layer;
        const policy =
          (layer as { editingPolicy?: unknown }).editingPolicy === 'own-rows-only'
            ? 'own-rows-only'
            : 'all-rows';
        if (opts.canEdit && (opts.readsAllFeatures?.(policy) ?? true)) {
          return layer;
        }
        const { syncConflicts: _conflicts, ...rest } = layer as Record<string, unknown>;
        void _conflicts;
        return rest;
      }),
    };
  }
  return data;
}

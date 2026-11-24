// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The data blob for a "Save as" copy of a map (#797).
 *
 * A copy is a new map owned by the caller, so anything in the source
 * that is about the source's own audience or reviewers does not carry
 * over as-is:
 *
 *   - `layers[].effective` is the server's per-viewer verdict, added on
 *     read by filterMapForViewer. It describes the source's reader, not
 *     the copy, so it is dropped.
 *   - `layers[].access`: a caller who can edit the source read the real
 *     per-layer access entries, and keeping them is what "same map, new
 *     name" means. A caller who could only view it received a policy
 *     with the roster stripped, and a `custom` policy with no entries
 *     hides the layer from everyone except the copy's owner. That is a
 *     broken state nobody chose, so those layers go back to `inherit`.
 *     Inherit widens nothing: the backing item's own sharing still
 *     decides who reads the layer, and the viewer only received layers
 *     whose backing item they can already read.
 *   - `drawings` are other people's redlines on the source. They come
 *     along only when the caller asks, and never with
 *     `anonymousAuthorToken`, which would let whoever holds the cookie
 *     edit the set on the copy too.
 *   - `allowAnonymousDrawings` opens a map to public markup. The copy
 *     starts private and its owner turns that on deliberately if they
 *     want it.
 */
export interface MapCopyOptions {
  includeMarkup: boolean;
  /** Whether the caller can edit the source map. */
  sourceEditable: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function copyLayer(
  layer: Record<string, unknown>,
  sourceEditable: boolean,
): Record<string, unknown> {
  const { effective: _effective, ...rest } = layer;
  void _effective;
  if (sourceEditable) return rest;
  const access = isRecord(rest.access) ? rest.access : null;
  if (access?.policy !== 'custom') return rest;
  return { ...rest, access: { policy: 'inherit', entries: [] } };
}

export function mapDataForCopy(
  data: Record<string, unknown>,
  opts: MapCopyOptions,
): Record<string, unknown> {
  const {
    drawings,
    allowAnonymousDrawings: _anon,
    ...rest
  } = data;
  void _anon;
  const out: Record<string, unknown> = { ...rest };
  if (Array.isArray(rest.layers)) {
    out.layers = rest.layers
      .filter(isRecord)
      .map((l) => copyLayer(l, opts.sourceEditable));
  }
  if (opts.includeMarkup && Array.isArray(drawings)) {
    out.drawings = drawings.filter(isRecord).map((set) => {
      const { anonymousAuthorToken: _token, ...kept } = set;
      void _token;
      return kept;
    });
  }
  return out;
}

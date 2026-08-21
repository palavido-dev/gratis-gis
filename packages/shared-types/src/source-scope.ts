// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everything that narrows one data source, resolved in one pure
 * function.
 *
 * This is the point of the data-source model: two widgets reading one
 * source cannot disagree about what it means, because neither of them
 * decides. The author's fixed predicate, the reader's viewport, the
 * reader's cross-filter click and the relate to a parent source are
 * composed here, in that order, and a widget just gets the answer.
 *
 * It lives here, as a pure function over shared shapes, because it was
 * a `useMemo` body inside a five-thousand-line client component and
 * therefore untestable. Three bugs of the same shape shipped in one
 * day as a result, and all three were of the worst kind: a number that
 * was quietly wrong with no error anywhere.
 *
 *   - a chart re-filtered itself through its own parent, so clicking
 *     one bar moved all of them
 *   - a widget announced a filter that had never been applied to it
 *   - the relate scope was dropped entirely on the anonymous endpoint
 *
 * The design note that named `resolveSourceScope` predates any of
 * that; this is that function, finally extracted, with the spec table
 * beside it.
 */
import type { AppDataSource, CrossFilterSelection } from './custom-app';
import type { MapLayerFilter } from './map';

export type Bbox = [number, number, number, number];

/** The relate as the aggregate endpoint takes it. */
export interface ResolvedVia {
  myField: string;
  parentField: string;
  parentItemId: string;
  parentLayerId: string;
  parentBbox?: Bbox;
  parentWhere?: MapLayerFilter;
}

export interface SourceScope {
  /** Viewport, when the source follows a map. */
  bbox?: Bbox;
  /** Author predicate ANDed with the reader's selection. */
  where?: MapLayerFilter;
  /** Relate, when the source declares one and the parent resolves. */
  via?: ResolvedVia;
  /**
   * What to tell the reader this source is narrowed BY, if anything.
   *
   * Set only where a selection genuinely reached this source, directly
   * or through the relate. A widget must not caption itself as
   * filtered on the strength of a selection somewhere else on the
   * page: that turns a correct number into a wrong one, which is worse
   * than saying nothing.
   */
  note?: string;
  /** True when the scope is spatial, so unlocated rows drop out. */
  spatial: boolean;
}

/**
 * The filter clauses a selection stands for.
 *
 * A histogram bar selects a half-open RANGE and carries its own
 * clauses; everything else is an equality, or a null test for the
 * bucket of rows with nothing recorded.
 */
export function selectionClauses(
  sel: Pick<CrossFilterSelection, 'field' | 'value' | 'clauses'>,
): MapLayerFilter['clauses'] {
  if (sel.clauses && sel.clauses.length > 0) return sel.clauses;
  return [
    sel.value === null
      ? { field: sel.field, op: 'is-null', value: '' }
      : { field: sel.field, op: '==', value: sel.value },
  ];
}

/**
 * The selection projected onto a map's layers.
 *
 * A map does not read a `SourceScope`: it draws tiles and narrows
 * them with a MapLibre expression, so a selection reaches it as an
 * extra clause on one layer's own `filter`. That projection used to
 * live inline in the map widget, which is why the attribute table
 * beside it kept listing rows the map was hiding: the widget derived
 * filtered layers for itself and the table read the unfiltered ones.
 * Both call this now.
 *
 * `targetLayerId` is the RESOLVED layer's own id. Since a source
 * whose layer the map already draws reuses that layer rather than
 * publishing a copy, the id is the map author's, and recomputing a
 * synthetic one here would filter a layer that is not on the map.
 *
 * Returns the input array unchanged when nothing applies, so a caller
 * can use it as a memo value without re-rendering on every pan.
 */
export function applySelectionToLayers<
  // `MapLayer.filter` is `MapLayerFilter | null`, not optional, and
  // the callers pass real MapLayers. Accept both spellings rather
  // than making them cast, since a cast at the call site is how a
  // shape mismatch gets hidden instead of noticed.
  L extends {
    id: string;
    filter?: MapLayerFilter | null;
    // `kind` is here so this is not a weak type. Without a property
    // every source member shares, TypeScript rejects the whole union
    // as having nothing in common with `{ via?: ... }`.
    source?: { kind: string; via?: { parentWhere?: MapLayerFilter } } | null;
  },
>(args: {
  layers: readonly L[];
  /** Layer drawing the selection's OWN source. Narrowed client side. */
  targetLayerId: string | null | undefined;
  /**
   * Layers whose relate points AT the selection's source.
   *
   * These are the ones a MapLibre expression cannot narrow: the
   * selection is a fact about the parent, and the child's tile does
   * not carry the parent's rows. The predicate goes onto the relate
   * instead, which travels to the server on the tile request.
   *
   * Without this, clicking a bar narrowed every chart reading a
   * related source while the map layer drawn from that same source
   * kept every feature.
   */
  relatedLayerIds?: readonly string[];
  selection: Pick<CrossFilterSelection, 'field' | 'value' | 'clauses'> | null;
}): readonly L[] {
  const { layers, targetLayerId, selection } = args;
  const related = new Set(args.relatedLayerIds ?? []);
  if (!selection || (!targetLayerId && related.size === 0)) return layers;
  const clauses = selectionClauses(selection);
  if (clauses.length === 0) return layers;
  let hit = false;
  const next = layers.map((l) => {
    if (l.id === targetLayerId) {
      hit = true;
      // Keep any filter the author already set: a selection narrows
      // what is on screen, it never widens it.
      const existing = l.filter?.clauses ?? [];
      return {
        ...l,
        filter: {
          combinator: 'all' as const,
          clauses: [...existing, ...clauses],
        },
      };
    }
    // A layer can be both, in principle. Order does not matter: the
    // two narrowings compose, and `else if` here would silently drop
    // one of them.
    if (related.has(l.id) && l.source?.via) {
      hit = true;
      const existing = l.source.via.parentWhere?.clauses ?? [];
      return {
        ...l,
        source: {
          ...l.source,
          via: {
            ...l.source.via,
            parentWhere: {
              combinator: 'all' as const,
              clauses: [...existing, ...clauses],
            },
          },
        },
      };
    }
    return l;
  });
  return hit ? next : layers;
}

export interface ResolveSourceScopeArgs {
  source: AppDataSource | undefined;
  /** The source named by `source.via.sourceId`, already looked up. */
  parent?: AppDataSource | undefined;
  /** Viewport of the map this source follows, if it follows one. */
  bbox?: Bbox | undefined;
  /** Viewport of the map the PARENT follows, if it follows one. */
  parentBbox?: Bbox | undefined;
  /** The page's current cross-filter selection, if any. */
  selection?: CrossFilterSelection | null;
  /**
   * Resolve as though the selection published by this widget did not
   * exist. The widget that published a filter keeps its own context,
   * or a bar chart collapses to the bar you just clicked and throws
   * away what made the click mean anything.
   */
  ignoreSelectionFrom?: string | undefined;
}

export function resolveSourceScope(args: ResolveSourceScopeArgs): SourceScope {
  const { source, parent, bbox, parentBbox } = args;
  const selection =
    args.selection &&
    args.ignoreSelectionFrom !== undefined &&
    args.selection.widgetId === args.ignoreSelectionFrom
      ? null
      : (args.selection ?? null);

  const selecting =
    selection && source && selection.sourceId === source.id ? selection : null;
  const parentSelecting =
    selection && parent && selection.sourceId === parent.id ? selection : null;

  const clauses: MapLayerFilter['clauses'] = [
    ...(source?.where?.clauses ?? []),
  ];
  if (selecting) clauses.push(...selectionClauses(selecting));

  const out: SourceScope = { spatial: Boolean(bbox) };
  if (bbox) out.bbox = bbox;
  if (clauses.length > 0) {
    // The author's clauses are ANDed with the reader's selection
    // regardless of the author's own combinator: a reader's click
    // narrows what the author published, it never widens it.
    out.where = { combinator: 'all', clauses };
  }

  // A relate needs BOTH a declaration and a parent that resolved. A
  // source whose via points at a deleted source falls back to being
  // unrelated rather than silently scoping to nothing.
  if (source?.via && parent) {
    const parentClauses: MapLayerFilter['clauses'] = [
      ...(parent.where?.clauses ?? []),
    ];
    if (parentSelecting) parentClauses.push(...selectionClauses(parentSelecting));
    out.via = {
      myField: source.via.myField,
      parentField: source.via.parentField,
      parentItemId: parent.layer.dataLayerId,
      parentLayerId: parent.layer.layerKey,
      ...(parentBbox ? { parentBbox } : {}),
      ...(parentClauses.length > 0
        ? { parentWhere: { combinator: 'all' as const, clauses: parentClauses } }
        : {}),
    };
    if (parentSelecting && !selecting) out.note = parentSelecting.label;
  }
  if (selecting) out.note = selecting.label;
  return out;
}

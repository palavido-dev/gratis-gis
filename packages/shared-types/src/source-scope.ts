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
import type { MapLayerFilter, ScopedLayerFilter } from './map';

export type Bbox = [number, number, number, number];

/** The relate as the aggregate endpoint takes it. */
export interface ResolvedVia {
  myField: string;
  parentField: string;
  parentItemId: string;
  parentLayerId: string;
  parentBbox?: Bbox;
  parentWhere?: ScopedLayerFilter;
}

export interface SourceScope {
  /** Viewport, when the source follows a map. */
  bbox?: Bbox;
  /** Author predicate ANDed with the reader's selection. */
  where?: ScopedLayerFilter;
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
 * `author` narrowed by `extra` (a reader's selection), without ever
 * widening it or changing what the author's clauses mean.
 *
 * When the author's filter is "match all" (or has one clause), the
 * selection's clauses join it in one flat `all`, which is exact. When
 * it is "match any" over two or more clauses, the flat shape cannot
 * say "(A or B) and selection", so the selection is carried beside it
 * in `and` (see ScopedLayerFilter). Merging used to turn the author's
 * "A or B" into "A and B and selection".
 */
export function narrowFilter(
  author: ScopedLayerFilter | null | undefined,
  extra: MapLayerFilter['clauses'],
): ScopedLayerFilter | undefined {
  const own = author?.clauses ?? [];
  if (extra.length === 0) {
    return author && (own.length > 0 || author.and) ? author : undefined;
  }
  if (!author || own.length === 0) {
    // Nothing of the author's to keep but a carried selection, which
    // a new click narrows further.
    const carried = author?.and?.clauses ?? [];
    return { combinator: 'all', clauses: [...carried, ...extra] };
  }
  if (author.combinator === 'all' || own.length === 1) {
    const merged: ScopedLayerFilter = {
      combinator: 'all',
      clauses: [...own, ...extra],
    };
    if (author.and) merged.and = author.and;
    return merged;
  }
  return {
    combinator: author.combinator,
    clauses: own,
    and: {
      combinator: 'all',
      clauses: [...(author.and?.clauses ?? []), ...extra],
    },
  };
}

/**
 * Two filters ANDed into one, in the shape every evaluator reads.
 *
 * Each filter is a conjunction of groups (the outer clauses, and its
 * `and` when present). "Match all" groups and single clauses merge
 * into one `all` list. A "match any" group of two or more clauses
 * must stay whole. Up to two groups fit (outer plus `and`); when more
 * than that are needed, null is returned and the caller decides
 * (the attribute table then falls back to one flat `all`, which can
 * only show fewer rows, never more).
 */
export function andFilters(
  a: ScopedLayerFilter | null | undefined,
  b: ScopedLayerFilter | null | undefined,
): ScopedLayerFilter | null | undefined {
  const groups: MapLayerFilter[] = [];
  for (const f of [a, b]) {
    if (!f) continue;
    if (f.clauses.length > 0) groups.push({ combinator: f.combinator, clauses: f.clauses });
    if (f.and && f.and.clauses.length > 0) groups.push(f.and);
  }
  if (groups.length === 0) return undefined;
  const all: MapLayerFilter['clauses'] = [];
  const anys: MapLayerFilter[] = [];
  for (const g of groups) {
    if (g.combinator === 'any' && g.clauses.length > 1) anys.push(g);
    else all.push(...g.clauses);
  }
  const allGroup: MapLayerFilter | null =
    all.length > 0 ? { combinator: 'all', clauses: all } : null;
  const parts = [...anys, ...(allGroup ? [allGroup] : [])];
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return { ...parts[0]!, and: parts[1]! };
  return null;
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
    source?: { kind: string; via?: { parentWhere?: ScopedLayerFilter } } | null;
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
    let out = l;
    if (l.id === targetLayerId) {
      hit = true;
      // Keep any filter the author already set: a selection narrows
      // what is on screen, it never widens it, and it never changes
      // what the author's "match any" means (narrowFilter).
      out = {
        ...out,
        filter: narrowFilter(l.filter, clauses) ?? null,
      };
    }
    // A layer can be both, in principle. Order does not matter: the
    // two narrowings compose, so both are applied to the same layer
    // (an early return in the branch above dropped this one).
    if (related.has(l.id) && out.source?.via) {
      hit = true;
      const parentWhere = narrowFilter(out.source.via.parentWhere, clauses);
      out = {
        ...out,
        source: {
          ...out.source,
          via: {
            ...out.source.via,
            ...(parentWhere ? { parentWhere } : {}),
          },
        },
      };
    }
    return out;
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
   * The layer read by the source the selection names (#77). A
   * selection's clauses are written in that LAYER's vocabulary, so
   * they apply to every source reading the same layer, not only to
   * the one source the publishing widget happened to be bound to.
   * Without this, a dashboard with "sites", "sites over a health
   * limit" and "sites gone quiet" as three sources over one layer
   * narrowed exactly one of its three site KPIs on a filter pick,
   * which read as the other two being broken.
   */
  selectionSourceLayer?: AppDataSource['layer'] | undefined;
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

  // The selection applies to a source when it names it, or when the
  // named source reads the same layer: the clauses are facts about
  // the LAYER's attributes, and two sources over one layer must not
  // disagree about a predicate both can evaluate.
  const sameLayer = (
    a: AppDataSource['layer'] | undefined,
    b: AppDataSource['layer'] | undefined,
  ): boolean =>
    a !== undefined &&
    b !== undefined &&
    a.dataLayerId === b.dataLayerId &&
    a.layerKey === b.layerKey;
  const appliesTo = (s: AppDataSource): boolean =>
    selection !== null &&
    (selection.sourceId === s.id ||
      sameLayer(args.selectionSourceLayer, s.layer));

  const selecting = selection && source && appliesTo(source) ? selection : null;
  const parentSelecting =
    selection && parent && appliesTo(parent) ? selection : null;

  const out: SourceScope = { spatial: Boolean(bbox) };
  if (bbox) out.bbox = bbox;
  // With no selection the author's filter goes through as written,
  // combinator included. With one, it is ANDed beside the author's
  // filter (narrowFilter): a reader's click narrows what the author
  // published, it never widens it or turns "A or B" into "A and B".
  const where = narrowFilter(
    source?.where,
    selecting ? selectionClauses(selecting) : [],
  );
  if (where) out.where = where;

  // A relate needs BOTH a declaration and a parent that resolved. A
  // source whose via points at a deleted source falls back to being
  // unrelated rather than silently scoping to nothing.
  if (source?.via && parent) {
    const parentWhere = narrowFilter(
      parent.where,
      parentSelecting ? selectionClauses(parentSelecting) : [],
    );
    out.via = {
      myField: source.via.myField,
      parentField: source.via.parentField,
      parentItemId: parent.layer.dataLayerId,
      parentLayerId: parent.layer.layerKey,
      ...(parentBbox ? { parentBbox } : {}),
      ...(parentWhere ? { parentWhere } : {}),
    };
    if (parentSelecting && !selecting) out.note = parentSelecting.label;
  }
  if (selecting) out.note = selecting.label;
  return out;
}

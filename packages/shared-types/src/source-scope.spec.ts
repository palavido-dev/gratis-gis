// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  applySelectionToLayers,
  resolveSourceScope,
  selectionClauses,
  type Bbox,
} from './source-scope.js';
import type { MapLayerFilter } from './map.js';
import type { AppDataSource, CrossFilterSelection } from './custom-app.js';

/**
 * The scope table.
 *
 * Every bug this subsystem shipped was a number that was quietly
 * wrong: a chart re-filtering itself, a tile captioned as filtered
 * when it was not, a relate dropped on one surface and not the other.
 * None of them threw, none showed in the console, and all three were
 * caught only by computing the answer a second way and comparing.
 *
 * So the assertions here are about WHICH predicates reach a source and
 * what the reader is told, not about whether something rendered.
 */

const LAYER = { dataLayerId: 'item-1', layerKey: 'lay' };
const PARENT_LAYER = { dataLayerId: 'item-2', layerKey: 'sites' };
const BBOX: Bbox = [-81, 38, -79, 40];
const PARENT_BBOX: Bbox = [-80.5, 39, -80, 39.5];

const src = (over: Partial<AppDataSource> = {}): AppDataSource => ({
  id: 's1',
  layer: LAYER,
  ...over,
});

const parentSrc = (over: Partial<AppDataSource> = {}): AppDataSource => ({
  id: 'p1',
  layer: PARENT_LAYER,
  ...over,
});

const where = (field: string, value: string) => ({
  combinator: 'all' as const,
  clauses: [{ field, op: '==' as const, value }],
});

const sel = (over: Partial<CrossFilterSelection> = {}): CrossFilterSelection => ({
  widgetId: 'w1',
  sourceId: 's1',
  field: 'status',
  value: 'open',
  label: 'Status: open',
  ...over,
});

const VIA = { sourceId: 'p1', parentField: 'key', myField: 'key' };

describe('resolveSourceScope: what narrows a source', () => {
  it('an unscoped source is unscoped', () => {
    const s = resolveSourceScope({ source: src() });
    expect(s).toEqual({ spatial: false });
  });

  it('following a map contributes a bbox and marks the scope spatial', () => {
    const s = resolveSourceScope({ source: src(), bbox: BBOX });
    expect(s.bbox).toEqual(BBOX);
    expect(s.spatial).toBe(true);
  });

  it("carries the author's predicate with no selection", () => {
    const s = resolveSourceScope({
      source: src({ where: where('kind', 'well') }),
    });
    expect(s.where).toEqual(where('kind', 'well'));
    // Nothing narrowed it for the READER, so there is nothing to say.
    expect(s.note).toBeUndefined();
  });

  it("ANDs the reader's click onto the author's predicate", () => {
    const s = resolveSourceScope({
      source: src({ where: where('kind', 'well') }),
      selection: sel(),
    });
    expect(s.where).toEqual({
      combinator: 'all',
      clauses: [
        { field: 'kind', op: '==', value: 'well' },
        { field: 'status', op: '==', value: 'open' },
      ],
    });
    expect(s.note).toBe('Status: open');
  });

  // The author may have written combinator 'any'; a reader's click
  // still narrows rather than widens, so the composition is always all.
  it("does not let an author's 'any' widen a reader's click", () => {
    const s = resolveSourceScope({
      source: src({
        where: {
          combinator: 'any',
          clauses: [
            { field: 'a', op: '==', value: '1' },
            { field: 'b', op: '==', value: '2' },
          ],
        },
      }),
      selection: sel(),
    });
    expect(s.where?.combinator).toBe('all');
    expect(s.where?.clauses).toHaveLength(3);
  });
});

describe('resolveSourceScope: whose selection reaches whom', () => {
  it('a selection on ANOTHER source does not touch this one', () => {
    const s = resolveSourceScope({
      source: src({ where: where('kind', 'well') }),
      selection: sel({ sourceId: 'other' }),
    });
    // This is the bug that captioned a correct 692 as "Measured: Iron".
    expect(s.where).toEqual(where('kind', 'well'));
    expect(s.note).toBeUndefined();
  });

  it('a selection on an unrelated source leaves a plain source alone', () => {
    const s = resolveSourceScope({
      source: src(),
      selection: sel({ sourceId: 'other' }),
    });
    expect(s).toEqual({ spatial: false });
  });

  it('ignoreSelectionFrom keeps the publishing widget in context', () => {
    const s = resolveSourceScope({
      source: src(),
      selection: sel({ widgetId: 'w1' }),
      ignoreSelectionFrom: 'w1',
    });
    expect(s.where).toBeUndefined();
    expect(s.note).toBeUndefined();
  });

  it('ignoreSelectionFrom does NOT suppress another widget selection', () => {
    const s = resolveSourceScope({
      source: src(),
      selection: sel({ widgetId: 'w2' }),
      ignoreSelectionFrom: 'w1',
    });
    expect(s.where).toBeDefined();
    expect(s.note).toBe('Status: open');
  });

  it('a null-valued selection means "nothing recorded", not "everything"', () => {
    const s = resolveSourceScope({
      source: src(),
      selection: sel({ value: null, label: 'Status: (no value)' }),
    });
    expect(s.where?.clauses).toEqual([
      { field: 'status', op: 'is-null', value: '' },
    ]);
  });

  it('a selection carrying its own clauses uses them verbatim', () => {
    // A histogram bar is a half-open range; no single value says that.
    const s = resolveSourceScope({
      source: src(),
      selection: sel({
        value: '3',
        clauses: [
          { field: 'iron', op: '>=', value: '0.3' },
          { field: 'iron', op: '<', value: '1' },
        ],
      }),
    });
    expect(s.where?.clauses).toEqual([
      { field: 'iron', op: '>=', value: '0.3' },
      { field: 'iron', op: '<', value: '1' },
    ]);
  });
});

describe('resolveSourceScope: the relate', () => {
  it('declares the relate with the parent it resolved', () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc(),
    });
    expect(s.via).toEqual({
      myField: 'key',
      parentField: 'key',
      parentItemId: 'item-2',
      parentLayerId: 'sites',
    });
  });

  // A via pointing at a deleted source must not scope to nothing: a
  // silently empty dashboard is the failure mode to avoid.
  it('falls back to unrelated when the parent does not resolve', () => {
    const s = resolveSourceScope({ source: src({ via: VIA }) });
    expect(s.via).toBeUndefined();
    expect(s.spatial).toBe(false);
  });

  it("carries the parent's viewport, which is how a child gets an extent", () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc(),
      parentBbox: PARENT_BBOX,
    });
    expect(s.via?.parentBbox).toEqual(PARENT_BBOX);
    // The CHILD has no extent of its own; it is in view when its
    // parent is. That must not read as a spatial scope on the child.
    expect(s.bbox).toBeUndefined();
    expect(s.spatial).toBe(false);
  });

  it("carries the parent's author predicate", () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc({ where: where('county', 'Marion') }),
    });
    expect(s.via?.parentWhere).toEqual(where('county', 'Marion'));
  });

  it('a selection on the PARENT reaches the child through the relate', () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc(),
      selection: sel({ sourceId: 'p1', label: 'Site: Deckers Creek' }),
    });
    expect(s.via?.parentWhere?.clauses).toEqual([
      { field: 'status', op: '==', value: 'open' },
    ]);
    // ...and the child says so, because its numbers did change.
    expect(s.note).toBe('Site: Deckers Creek');
    // But it is the PARENT that was filtered, not the child directly.
    expect(s.where).toBeUndefined();
  });

  it('a parent selection stacks with the parent author predicate', () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc({ where: where('county', 'Marion') }),
      selection: sel({ sourceId: 'p1' }),
    });
    expect(s.via?.parentWhere?.clauses).toEqual([
      { field: 'county', op: '==', value: 'Marion' },
      { field: 'status', op: '==', value: 'open' },
    ]);
  });

  // The regression that made clicking one bar move all of them: the
  // publisher's own selection came back through the relate.
  it('ignoreSelectionFrom also blocks the selection arriving via the parent', () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc(),
      selection: sel({ sourceId: 'p1', widgetId: 'w1' }),
      ignoreSelectionFrom: 'w1',
    });
    expect(s.via?.parentWhere).toBeUndefined();
    expect(s.note).toBeUndefined();
  });

  it("a direct selection wins the note over the parent's", () => {
    const s = resolveSourceScope({
      source: src({ via: VIA }),
      parent: parentSrc(),
      // Cannot be on both at once in practice, but the precedence has
      // to be defined rather than incidental.
      selection: sel({ sourceId: 's1', label: 'Direct' }),
    });
    expect(s.note).toBe('Direct');
  });

  it('composes everything at once without dropping any of it', () => {
    const s = resolveSourceScope({
      source: src({ where: where('kind', 'well'), via: VIA }),
      parent: parentSrc({ where: where('county', 'Marion') }),
      bbox: BBOX,
      parentBbox: PARENT_BBOX,
      selection: sel({ sourceId: 's1' }),
    });
    expect(s.bbox).toEqual(BBOX);
    expect(s.spatial).toBe(true);
    expect(s.where?.clauses).toHaveLength(2);
    expect(s.via?.parentBbox).toEqual(PARENT_BBOX);
    expect(s.via?.parentWhere).toEqual(where('county', 'Marion'));
    expect(s.note).toBe('Status: open');
  });
});

describe('applySelectionToLayers: what the map and the table both draw', () => {
  type L = { id: string; filter?: MapLayerFilter };
  const layers: L[] = [
    { id: 'a' },
    {
      id: 'b',
      filter: {
        combinator: 'all',
        clauses: [{ field: 'kind', op: '==', value: 'well' }],
      },
    },
  ];

  it('returns the SAME array when nothing applies', () => {
    // Identity is load bearing: the caller uses it to decide whether
    // to hand MapCanvas a new object, and a fresh array on every pan
    // remounts the sources.
    expect(
      applySelectionToLayers({ layers, targetLayerId: 'b', selection: null }),
    ).toBe(layers);
    expect(
      applySelectionToLayers({
        layers,
        targetLayerId: null,
        selection: sel(),
      }),
    ).toBe(layers);
  });

  it('returns the same array when the target is not one of these layers', () => {
    // A dashboard page can hold two maps; a selection on a layer this
    // map does not draw must leave it alone rather than filter
    // whichever layer happens to sort first.
    expect(
      applySelectionToLayers({
        layers,
        targetLayerId: 'not-here',
        selection: sel(),
      }),
    ).toBe(layers);
  });

  it('narrows only the target layer', () => {
    const out = applySelectionToLayers({
      layers,
      targetLayerId: 'a',
      selection: sel(),
    });
    expect(out[0]!.filter?.clauses).toEqual([
      { field: 'status', op: '==', value: 'open' },
    ]);
    // The untouched layer keeps its identity, not just its value.
    expect(out[1]).toBe(layers[1]);
  });

  it("ANDs onto the author's filter rather than replacing it", () => {
    const out = applySelectionToLayers({
      layers,
      targetLayerId: 'b',
      selection: sel(),
    });
    expect(out[1]!.filter).toEqual({
      combinator: 'all',
      clauses: [
        { field: 'kind', op: '==', value: 'well' },
        { field: 'status', op: '==', value: 'open' },
      ],
    });
    // ...without mutating the input, which two consumers now share.
    expect(layers[1]!.filter?.clauses).toHaveLength(1);
  });

  it('applies a histogram bar as its range, not as its bucket index', () => {
    const out = applySelectionToLayers({
      layers,
      targetLayerId: 'a',
      selection: sel({
        value: '3',
        clauses: [
          { field: 'iron', op: '>=', value: '0.3' },
          { field: 'iron', op: '<', value: '1' },
        ],
      }),
    });
    expect(out[0]!.filter?.clauses).toHaveLength(2);
  });

  it('applies a null selection as a null test, not as no filter', () => {
    const out = applySelectionToLayers({
      layers,
      targetLayerId: 'a',
      selection: sel({ value: null }),
    });
    expect(out[0]!.filter?.clauses).toEqual([
      { field: 'status', op: 'is-null', value: '' },
    ]);
  });

  it('agrees clause for clause with what resolveSourceScope sends', () => {
    // The whole point. The map filters client side and the widgets
    // filter server side; if these two ever disagree, a chart and the
    // map beside it describe different subsets and nothing errors.
    const selection = sel({ sourceId: 's1' });
    const scope = resolveSourceScope({ source: src(), selection });
    const bare: L[] = [{ id: 'a' }];
    const out = applySelectionToLayers({
      layers: bare,
      targetLayerId: 'a',
      selection,
    });
    expect(out[0]!.filter?.clauses).toEqual(scope.where?.clauses);
  });
});

describe('applySelectionToLayers: layers that relate to the selection', () => {
  type L = {
    id: string;
    filter?: MapLayerFilter | null;
    source?: {
      kind: string;
      via?: { parentField?: string; parentWhere?: MapLayerFilter };
    };
  };

  const child = (parentWhere?: MapLayerFilter): L => ({
    id: 'child',
    source: {
      kind: 'data-layer',
      via: { parentField: 'key', ...(parentWhere ? { parentWhere } : {}) },
    },
  });

  it('puts the predicate on the relate, not on the layer filter', () => {
    // The child's tile has no column to test: the selection is a fact
    // about the PARENT. Narrowing l.filter here would filter on a
    // field the child does not have and hide everything.
    const layers = [child()];
    const out = applySelectionToLayers({
      layers,
      targetLayerId: null,
      relatedLayerIds: ['child'],
      selection: sel(),
    });
    expect(out[0]!.filter).toBeUndefined();
    expect(out[0]!.source?.via?.parentWhere?.clauses).toEqual([
      { field: 'status', op: '==', value: 'open' },
    ]);
  });

  it("stacks onto the parent's author predicate, keeping both", () => {
    const layers = [child(where('county', 'Marion'))];
    const out = applySelectionToLayers({
      layers,
      targetLayerId: null,
      relatedLayerIds: ['child'],
      selection: sel(),
    });
    expect(out[0]!.source?.via?.parentWhere?.clauses).toEqual([
      { field: 'county', op: '==', value: 'Marion' },
      { field: 'status', op: '==', value: 'open' },
    ]);
    // The relate's own fields survive the rewrite.
    expect(out[0]!.source?.via?.parentField).toBe('key');
  });

  it('leaves a related layer that carries no relate alone', () => {
    // Named as related but the layer has no via to hang it on. Adding
    // one here would invent a join the author never declared.
    const layers: L[] = [{ id: 'child', source: { kind: 'data-layer' } }];
    expect(
      applySelectionToLayers({
        layers,
        targetLayerId: null,
        relatedLayerIds: ['child'],
        selection: sel(),
      }),
    ).toBe(layers);
  });

  it('narrows the direct layer and the related one in the same pass', () => {
    const layers: L[] = [{ id: 'sites' }, child()];
    const out = applySelectionToLayers({
      layers,
      targetLayerId: 'sites',
      relatedLayerIds: ['child'],
      selection: sel(),
    });
    expect(out[0]!.filter?.clauses).toHaveLength(1);
    expect(out[1]!.source?.via?.parentWhere?.clauses).toHaveLength(1);
  });

  it('does not mutate the input relate', () => {
    const layers = [child()];
    applySelectionToLayers({
      layers,
      targetLayerId: null,
      relatedLayerIds: ['child'],
      selection: sel(),
    });
    expect(layers[0]!.source?.via?.parentWhere).toBeUndefined();
  });

  it('a selection the relate does not point at leaves it whole', () => {
    const layers = [child()];
    expect(
      applySelectionToLayers({
        layers,
        targetLayerId: null,
        relatedLayerIds: [],
        selection: sel(),
      }),
    ).toBe(layers);
  });
});

describe('selectionClauses', () => {
  it('prefers the selection own clauses', () => {
    expect(
      selectionClauses({
        field: 'x',
        value: '1',
        clauses: [{ field: 'y', op: '>=', value: '5' }],
      }),
    ).toEqual([{ field: 'y', op: '>=', value: '5' }]);
  });

  it('falls back to equality, and to is-null for a null value', () => {
    expect(selectionClauses({ field: 'x', value: 'a' })).toEqual([
      { field: 'x', op: '==', value: 'a' },
    ]);
    expect(selectionClauses({ field: 'x', value: null })).toEqual([
      { field: 'x', op: 'is-null', value: '' },
    ]);
  });

  it('treats an empty clause array as absent rather than as match-all', () => {
    expect(selectionClauses({ field: 'x', value: 'a', clauses: [] })).toEqual([
      { field: 'x', op: '==', value: 'a' },
    ]);
  });
});

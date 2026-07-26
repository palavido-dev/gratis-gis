// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Specs for the shared-types map helpers. They live here (rather
// than in packages/shared-types) because portal-api hosts the
// monorepo's only jest setup and its moduleNameMapper already pins
// @gratis-gis/shared-types at the package SOURCE, so these tests
// exercise src directly without waiting on a package build. Same
// arrangement as src/engine/*.spec.ts for the engine package.

import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  effectiveStyleAtZoom,
  scaledStyleExpression,
} from '@gratis-gis/shared-types';
import type {
  MapLayer,
  MapLayerStyle,
  ScaledSymbologyClass,
} from '@gratis-gis/shared-types';

const BASE = '#000000';
const RED = '#ff0000';
const BLUE = '#0000ff';

function styleWithPointColor(color: string): MapLayerStyle {
  return {
    point: { ...DEFAULT_LAYER_STYLE.point, color },
    line: { ...DEFAULT_LAYER_STYLE.line },
    polygon: { ...DEFAULT_LAYER_STYLE.polygon },
  };
}

function cls(
  min: number | undefined,
  max: number | undefined,
  color: string,
): ScaledSymbologyClass {
  return {
    ...(min !== undefined ? { minZoom: min } : {}),
    ...(max !== undefined ? { maxZoom: max } : {}),
    style: styleWithPointColor(color),
    renderer: { kind: 'simple' },
  };
}

function makeLayer(scaled?: ScaledSymbologyClass[]): MapLayer {
  return {
    id: 'layer-1',
    title: 'Test layer',
    visible: true,
    opacity: 1,
    source: { kind: 'geojson-url', url: 'https://example.com/data.geojson' },
    ...(scaled !== undefined ? { scaledSymbology: scaled } : {}),
    style: styleWithPointColor(BASE),
    renderer: { kind: 'simple' },
    popup: { ...DEFAULT_LAYER_POPUP },
    interactions: { ...DEFAULT_LAYER_INTERACTIONS },
    labels: { ...DEFAULT_LAYER_LABELS },
    search: { ...DEFAULT_LAYER_SEARCH },
    filter: null,
    scale: { ...DEFAULT_LAYER_SCALE },
    access: { ...DEFAULT_LAYER_ACCESS, entries: [] },
  };
}

const pickPointColor = (st: MapLayerStyle): string => st.point.color;

/** Pull the numeric stops out of a ['step', ['zoom'], default, z1,
 *  v1, z2, v2, ...] expression. */
function stopZooms(expr: unknown[]): number[] {
  const zooms: number[] = [];
  for (let i = 3; i < expr.length; i += 2) {
    zooms.push(expr[i] as number);
  }
  return zooms;
}

/** MapLibre step semantics: default before the first stop, then the
 *  latest stop whose zoom is <= the input. */
function evalStep(expr: string | unknown[], zoom: number): string {
  if (!Array.isArray(expr)) return expr;
  let value = expr[2] as string;
  for (let i = 3; i < expr.length; i += 2) {
    if (zoom >= (expr[i] as number)) value = expr[i + 1] as string;
  }
  return value;
}

function assertStrictlyAscending(expr: unknown[]): void {
  const zooms = stopZooms(expr);
  for (let i = 1; i < zooms.length; i += 1) {
    expect(zooms[i]!).toBeGreaterThan(zooms[i - 1]!);
  }
}

describe('scaledStyleExpression', () => {
  it('returns the scalar base value when the layer has no classes', () => {
    expect(scaledStyleExpression(makeLayer(), pickPointColor)).toBe(BASE);
    expect(scaledStyleExpression(makeLayer([]), pickPointColor)).toBe(BASE);
  });

  it('returns a scalar for a single any-to-any class (zero-stop guard)', () => {
    // A step expression with zero stops fails MapLibre validation
    // and blanks the layer; the helper must return the plain value.
    const layer = makeLayer([cls(undefined, undefined, RED)]);
    expect(scaledStyleExpression(layer, pickPointColor)).toBe(RED);
  });

  it('collapses a class starting at zoom 0 into the step default (z0 guard)', () => {
    const layer = makeLayer([cls(0, 10, RED)]);
    const expr = scaledStyleExpression(layer, pickPointColor) as unknown[];
    expect(expr).toEqual(['step', ['zoom'], RED, 10, BASE]);
  });

  it('emits default base with entry and exit stops for a bounded class', () => {
    const layer = makeLayer([cls(5, 10, RED)]);
    const expr = scaledStyleExpression(layer, pickPointColor) as unknown[];
    expect(expr).toEqual(['step', ['zoom'], BASE, 5, RED, 10, BASE]);
  });

  it('returns to base in the gap between two non-adjacent classes', () => {
    const layer = makeLayer([cls(0, 5, RED), cls(7, 10, BLUE)]);
    const expr = scaledStyleExpression(layer, pickPointColor) as unknown[];
    expect(expr).toEqual(['step', ['zoom'], RED, 5, BASE, 7, BLUE, 10, BASE]);
    assertStrictlyAscending(expr);
  });

  it('keeps stops strictly ascending when two classes share a minZoom', () => {
    // Both classes start at 5. The old transition emitter pushed two
    // stops at zoom 5, which MapLibre rejects, silently dropping the
    // paint property and blanking the layer. First-match-wins says
    // the earlier class (RED) owns [5, 10); once it ends, the later
    // class (BLUE) is the only match until 12.
    const layer = makeLayer([cls(5, 10, RED), cls(5, 12, BLUE)]);
    const expr = scaledStyleExpression(layer, pickPointColor) as unknown[];
    assertStrictlyAscending(expr);
    expect(expr).toEqual([
      'step',
      ['zoom'],
      BASE,
      5,
      RED,
      10,
      BLUE,
      12,
      BASE,
    ]);
  });

  it('keeps stops strictly ascending for overlapping ranges', () => {
    // RED [0, 8) overlaps BLUE [5, 12). The old emitter produced the
    // stop sequence 0, 8, 5, 12 (non-ascending -> rejected). The
    // rebuilt expression evaluates first-match-wins at every
    // boundary: RED until 8 (it is earlier in the array), BLUE from
    // 8 (only remaining match), base from 12.
    const layer = makeLayer([cls(0, 8, RED), cls(5, 12, BLUE)]);
    const expr = scaledStyleExpression(layer, pickPointColor) as unknown[];
    assertStrictlyAscending(expr);
    expect(expr).toEqual(['step', ['zoom'], RED, 8, BLUE, 12, BASE]);
  });

  it('matches effectiveStyleAtZoom at every boundary and midpoint', () => {
    // The rendered paint and the legend / editor preview read the
    // same layer through two different code paths; they must never
    // disagree, including for author-error overlaps.
    const layers = [
      makeLayer([cls(5, 10, RED), cls(5, 12, BLUE)]),
      makeLayer([cls(0, 8, RED), cls(5, 12, BLUE)]),
      makeLayer([cls(3, 6, RED), cls(1, 9, BLUE), cls(9, 14, RED)]),
    ];
    const zooms = [0, 0.5, 1, 2.9, 3, 5, 5.5, 6, 7.9, 8, 9, 11.9, 12, 14, 20];
    for (const layer of layers) {
      const expr = scaledStyleExpression(layer, pickPointColor);
      for (const z of zooms) {
        expect(evalStep(expr, z)).toBe(
          pickPointColor(effectiveStyleAtZoom(layer, z)),
        );
      }
    }
  });
});

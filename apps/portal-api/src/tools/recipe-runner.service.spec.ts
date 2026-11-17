// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ToolParameter, ToolStep } from '@gratis-gis/shared-types';

import {
  resolveParameters,
  substituteStep,
  type ResolvedValue,
  type ToolRunInput,
} from './recipe-runner.service.js';

describe('resolveParameters', () => {
  it('uses the hardcoded value when no input is supplied', () => {
    const params: ToolParameter[] = [
      {
        kind: 'predicate',
        name: 'pred',
        label: 'Predicate',
        binding: { mode: 'hardcoded', value: 'intersects' },
      },
    ];
    const resolved = resolveParameters(params, {});
    expect(resolved.get('pred')).toEqual({ kind: 'predicate', value: 'intersects' });
  });

  it('uses runtime-pick default when no input is supplied', () => {
    const params: ToolParameter[] = [
      {
        kind: 'predicate',
        name: 'pred',
        label: 'Predicate',
        binding: { mode: 'runtime-pick', defaultValue: 'within' },
      },
    ];
    const resolved = resolveParameters(params, {});
    expect(resolved.get('pred')).toEqual({ kind: 'predicate', value: 'within' });
  });

  it('rejects a runtime-pick value not in the allowed set', () => {
    const params: ToolParameter[] = [
      {
        kind: 'predicate',
        name: 'pred',
        label: 'Predicate',
        binding: {
          mode: 'runtime-pick',
          defaultValue: 'intersects',
          allowed: ['intersects', 'within'],
        },
      },
    ];
    const supplied: Record<string, ToolRunInput> = { pred: 'contains' };
    expect(() => resolveParameters(params, supplied)).toThrow(BadRequestException);
  });

  it('throws when a required parameter has no value or default', () => {
    const params: ToolParameter[] = [
      {
        kind: 'feature-source',
        name: 'aoi',
        label: 'Area of interest',
        required: true,
        binding: { mode: 'runtime-draw' },
      },
    ];
    expect(() => resolveParameters(params, {})).toThrow(BadRequestException);
  });

  it('accepts an inline-geojson feature-source value', () => {
    const params: ToolParameter[] = [
      {
        kind: 'feature-source',
        name: 'aoi',
        label: 'AOI',
        binding: { mode: 'runtime-draw' },
      },
    ];
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    const resolved = resolveParameters(params, {
      aoi: { kind: 'inline-geojson', geojson: polygon },
    });
    const v = resolved.get('aoi');
    expect(v?.kind).toBe('feature-source');
  });

  it('validates distance min / max bounds at runtime-input', () => {
    const params: ToolParameter[] = [
      {
        kind: 'distance',
        name: 'dist',
        label: 'Distance',
        binding: {
          mode: 'runtime-input',
          defaultMeters: 100,
          minMeters: 50,
          maxMeters: 500,
        },
      },
    ];
    expect(() => resolveParameters(params, { dist: 10 })).toThrow(BadRequestException);
    expect(() => resolveParameters(params, { dist: 1000 })).toThrow(BadRequestException);
    const ok = resolveParameters(params, { dist: 250 });
    expect(ok.get('dist')).toEqual({ kind: 'distance', meters: 250 });
  });
});

describe('substituteStep', () => {
  it('replaces a parameter ref in spatial-filter.otherSource with a resolved data_layer', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'parameter', name: 'aoi' },
        predicate: { kind: 'fixed', value: 'intersects' },
      },
    };
    const resolved = new Map<string, ResolvedValue>();
    resolved.set('aoi', {
      kind: 'feature-source',
      value: { kind: 'data_layer', itemId: 'layer-1', layerKey: 'default' },
    });
    const out = substituteStep(step, resolved) as Extract<ToolStep, { tool: 'spatial-filter' }>;
    expect(out.params.otherSource).toEqual({
      kind: 'data_layer',
      itemId: 'layer-1',
      layerKey: 'default',
    });
  });

  it('replaces a parameter ref with inline-geometry when the param is inline-geojson', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'parameter', name: 'aoi' },
        predicate: { kind: 'fixed', value: 'within' },
      },
    };
    const polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const resolved = new Map<string, ResolvedValue>();
    resolved.set('aoi', {
      kind: 'feature-source',
      value: { kind: 'inline-geojson', geojson: polygon },
    });
    const out = substituteStep(step, resolved) as Extract<ToolStep, { tool: 'spatial-filter' }>;
    expect(out.params.otherSource).toEqual({
      kind: 'inline-geometry',
      geometry: polygon,
    });
  });

  it('substitutes a predicate parameter ref', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: { kind: 'parameter', name: 'pred' },
      },
    };
    const resolved = new Map<string, ResolvedValue>();
    resolved.set('pred', { kind: 'predicate', value: 'contains' });
    const out = substituteStep(step, resolved) as Extract<ToolStep, { tool: 'spatial-filter' }>;
    expect(out.params.predicate).toEqual({ kind: 'fixed', value: 'contains' });
  });

  it('substitutes a distance parameter ref', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'data_layer', itemId: 'p' },
        predicate: { kind: 'fixed', value: 'near' },
        distance: { kind: 'parameter', name: 'dist' },
      },
    };
    const resolved = new Map<string, ResolvedValue>();
    resolved.set('dist', { kind: 'distance', meters: 750 });
    const out = substituteStep(step, resolved) as Extract<ToolStep, { tool: 'spatial-filter' }>;
    expect(out.params.distance).toEqual({ kind: 'fixed', meters: 750 });
  });

  it('passes non-spatial-filter steps through untouched', () => {
    const step: ToolStep = { tool: 'centroid', params: {} };
    const out = substituteStep(step, new Map());
    expect(out).toBe(step);
  });

  it('throws when a parameter ref points at the wrong kind', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'parameter', name: 'aoi' },
        predicate: { kind: 'fixed', value: 'intersects' },
      },
    };
    const resolved = new Map<string, ResolvedValue>();
    resolved.set('aoi', { kind: 'predicate', value: 'within' });
    expect(() => substituteStep(step, resolved)).toThrow(BadRequestException);
  });

  it('throws when a referenced parameter was not resolved', () => {
    const step: ToolStep = {
      tool: 'spatial-filter',
      params: {
        otherSource: { kind: 'parameter', name: 'missing' },
        predicate: { kind: 'fixed', value: 'intersects' },
      },
    };
    expect(() => substituteStep(step, new Map())).toThrow(BadRequestException);
  });
});


describe('RecipeRunnerService SQL failure', () => {
  it('does not echo the database error to the caller', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RecipeRunnerService } = require('./recipe-runner.service.js') as typeof import('./recipe-runner.service.js');
    const leak = 'column "ssn_last4" of relation "observation" does not exist';
    const svc = new RecipeRunnerService(
      {
        $queryRawUnsafe: async () => {
          throw new Error(leak);
        },
      } as never,
      {
        get: async () => ({ id: 'layer-1', type: 'data_layer' }),
        isFeatureReadLimited: async () => false,
      } as never,
      {} as never,
    );
    const recipe = {
      parameters: [
        {
          kind: 'feature-source',
          name: 'target',
          label: 'Target',
          binding: {
            mode: 'hardcoded',
            value: { kind: 'data_layer', itemId: 'layer-1', layerKey: 'default' },
          },
        },
      ],
      pipeline: [],
      output: { kind: 'selection', targetParameterRef: 'target' },
    };
    const run = (
      svc as unknown as {
        runSelectionInternal(...a: unknown[]): Promise<unknown>;
      }
    ).runSelectionInternal({ id: 'u' }, 'tool-1', recipe, { parameters: {} });
    await expect(run).rejects.toBeInstanceOf(BadRequestException);
    await expect(run).rejects.not.toThrow(/ssn_last4/);
  });
});

describe('RecipeRunnerService layer access (every layer a selection reads)', () => {
  const recipe = {
    kind: 'recipe',
    parameters: [
      { name: 'target', kind: 'feature-source', binding: { mode: 'runtime-host' } },
      { name: 'other', kind: 'feature-source', binding: { mode: 'runtime-host' } },
    ],
    pipeline: [
      {
        tool: 'spatial-filter',
        params: { predicate: 'intersects', otherSource: { kind: 'parameter', name: 'other' } },
      },
    ],
    output: { kind: 'selection', targetParameterRef: 'target' },
  } as never;
  const target = { kind: 'data_layer', itemId: '11111111-1111-4111-8111-111111111111', layerKey: 'a' };
  const other = { kind: 'data_layer', itemId: '22222222-2222-4222-8222-222222222222', layerKey: 'b' };

  function runner(items: { get: (u: unknown, id: string) => Promise<unknown>; isFeatureReadLimited: (u: unknown, id: string) => Promise<boolean> }) {
    const queries: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { RecipeRunnerService } = require('./recipe-runner.service.js') as typeof import('./recipe-runner.service.js');
    const svc = new RecipeRunnerService(
      { $queryRawUnsafe: async (sql: string) => (queries.push(sql), []) } as never,
      items as never,
      {} as never,
    );
    return { svc, queries };
  }

  it('refuses a pipeline layer the caller cannot read, before any SQL runs', async () => {
    const { svc, queries } = runner({
      get: async (_u, id) => {
        if (id === other.itemId) throw new NotFoundException();
        return { id, type: 'data_layer' };
      },
      isFeatureReadLimited: async () => false,
    });
    await expect(
      (svc as unknown as { runSelectionInternal: (...a: unknown[]) => Promise<unknown> }).runSelectionInternal(
        { id: 'u' }, 'tool-1', recipe, { parameters: { target, other } },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(queries).toEqual([]);
  });

  it('refuses a target shared with a row or area limit', async () => {
    const { svc, queries } = runner({
      get: async (_u, id) => ({ id, type: 'data_layer' }),
      isFeatureReadLimited: async (_u, id) => id === target.itemId,
    });
    await expect(
      (svc as unknown as { runSelectionInternal: (...a: unknown[]) => Promise<unknown> }).runSelectionInternal(
        { id: 'u' }, 'tool-1', recipe, { parameters: { target, other } },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries).toEqual([]);
  });

  it('a hardcoded layer cannot be replaced by the request', async () => {
    const hardcoded = {
      ...(recipe as object),
      parameters: [
        { name: 'target', kind: 'feature-source', binding: { mode: 'runtime-host' } },
        { name: 'other', kind: 'feature-source', binding: { mode: 'hardcoded', value: { kind: 'data_layer', itemId: '33333333-3333-4333-8333-333333333333', layerKey: 'c' } } },
      ],
    } as never;
    const seen: string[] = [];
    const { svc } = runner({
      get: async (_u, id) => (seen.push(id), { id, type: 'data_layer' }),
      isFeatureReadLimited: async () => false,
    });
    await (svc as unknown as { runSelectionInternal: (...a: unknown[]) => Promise<unknown> })
      .runSelectionInternal({ id: 'u' }, 'tool-1', hardcoded, { parameters: { target, other } })
      .catch(() => undefined);
    expect(seen).toContain('33333333-3333-4333-8333-333333333333');
    expect(seen).not.toContain(other.itemId);
  });
});

describe('search padding and caller inputs on tool runs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./recipe-runner.service.js') as typeof import('./recipe-runner.service.js');

  it('pads longitude by 1/cos(latitude) so 1000 m reaches 1000 m east and west', () => {
    const [w, s, , n] = mod.padBboxMeters([10, 40, 10, 40], 1000);
    expect(40 - s).toBeCloseTo(1000 / 111_320, 8);
    // Measured at the most poleward edge, where a degree is shortest.
    const eastWestMeters = (10 - w) * 111_320 * Math.cos((n * Math.PI) / 180);
    expect(eastWestMeters).toBeCloseTo(1000, 3);
  });

  it('clamps the padded box to the valid range', () => {
    expect(mod.padBboxMeters([179.99, 89.99, 179.99, 89.99], 5000)).toEqual([
      expect.any(Number),
      expect.any(Number),
      180,
      90,
    ]);
  });

  it('refuses a point outside the valid range with a 400', () => {
    const params: ToolParameter[] = [
      { kind: 'point', name: 'p', label: 'P', binding: { mode: 'runtime-pick' } } as never,
    ];
    expect(() =>
      resolveParameters(params, { p: { kind: 'point-input', lng: 500, lat: 0 } } as never),
    ).toThrow(BadRequestException);
  });

  it('refuses malformed preset ids and tag filters with a 400', () => {
    const params: ToolParameter[] = [
      { kind: 'osm-feature', name: 'o', label: 'O', binding: { mode: 'runtime-pick' } } as never,
    ];
    expect(() =>
      resolveParameters(params, { o: { kind: 'osm-feature-input', presetIds: [1] } } as never),
    ).toThrow(BadRequestException);
    expect(() =>
      resolveParameters(params, {
        o: { kind: 'osm-feature-input', presetIds: ['cafe'], tagFilters: [null] },
      } as never),
    ).toThrow(BadRequestException);
  });

  it('says a derived layer cannot be an area of interest', async () => {
    const svc = new mod.RecipeRunnerService({} as never, {} as never, {} as never);
    await expect(
      (svc as unknown as { computeAoiBbox: (u: unknown, v: unknown) => Promise<unknown> }).computeAoiBbox(
        { id: 'u' },
        { kind: 'derived_layer', itemId: '11111111-1111-4111-8111-111111111111' },
      ),
    ).rejects.toThrow(/derived layer cannot be used as an area of interest/);
  });

  it('defaults a data layer AOI to the default sublayer', async () => {
    const seen: unknown[] = [];
    const svc = new mod.RecipeRunnerService(
      { $queryRaw: async () => [{ extent: 'BOX(0 0,1 1)' }] } as never,
      { isFeatureReadLimited: async (_u: unknown, _id: string, key: string) => (seen.push(key), false) } as never,
      {} as never,
    );
    const bbox = await (svc as unknown as { computeAoiBbox: (u: unknown, v: unknown) => Promise<unknown> }).computeAoiBbox(
      { id: 'u' },
      { kind: 'data_layer', itemId: '11111111-1111-4111-8111-111111111111' },
    );
    expect(seen).toEqual(['default']);
    expect(bbox).toEqual([0, 0, 1, 1]);
  });
});

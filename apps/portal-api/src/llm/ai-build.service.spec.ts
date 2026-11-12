// SPDX-License-Identifier: AGPL-3.0-or-later
import { AiBuildService } from './ai-build.service.js';
import type { BuildPlan } from './build-plan.js';

/**
 * apply() turns a parsed plan into items. Map layer ids must be
 * unique (two reused layers can share a layer key), and a failure
 * part way must not leave half a build behind.
 */
function plan(over: Partial<BuildPlan> = {}): BuildPlan {
  return {
    summary: 's',
    layers: [
      {
        ref: 'a',
        title: 'A',
        geometry: 'point',
        fields: [],
        reuse: { itemId: 'item-a', layerKey: 'sites' },
      },
      {
        ref: 'b',
        title: 'B',
        geometry: 'point',
        fields: [],
        reuse: { itemId: 'item-b', layerKey: 'sites' },
      },
    ],
    map: {
      title: 'M',
      center: [0, 0],
      zoom: 3,
      layers: [
        { ref: 'a', color: '#ff0000' },
        { ref: 'b', color: '#00ff00' },
        { ref: 'a', color: '#0000ff' },
      ],
    },
    form: null,
    app: null,
    ...over,
  };
}

function service(failOn: string | null) {
  let n = 0;
  const items = {
    create: jest.fn(async (_u: unknown, input: { type: string; data: unknown }) => {
      if (input.type === failOn) throw new Error('boom');
      n += 1;
      return { id: `new-${n}` };
    }),
    update: jest.fn(async () => ({})),
    remove: jest.fn(async () => undefined),
  };
  const svc = new AiBuildService(items as never, {} as never, {} as never);
  const apply = (svc as unknown as {
    apply: (u: unknown, p: BuildPlan) => Promise<Array<{ id: string }>>;
  }).apply.bind(svc);
  return { items, apply };
}

describe('AiBuildService.apply', () => {
  it('gives each map layer a unique id and places each ref once', async () => {
    const { items, apply } = service(null);
    await apply({ id: 'u' }, plan());
    const mapCall = items.create.mock.calls.find((c) => c[1].type === 'map')!;
    const layers = (mapCall[1].data as { layers: Array<{ id: string }> }).layers;
    expect(layers.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('trashes what it made when a later step fails', async () => {
    const { items, apply } = service('map');
    await expect(
      apply(
        { id: 'u' },
        plan({
          layers: [
            { ref: 'c', title: 'C', geometry: 'point', fields: [], reuse: null },
          ],
          map: { title: 'M', center: [0, 0], zoom: 3, layers: [{ ref: 'c', color: '#ff0000' }] },
        }),
      ),
    ).rejects.toThrow('boom');
    expect(items.remove).toHaveBeenCalledWith({ id: 'u' }, 'new-1');
  });
});

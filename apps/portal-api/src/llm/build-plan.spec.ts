// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseBuildPlan, UnusablePlanError, type CatalogLayer } from './build-plan';

const catalog: CatalogLayer[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Hydrants',
    layerKey: 'hydrants',
    geometry: 'point',
    fields: ['status'],
  },
];

describe('parseBuildPlan', () => {
  it('reuses a catalog layer and styles a map and a viewer app', () => {
    const plan = parseBuildPlan(
      JSON.stringify({
        summary: 'A hydrant map.',
        layers: [
          {
            ref: 'hydrants',
            reuseItemId: catalog[0]!.id,
            title: 'Ignored',
          },
        ],
        map: {
          title: 'Hydrant map',
          center: [-79.8, 38.9],
          zoom: 13,
          layers: [{ ref: 'hydrants', color: '#c2410c' }],
        },
        app: { title: 'Hydrant viewer' },
      }),
      catalog,
    );
    expect(plan.layers[0]?.reuse?.itemId).toBe(catalog[0]!.id);
    expect(plan.map?.layers[0]?.color).toBe('#c2410c');
    expect(plan.app?.title).toBe('Hydrant viewer');
  });

  it('creates a new layer and drops a reuse id the caller cannot see', () => {
    expect(() =>
      parseBuildPlan(
        JSON.stringify({
          layers: [{ ref: 'x', reuseItemId: 'not-a-real-layer', title: 'Nope', geometry: 'point' }],
        }),
        catalog,
      ),
    ).toThrow(UnusablePlanError);
  });

  it('accepts a fenced plan and normalizes a field name', () => {
    const plan = parseBuildPlan(
      '```json\n{"summary":"Parks","layers":[{"ref":"parks","title":"Parks","geometry":"polygon","fields":[{"name":"Name!","label":"Name","type":"string"},{"name":"acres","label":"Acres","type":"number"}]}],"form":{"title":"Park note","layerRef":"parks","questions":[{"id":"note","type":"text","label":"Note","required":true}]}}\n```',
      [],
    );
    expect(plan.layers[0]?.fields.map((field) => field.name)).toEqual(['name', 'acres']);
    expect(plan.form?.questions[0]?.required).toBe(true);
  });

  it('refuses a plan with nothing to create', () => {
    expect(() => parseBuildPlan('{"summary":"hi"}', [])).toThrow(UnusablePlanError);
  });
});

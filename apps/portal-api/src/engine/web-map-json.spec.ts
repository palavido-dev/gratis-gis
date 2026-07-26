// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  lensToWebMapJson,
  webMapJsonToLens,
} from '@gratis-gis/engine';
import type {
  EsriWebMap,
  Lens,
  WebMapJsonContext,
} from '@gratis-gis/engine';

const ctx: WebMapJsonContext = {
  portalBaseUrl: 'https://portal.example.org',
  basemap: {
    id: 'basemap-positron',
    title: 'Positron',
    tileUrl: 'https://basemaps.example.org/positron/{z}/{x}/{y}.png',
    attribution: '(c) Carto',
  },
};

describe('lensToWebMapJson', () => {
  it('emits an ArcGISFeatureLayer at the per-sublayer geojson endpoint', () => {
    const lens: Lens = {
      id: 'lens-parcels',
      name: 'Parcels',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.version).toMatch(/^2\./);
    expect(wm.operationalLayers).toHaveLength(1);
    const layer = wm.operationalLayers![0]!;
    expect(layer.layerType).toBe('ArcGISFeatureLayer');
    expect(layer.title).toBe('Parcels');
    // The route DataLayerFeaturesController actually serves, derived
    // from the lens's data_layer:<itemId>:<layerKey> scope. The old
    // /api/lenses/... emission pointed at a controller that never
    // existed.
    expect(layer.url).toBe(
      'https://portal.example.org/api/items/abc/layers/lyr/geojson',
    );
    expect(wm.baseMap?.baseMapLayers[0]?.url).toBe(ctx.basemap.tileUrl);
  });

  it('emits a VectorTileLayer at the per-sublayer z/x/y tile endpoint', () => {
    const lens: Lens = {
      id: 'lens-mvt',
      name: 'Tiles',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'mvt' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.operationalLayers![0]?.layerType).toBe('VectorTileLayer');
    expect(wm.operationalLayers![0]?.url).toBe(
      'https://portal.example.org/api/items/abc/layers/lyr/tile/{z}/{x}/{y}.mvt',
    );
  });

  it('skips operational layers for non-map renderers', () => {
    const lens: Lens = {
      id: 'lens-scalar',
      name: 'Total cost',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'scalar_json', expr: 'sum(attrs->>cost)' },
    };
    expect(lensToWebMapJson(lens, ctx).operationalLayers).toEqual([]);
  });

  it('skips lenses whose scope is not a single data_layer sublayer', () => {
    // No portal URL exists for these; emitting a fabricated one
    // would just be a dead link.
    const weirdScope: Lens = {
      id: 'lens-weird',
      name: 'Weird',
      query: { scopes: ['something_else:abc'] },
      render: { kind: 'geojson' },
    };
    expect(lensToWebMapJson(weirdScope, ctx).operationalLayers).toEqual([]);
    const multiScope: Lens = {
      id: 'lens-multi-scope',
      name: 'Union',
      query: { scopes: ['data_layer:a:x', 'data_layer:b:y'] },
      render: { kind: 'geojson' },
    };
    expect(lensToWebMapJson(multiScope, ctx).operationalLayers).toEqual([]);
  });

  it('translates a single-clause attrFilter to a definitionExpression', () => {
    const lens: Lens = {
      id: 'lens-filtered',
      name: 'Big parcels',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: { field: 'area', op: 'gte', value: 5000 },
      },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(
      wm.operationalLayers![0]?.layerDefinition?.definitionExpression,
    ).toBe('"area" >= 5000');
  });

  it('translates IN with a list literal', () => {
    const lens: Lens = {
      id: 'lens-multi',
      name: 'Selected statuses',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: {
          field: 'status',
          op: 'in',
          value: ['active', 'pending'],
        },
      },
      render: { kind: 'geojson' },
    };
    expect(
      lensToWebMapJson(lens, ctx).operationalLayers![0]?.layerDefinition
        ?.definitionExpression,
    ).toBe(`"status" IN ('active', 'pending')`);
  });

  it('emits a viewpoint when the lens has a view', () => {
    const lens: Lens = {
      id: 'lens-view',
      name: 'Around HQ',
      query: { scopes: ['data_layer:abc:lyr'] },
      render: { kind: 'geojson' },
      view: { center: [-122.4, 37.7], zoom: 10 },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(wm.initialState?.viewpoint?.targetGeometry?.spatialReference).toEqual(
      { wkid: 4326 },
    );
    expect(wm.initialState?.viewpoint?.scale).toBeGreaterThan(0);
  });
});

describe('webMapJsonToLens', () => {
  it('round-trips a geojson lens through emit + import', () => {
    const lens: Lens = {
      id: 'lens-rt',
      name: 'Round trip',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: { field: 'name', op: 'eq', value: "O'Brien" },
      },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    const { lens: imported, warnings } = webMapJsonToLens(wm);
    expect(warnings).toEqual([]);
    expect(imported.name).toBe('Round trip');
    expect(imported.render.kind).toBe('geojson');
    expect(imported.query.attrFilter).toEqual({
      field: 'name',
      op: 'eq',
      value: "O'Brien",
    });
    // The stashed sourceUrl is the same portal endpoint the export
    // emitted, so the import service can resolve it back to a
    // data-layer source.
    expect((imported.query as { sourceUrl?: string }).sourceUrl).toBe(
      'https://portal.example.org/api/items/abc/layers/lyr/geojson',
    );
  });

  it('round-trips its own in / contains / startsWith emissions through the definition parser', () => {
    const cases: Array<{
      op: 'in' | 'contains' | 'startsWith';
      value: string | Array<string | number>;
    }> = [
      // IN list including a string with a comma, which a naive
      // comma-split parser would mangle.
      { op: 'in', value: ['active', 'pen,ding', 3] },
      { op: 'contains', value: 'Main, "St"' },
      { op: 'startsWith', value: "O'Br" },
    ];
    for (const c of cases) {
      const lens: Lens = {
        id: `lens-rt-${c.op}`,
        name: 'Round trip op',
        query: {
          scopes: ['data_layer:abc:lyr'],
          attrFilter: { field: 'status', op: c.op, value: c.value },
        },
        render: { kind: 'geojson' },
      };
      const wm = lensToWebMapJson(lens, ctx);
      const { lens: imported, warnings } = webMapJsonToLens(wm);
      expect(warnings).toEqual([]);
      expect(imported.query.attrFilter).toEqual({
        field: 'status',
        op: c.op,
        value: c.value,
      });
    }
  });

  it('round-trips an eq-NULL filter', () => {
    const lens: Lens = {
      id: 'lens-null',
      name: 'Null check',
      query: {
        scopes: ['data_layer:abc:lyr'],
        attrFilter: { field: 'closed_at', op: 'eq', value: null },
      },
      render: { kind: 'geojson' },
    };
    const wm = lensToWebMapJson(lens, ctx);
    expect(
      wm.operationalLayers![0]?.layerDefinition?.definitionExpression,
    ).toBe('"closed_at" = NULL');
    const { lens: imported } = webMapJsonToLens(wm);
    expect(imported.query.attrFilter).toEqual({
      field: 'closed_at',
      op: 'eq',
      value: null,
    });
  });

  it('parses unquoted field identifiers the way real AGO emits them', () => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'l',
          title: 'L',
          url: 'https://example.com/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: {
            definitionExpression: "STATUS = 'Open'",
          },
        },
      ],
    };
    const { lens, warnings } = webMapJsonToLens(wm);
    expect(warnings).toEqual([]);
    expect(lens.query.attrFilter).toEqual({
      field: 'STATUS',
      op: 'eq',
      value: 'Open',
    });
  });

  it.each([
    ["ZONE IN ('R1', 'R2', 'C-1')", { field: 'ZONE', op: 'in', value: ['R1', 'R2', 'C-1'] }],
    ['LEVEL IN (1, 2, 3)', { field: 'LEVEL', op: 'in', value: [1, 2, 3] }],
    ["NAME LIKE '%Main%'", { field: 'NAME', op: 'contains', value: 'Main' }],
    ["NAME LIKE 'Elm%'", { field: 'NAME', op: 'startsWith', value: 'Elm' }],
    ['RETIRED_AT IS NULL', { field: 'RETIRED_AT', op: 'isNull' }],
    ['RETIRED_AT IS NOT NULL', { field: 'RETIRED_AT', op: 'isNotNull' }],
  ])('parses AGO-style expression %s', (expression, expected) => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'l',
          title: 'L',
          url: 'https://example.com/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: { definitionExpression: expression },
        },
      ],
    };
    const { lens, warnings } = webMapJsonToLens(wm);
    expect(warnings).toEqual([]);
    expect(lens.query.attrFilter).toEqual(expected);
  });

  it('rejects a WebMap with no usable operational layer', () => {
    const empty: EsriWebMap = { version: '2.32', operationalLayers: [] };
    expect(() => webMapJsonToLens(empty)).toThrow(
      /no ArcGISFeatureLayer or VectorTileLayer/,
    );
  });

  it('rejects a WebMap missing version', () => {
    const bad = {
      operationalLayers: [
        {
          id: 'l',
          title: 't',
          url: 'u',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    } as unknown as EsriWebMap;
    expect(() => webMapJsonToLens(bad)).toThrow(/missing or empty .version/);
  });

  it('warns and drops the filter for unrecognised definition expressions', () => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'l',
          title: 'L',
          url: 'https://example.com/layer',
          layerType: 'ArcGISFeatureLayer',
          layerDefinition: {
            // Multi-clause; not in the v1 supported subset.
            definitionExpression: '"a" = 1 AND "b" = 2',
          },
        },
      ],
    };
    const { lens, warnings } = webMapJsonToLens(wm);
    expect(lens.query.attrFilter).toBeUndefined();
    expect(warnings.some((w) => /not recognised/.test(w))).toBe(true);
  });

  it('warns about unmodeled top-level WebMap keys instead of silently dropping them', () => {
    const wm = {
      version: '2.32',
      widgets: { timeSlider: {} },
      applicationProperties: { viewing: {} },
      operationalLayers: [
        {
          id: 'l',
          title: 'L',
          url: 'https://example.com/FeatureServer/0',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    } as unknown as EsriWebMap;
    const { warnings } = webMapJsonToLens(wm);
    const dropped = warnings.find((w) => /dropped on import/.test(w));
    expect(dropped).toBeDefined();
    expect(dropped).toContain('widgets');
    expect(dropped).toContain('applicationProperties');
  });

  it('warns when multiple operational layers are present', () => {
    const wm: EsriWebMap = {
      version: '2.32',
      operationalLayers: [
        {
          id: 'a',
          title: 'A',
          url: 'https://example.com/a',
          layerType: 'ArcGISFeatureLayer',
        },
        {
          id: 'b',
          title: 'B',
          url: 'https://example.com/b',
          layerType: 'ArcGISFeatureLayer',
        },
      ],
    };
    const { warnings } = webMapJsonToLens(wm);
    expect(warnings.some((w) => /Only the first/.test(w))).toBe(true);
  });
});

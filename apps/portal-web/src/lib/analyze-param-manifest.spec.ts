// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ANALYZE_PARAM_MANIFESTS,
  getAnalyzeParamManifest,
  isManifestDrivenTool,
  MANIFEST_DRIVEN_TOOL_IDS,
} from './analyze-param-manifest';
import type { DerivedLayerData } from '@gratis-gis/shared-types';

describe('analyze-param-manifest', () => {
  it('registers the first-slice no-param tools', () => {
    expect(MANIFEST_DRIVEN_TOOL_IDS.sort()).toEqual(
      ['bbox', 'centroid', 'convex-hull', 'dissolve', 'vertices'].sort(),
    );
    expect(isManifestDrivenTool('centroid')).toBe(true);
    expect(isManifestDrivenTool('buffer')).toBe(false);
    expect(getAnalyzeParamManifest('buffer')).toBeNull();
  });

  it('builds title-default payloads that keep the pipeline tool id', () => {
    for (const id of MANIFEST_DRIVEN_TOOL_IDS) {
      const m = ANALYZE_PARAM_MANIFESTS[id];
      expect(m).toBeDefined();
      if (!m) continue;
      expect(m.defaultTitle('Parcels')).toMatch(/Parcels/);
      const payload = m.buildPayload({
        title: '',
        sourceLabel: 'Parcels',
        sourceItemId: 'item-1',
        layerKey: 'layer-a',
      });
      expect(payload.type).toBe('derived_layer');
      expect(payload.access).toBe('private');
      expect(payload.title).toMatch(/Parcels/);
      const data = payload.data as DerivedLayerData;
      expect(data.source).toEqual({
        kind: 'data_layer',
        itemId: 'item-1',
        layerKey: 'layer-a',
      });
      expect(data.pipeline).toHaveLength(1);
      expect(data.pipeline[0]?.tool).toBe(id);
      expect(data.pipeline[0]?.params).toEqual({});
      expect(m.helpHref.startsWith('/help/analysis/')).toBe(true);
      expect(m.sqlFn.startsWith('ST_')).toBe(true);
      expect(m.keys.action.startsWith('analyzeWorkbench.')).toBe(true);
    }
  });

  it('honors an explicit title over the default', () => {
    const m = getAnalyzeParamManifest('centroid');
    expect(m).not.toBeNull();
    const payload = m!.buildPayload({
      title: 'My centroids',
      sourceLabel: 'Parcels',
      sourceItemId: 'item-1',
      layerKey: 'layer-a',
    });
    expect(payload.title).toBe('My centroids');
  });
});

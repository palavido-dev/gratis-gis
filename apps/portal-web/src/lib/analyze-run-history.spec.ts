// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  buildRerunDerivedLayerCreatePayload,
  derivedLayerMatchesSource,
  firstPipelineTool,
  labelForPipelineTool,
  pastRunsListUrl,
  pipelineToolToAnalyzeId,
  selectPastRunsForSource,
} from './analyze-run-history';
import type { DerivedLayerData } from '@gratis-gis/shared-types';

function bufferRecipe(
  sourceItemId: string,
  layerKey?: string,
): DerivedLayerData {
  return {
    version: 1,
    source: {
      kind: 'data_layer',
      itemId: sourceItemId,
      ...(layerKey ? { layerKey } : {}),
    },
    pipeline: [
      {
        tool: 'buffer',
        params: { mode: 'fixed', distance: 100, unit: 'meters' },
      },
    ],
    featureLimit: 1000,
    outputSchema: [],
    bbox: [],
  };
}

describe('analyze-run-history', () => {
  it('maps aggregate to group-by and keeps guide tool ids', () => {
    expect(pipelineToolToAnalyzeId('aggregate')).toBe('group-by');
    expect(pipelineToolToAnalyzeId('buffer')).toBe('buffer');
    expect(pipelineToolToAnalyzeId('convex-hull')).toBe('convex-hull');
    expect(pipelineToolToAnalyzeId('filter')).toBeNull();
    expect(pipelineToolToAnalyzeId(null)).toBeNull();
  });

  it('labels pipeline tools for the shelf row', () => {
    expect(labelForPipelineTool('aggregate')).toBe('Group by');
    expect(labelForPipelineTool('buffer')).toBe('Buffer');
    expect(labelForPipelineTool('mystery')).toBe('mystery');
  });

  it('matches source item and optional layerKey', () => {
    const withKey = bufferRecipe('src-1', 'layer-a');
    expect(derivedLayerMatchesSource(withKey, 'src-1', 'layer-a')).toBe(true);
    expect(derivedLayerMatchesSource(withKey, 'src-1', 'layer-b')).toBe(false);
    expect(derivedLayerMatchesSource(withKey, 'other', 'layer-a')).toBe(false);
    const noKey = bufferRecipe('src-1');
    expect(derivedLayerMatchesSource(noKey, 'src-1', 'layer-a')).toBe(true);
  });

  it('selects and sorts past runs by createdAt desc', () => {
    const runs = selectPastRunsForSource(
      [
        {
          id: 'old',
          title: 'Old buffer',
          createdAt: '2026-01-01T00:00:00.000Z',
          data: bufferRecipe('src-1', 'L1'),
        },
        {
          id: 'new',
          title: 'New buffer',
          createdAt: '2026-06-01T00:00:00.000Z',
          data: bufferRecipe('src-1', 'L1'),
        },
        {
          id: 'other',
          title: 'Other source',
          createdAt: '2026-07-01T00:00:00.000Z',
          data: bufferRecipe('src-2', 'L1'),
        },
      ],
      'src-1',
      'L1',
    );
    expect(runs.map((r) => r.id)).toEqual(['new', 'old']);
    expect(firstPipelineTool(runs[0]!.data)).toBe('buffer');
  });

  it('builds a private re-run create body from the recipe', () => {
    const data = bufferRecipe('src-1', 'L1');
    data.outputSchema = [
      { name: 'id', label: 'id', type: 'string', nullable: true },
    ];
    data.bbox = [-1, -1, 1, 1];
    const payload = buildRerunDerivedLayerCreatePayload({
      title: 'Hydrants · 100 m buffer (re-run)',
      data,
    });
    expect(payload.type).toBe('derived_layer');
    expect(payload.access).toBe('private');
    expect(payload.data.source.itemId).toBe('src-1');
    expect(payload.data.pipeline[0]?.tool).toBe('buffer');
    expect(payload.data.outputSchema).toEqual([]);
    expect(payload.data.bbox).toEqual([]);
    // Original must stay untouched (structuredClone).
    expect(data.outputSchema).toHaveLength(1);
  });

  it('builds the mine+full list URL', () => {
    expect(pastRunsListUrl(50)).toBe(
      '/api/portal/items?type=derived_layer&full=1&mine=true&limit=50',
    );
  });
});

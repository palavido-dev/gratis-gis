// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useMemo } from 'react';
import type { ToolStep } from '@gratis-gis/shared-types';
import { useT } from '@/lib/i18n/locale-context';

const TOOL_KINDS: ToolStep['tool'][] = [
  'buffer',
  'dissolve',
  'centroid',
  'convex-hull',
  'bbox',
  'simplify',
  'vertices',
  'densify',
  'top-n',
  'random-sample',
  'nearest-neighbor',
  'fishnet',
  'calculate-geometry',
  'filter',
  'calculate-field',
  'aggregate',
  'spatial-join',
  'spatial-filter',
  'clip',
  'erase',
  'contour',
];

const TOOL_GROUP_IDS = [
  'reshape',
  'extract',
  'combine',
  'measure',
  'filter',
  'generate',
  'interpolate',
  'compare',
] as const;

type ToolGroupId = (typeof TOOL_GROUP_IDS)[number];

const TOOL_GROUP_DEFS: Array<{
  id: ToolGroupId;
  tools: ToolStep['tool'][];
}> = [
  {
    id: 'reshape',
    tools: ['buffer', 'simplify', 'densify', 'convex-hull', 'bbox'],
  },
  {
    id: 'extract',
    tools: ['centroid', 'vertices'],
  },
  { id: 'combine', tools: ['dissolve'] },
  {
    id: 'measure',
    tools: ['calculate-geometry', 'nearest-neighbor'],
  },
  { id: 'filter', tools: ['top-n', 'random-sample'] },
  { id: 'generate', tools: ['fishnet'] },
  { id: 'interpolate', tools: ['contour'] },
  {
    id: 'compare',
    tools: ['spatial-join', 'spatial-filter', 'clip', 'erase'],
  },
];

const NO_PARAM_TOOLS = [
  'dissolve',
  'centroid',
  'convex-hull',
  'bbox',
  'vertices',
  'nearest-neighbor',
] as const;

export interface DerivedLayerToolGroup {
  label: string;
  description: string;
  tools: ToolStep['tool'][];
}

export function useDerivedLayerCatalog() {
  const t = useT();

  return useMemo(() => {
    const toolLabels = {} as Record<ToolStep['tool'], string>;
    const toolDescriptions = {} as Record<ToolStep['tool'], string>;
    for (const kind of TOOL_KINDS) {
      toolLabels[kind] = t(`derivedLayerBuilder.tools.${kind}.label`);
      toolDescriptions[kind] = t(`derivedLayerBuilder.tools.${kind}.desc`);
    }

    const toolGroups: DerivedLayerToolGroup[] = TOOL_GROUP_DEFS.map((g) => ({
      label: t(`derivedLayerBuilder.toolGroups.${g.id}.label`),
      description: t(`derivedLayerBuilder.toolGroups.${g.id}.desc`),
      tools: g.tools,
    }));

    const noParamBodies: Record<(typeof NO_PARAM_TOOLS)[number], string> = {
      dissolve: t('derivedLayerBuilder.noParam.dissolve'),
      centroid: t('derivedLayerBuilder.noParam.centroid'),
      'convex-hull': t('derivedLayerBuilder.noParam.convex-hull'),
      bbox: t('derivedLayerBuilder.noParam.bbox'),
      vertices: t('derivedLayerBuilder.noParam.vertices'),
      'nearest-neighbor': t('derivedLayerBuilder.noParam.nearest-neighbor'),
    };

    return {
      t,
      toolLabels,
      toolDescriptions,
      toolGroups,
      noParamBodies,
    };
  }, [t]);
}

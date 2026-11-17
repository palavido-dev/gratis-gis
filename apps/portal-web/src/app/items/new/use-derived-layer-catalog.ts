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

const TOOL_GROUP_DEFS = [
  {
    id: 'reshape',
    tools: ['buffer', 'simplify', 'densify', 'convex-hull', 'bbox'],
  },
  {
    id: 'extract',
    tools: ['centroid', 'vertices'],
  },
  { id: 'combine', tools: ['dissolve', 'aggregate'] },
  {
    id: 'measure',
    tools: ['calculate-geometry', 'calculate-field', 'nearest-neighbor'],
  },
  { id: 'filter', tools: ['filter', 'top-n', 'random-sample'] },
  { id: 'generate', tools: ['fishnet'] },
  { id: 'interpolate', tools: ['contour'] },
  {
    id: 'compare',
    tools: ['spatial-join', 'spatial-filter', 'clip', 'erase'],
  },
] as const satisfies ReadonlyArray<{
  id: ToolGroupId;
  tools: ReadonlyArray<ToolStep['tool']>;
}>;

// The toolbox is the only way to add a step in the builder, so a tool
// in no group cannot be added at all (filter, calculate-field and
// aggregate were missing for a while). This fails to compile when a
// tool is left out.
type GroupedTool = (typeof TOOL_GROUP_DEFS)[number]['tools'][number];
type AssertEveryToolGrouped<T extends never> = T;
export type EveryToolGrouped = AssertEveryToolGrouped<
  Exclude<ToolStep['tool'], GroupedTool>
>;

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
      tools: [...g.tools],
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

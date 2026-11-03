// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parameter manifests for Analyze guided tools
 * (analyze-param-manifests).
 *
 * One dialog shell reads these entries instead of a bespoke panel
 * per no-param guide. First slice: title-only tools that already
 * POST a single-step `derived_layer` via existing *-derived helpers.
 * Field pickers / distance params stay on their guide components
 * until a later migration.
 */
import type { AnalyzeToolId } from './analyze-tool-ids';
import {
  buildBboxDerivedLayerCreatePayload,
  defaultBboxDerivedLayerTitle,
} from './analyze-bbox-derived';
import {
  buildCentroidDerivedLayerCreatePayload,
  defaultCentroidDerivedLayerTitle,
} from './analyze-centroid-derived';
import {
  buildConvexHullDerivedLayerCreatePayload,
  defaultConvexHullDerivedLayerTitle,
} from './analyze-convex-hull-derived';
import {
  buildDissolveDerivedLayerCreatePayload,
  defaultDissolveDerivedLayerTitle,
} from './analyze-dissolve-derived';
import {
  buildVerticesDerivedLayerCreatePayload,
  defaultVerticesDerivedLayerTitle,
} from './analyze-vertices-derived';

/** Create-item body shape shared by the no-param derived helpers. */
export interface AnalyzeManifestCreatePayload {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: unknown;
}

export type AnalyzeManifestIcon =
  | 'crosshair'
  | 'square'
  | 'circle-dot'
  | 'hexagon'
  | 'layers-2';

/**
 * i18n keys under `analyzeWorkbench.*` for chip + expanded form
 * copy. Kept as full dotted keys so the shell can call `t(key)`.
 */
export interface AnalyzeManifestCopyKeys {
  action: string;
  actionTitle: string;
  heading: string;
  introBefore: string;
  introAfter: string;
  helpLink: string;
  introTail: string;
  hint: string;
}

export interface AnalyzeParamManifest {
  id: AnalyzeToolId;
  icon: AnalyzeManifestIcon;
  /** PostGIS function shown in the intro (honesty). */
  sqlFn: string;
  helpHref: string;
  keys: AnalyzeManifestCopyKeys;
  defaultTitle: (sourceLabel: string) => string;
  buildPayload: (args: {
    title: string;
    sourceLabel: string;
    sourceItemId: string;
    layerKey: string;
  }) => AnalyzeManifestCreatePayload;
}

function copyKeys(prefix: string): AnalyzeManifestCopyKeys {
  return {
    action: `analyzeWorkbench.${prefix}Action`,
    actionTitle: `analyzeWorkbench.${prefix}ActionTitle`,
    heading: `analyzeWorkbench.${prefix}Heading`,
    introBefore: `analyzeWorkbench.${prefix}IntroBefore`,
    introAfter: `analyzeWorkbench.${prefix}IntroAfter`,
    helpLink: `analyzeWorkbench.${prefix}HelpLink`,
    introTail: `analyzeWorkbench.${prefix}IntroTail`,
    hint: `analyzeWorkbench.${prefix}Hint`,
  };
}

/**
 * Tools driven by the shared AnalyzeManifestGuide shell.
 * Buffer / Clip / Erase and param-heavy guides stay bespoke for now.
 */
export const ANALYZE_PARAM_MANIFESTS: Partial<
  Record<AnalyzeToolId, AnalyzeParamManifest>
> = {
  centroid: {
    id: 'centroid',
    icon: 'crosshair',
    sqlFn: 'ST_Centroid',
    helpHref: '/help/analysis/centroid',
    keys: copyKeys('centroid'),
    defaultTitle: defaultCentroidDerivedLayerTitle,
    buildPayload: buildCentroidDerivedLayerCreatePayload,
  },
  'convex-hull': {
    id: 'convex-hull',
    icon: 'hexagon',
    sqlFn: 'ST_ConvexHull',
    helpHref: '/help/analysis/convex-hull',
    keys: copyKeys('convexHull'),
    defaultTitle: defaultConvexHullDerivedLayerTitle,
    buildPayload: buildConvexHullDerivedLayerCreatePayload,
  },
  bbox: {
    id: 'bbox',
    icon: 'square',
    sqlFn: 'ST_Envelope',
    helpHref: '/help/analysis/bbox',
    keys: copyKeys('bbox'),
    defaultTitle: defaultBboxDerivedLayerTitle,
    buildPayload: buildBboxDerivedLayerCreatePayload,
  },
  dissolve: {
    id: 'dissolve',
    icon: 'layers-2',
    sqlFn: 'ST_Union',
    helpHref: '/help/analysis/dissolve',
    keys: copyKeys('dissolve'),
    defaultTitle: defaultDissolveDerivedLayerTitle,
    buildPayload: buildDissolveDerivedLayerCreatePayload,
  },
  vertices: {
    id: 'vertices',
    icon: 'circle-dot',
    sqlFn: 'ST_DumpPoints',
    helpHref: '/help/analysis/vertices',
    keys: copyKeys('vertices'),
    defaultTitle: defaultVerticesDerivedLayerTitle,
    buildPayload: buildVerticesDerivedLayerCreatePayload,
  },
};

export const MANIFEST_DRIVEN_TOOL_IDS: AnalyzeToolId[] = (
  Object.keys(ANALYZE_PARAM_MANIFESTS) as AnalyzeToolId[]
).filter((id) => ANALYZE_PARAM_MANIFESTS[id] != null);

export function getAnalyzeParamManifest(
  id: AnalyzeToolId,
): AnalyzeParamManifest | null {
  return ANALYZE_PARAM_MANIFESTS[id] ?? null;
}

export function isManifestDrivenTool(id: AnalyzeToolId): boolean {
  return id in ANALYZE_PARAM_MANIFESTS;
}

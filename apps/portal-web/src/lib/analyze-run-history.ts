// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Past runs shelf helpers for the Analyze workbench
 * (analyze-run-history).
 *
 * Lists the caller's derived_layer items whose recipe source points
 * at the open data_layer, and builds Re-run / Edit & re-run actions
 * without a job ledger or param-manifest dialog.
 */
import {
  isDerivedLayerData,
  type DerivedLayerData,
  type ToolStep,
} from '@gratis-gis/shared-types';
import {
  ANALYZE_TOOL_IDS,
  type AnalyzeToolId,
} from '@/lib/analyze-tool-ids';

/** Slim list row after client-side source filter. */
export interface AnalyzePastRun {
  id: string;
  title: string;
  createdAt: string;
  /** First pipeline step tool id (raw recipe tool, e.g. aggregate). */
  firstTool: ToolStep['tool'] | string;
  data: DerivedLayerData;
}

/** Wire shape from `GET /api/portal/items?type=derived_layer&full=1`. */
export interface DerivedLayerListItem {
  id: string;
  title?: string | null;
  createdAt?: string | null;
  type?: string;
  data?: unknown;
}

const ANALYZE_ID_SET = new Set<string>(ANALYZE_TOOL_IDS);

/**
 * Map a derived-layer pipeline tool to an Analyze guide id.
 * Group-by shortcuts persist as `aggregate`; everything else that
 * has a guide shares the same string as the recipe tool.
 */
export function pipelineToolToAnalyzeId(
  tool: string | null | undefined,
): AnalyzeToolId | null {
  if (!tool) return null;
  const raw = tool.trim().toLowerCase();
  if (raw === 'aggregate') return 'group-by';
  return ANALYZE_ID_SET.has(raw) ? (raw as AnalyzeToolId) : null;
}

/** Short English label for the first pipeline tool (shelf row). */
export function labelForPipelineTool(tool: string): string {
  switch (tool) {
    case 'buffer':
      return 'Buffer';
    case 'dissolve':
      return 'Dissolve';
    case 'centroid':
      return 'Centroid';
    case 'convex-hull':
      return 'Convex hull';
    case 'bbox':
      return 'Bounding box';
    case 'simplify':
      return 'Simplify';
    case 'vertices':
      return 'Vertices';
    case 'densify':
      return 'Densify';
    case 'top-n':
      return 'Top N';
    case 'random-sample':
      return 'Random sample';
    case 'nearest-neighbor':
      return 'Nearest neighbor';
    case 'fishnet':
      return 'Fishnet';
    case 'calculate-geometry':
      return 'Calculate geometry';
    case 'clip':
      return 'Clip';
    case 'erase':
      return 'Erase';
    case 'contour':
      return 'Contour';
    case 'aggregate':
      return 'Group by';
    case 'filter':
      return 'Filter';
    case 'calculate-field':
      return 'Calculate field';
    case 'spatial-join':
      return 'Spatial join';
    case 'spatial-filter':
      return 'Spatial filter';
    default:
      return tool;
  }
}

/**
 * True when the derived recipe reads this data_layer (and optional
 * sublayer). Missing layerKey matches any sublayer of that item so
 * single-layer recipes still show on every row.
 */
export function derivedLayerMatchesSource(
  data: unknown,
  sourceItemId: string,
  layerKey?: string | null,
): data is DerivedLayerData {
  if (!isDerivedLayerData(data)) return false;
  if (data.source.kind !== 'data_layer') return false;
  if (data.source.itemId !== sourceItemId) return false;
  if (layerKey && data.source.layerKey && data.source.layerKey !== layerKey) {
    return false;
  }
  return true;
}

/** First pipeline tool, or null when the recipe has no steps. */
export function firstPipelineTool(
  data: DerivedLayerData,
): ToolStep['tool'] | null {
  const step = data.pipeline[0];
  return step?.tool ?? null;
}

/**
 * Filter a full derived_layer list down to runs for one source
 * layer, newest createdAt first.
 */
export function selectPastRunsForSource(
  items: DerivedLayerListItem[],
  sourceItemId: string,
  layerKey?: string | null,
): AnalyzePastRun[] {
  const runs: AnalyzePastRun[] = [];
  for (const item of items) {
    if (!derivedLayerMatchesSource(item.data, sourceItemId, layerKey)) {
      continue;
    }
    const firstTool = firstPipelineTool(item.data);
    if (!firstTool) continue;
    runs.push({
      id: item.id,
      title: (item.title ?? '').trim() || 'Derived layer',
      createdAt: item.createdAt ?? '',
      firstTool,
      data: item.data,
    });
  }
  runs.sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  return runs;
}

/** Body for `POST /api/portal/items` that duplicates a past run. */
export function buildRerunDerivedLayerCreatePayload(args: {
  title: string;
  /** Optional; falls back to a short re-run note. */
  description?: string;
  data: DerivedLayerData;
}): {
  type: 'derived_layer';
  title: string;
  description: string;
  tags: string[];
  access: 'private';
  data: DerivedLayerData;
} {
  const title = args.title.trim() || 'Derived layer';
  // Fresh private copy of the same recipe; server re-enriches
  // schema / bbox on create the same way Analyze guides do.
  const cloned = structuredClone(args.data) as DerivedLayerData;
  const data: DerivedLayerData = {
    version: 1,
    source: cloned.source,
    pipeline: cloned.pipeline,
    featureLimit: cloned.featureLimit,
    outputSchema: [],
    bbox: [],
  };
  return {
    type: 'derived_layer',
    title,
    description:
      args.description?.trim() ||
      `Re-run of a derived-layer recipe from the Analyze Past runs shelf.`,
    tags: [],
    access: 'private',
    data,
  };
}

/** List URL for the caller's recent derived layers (full payloads). */
export function pastRunsListUrl(limit = 50): string {
  const params = new URLSearchParams({
    type: 'derived_layer',
    full: '1',
    mine: 'true',
    limit: String(Math.max(1, Math.min(limit, 100))),
  });
  return `/api/portal/items?${params.toString()}`;
}

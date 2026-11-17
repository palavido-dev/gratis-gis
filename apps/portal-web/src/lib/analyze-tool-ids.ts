// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stable Analyze guide ids for deep links
 * (`/items/<id>?tool=<id>&layer=<key>#data`).
 *
 * Kept as a string union so help, MCP, and the layer panel kebab can
 * share one vocabulary without importing React guide components.
 * See docs/research/analyze-workflow-ux-2026-10-30.md.
 */

export const ANALYZE_TOOL_IDS = [
  'buffer',
  'clip',
  'erase',
  'centroid',
  'convex-hull',
  'bbox',
  'dissolve',
  'simplify',
  'densify',
  'vertices',
  'calculate-geometry',
  'nearest-neighbor',
  'fishnet',
  'contour',
  'group-by',
  'top-n',
  'random-sample',
] as const;

export type AnalyzeToolId = (typeof ANALYZE_TOOL_IDS)[number];

const TOOL_SET = new Set<string>(ANALYZE_TOOL_IDS);

export function parseAnalyzeToolId(
  raw: string | null | undefined,
): AnalyzeToolId | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase();
  return TOOL_SET.has(id) ? (id as AnalyzeToolId) : null;
}

/**
 * Shareable URL that opens a data_layer item on the Data tab with
 * the given Analyze guide expanded.
 */
export function analyzeToolDeepLink(
  itemId: string,
  tool: AnalyzeToolId,
  layerKey?: string | null,
): string {
  const params = new URLSearchParams();
  params.set('tool', tool);
  if (layerKey) params.set('layer', layerKey);
  return `/items/${encodeURIComponent(itemId)}?${params.toString()}#data`;
}

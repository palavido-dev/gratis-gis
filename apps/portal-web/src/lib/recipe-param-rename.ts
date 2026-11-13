// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecipeAction } from '@gratis-gis/shared-types';

import { commitChain, syncSteps } from './workflow-canvas';

/** Replace `{ kind: 'parameter', name: from }` anywhere under `v`. */
function renameDeep(v: unknown, from: string, to: string): unknown {
  if (Array.isArray(v)) return v.map((x) => renameDeep(x, from, to));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (o.kind === 'parameter' && o.name === from) return { ...o, name: to };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = renameDeep(x, from, to);
  return out;
}

/**
 * Point every reference to parameter `from` at `to` instead: the
 * output's target, the source and AOI refs, and parameter refs inside
 * pipeline steps (and the workflow graph that mirrors them). With
 * `to` empty the references are cleared, which is what removing the
 * parameter needs. Without this a rename left the selects showing
 * "(pick a parameter)" while the old name was what got saved.
 */
export function renameRecipeParameter(
  recipe: RecipeAction,
  from: string,
  to: string,
): RecipeAction {
  if (from === to || from === '') return recipe;
  const next: RecipeAction = {
    ...recipe,
    pipeline: renameDeep(recipe.pipeline, from, to) as RecipeAction['pipeline'],
  };
  const out = recipe.output as { targetParameterRef?: string };
  if (out.targetParameterRef === from) {
    next.output = { ...recipe.output, targetParameterRef: to } as RecipeAction['output'];
  }
  if (recipe.sourceParameterRef === from) {
    if (to) next.sourceParameterRef = to;
    else delete next.sourceParameterRef;
  }
  if (recipe.aoiParameterRef === from) {
    if (to) next.aoiParameterRef = to;
    else delete next.aoiParameterRef;
  }
  if (!recipe.graph) return next;
  const graph = syncSteps(recipe.graph, next.pipeline);
  return commitChain(next, graph) ?? { ...next, graph };
}

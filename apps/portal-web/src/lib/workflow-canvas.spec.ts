// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecipeAction, ToolStep } from '@gratis-gis/shared-types';
import {
  appendStep,
  chainOrder,
  commitChain,
  layoutChain,
  placeAfter,
  removeNode,
  syncSteps,
} from './workflow-canvas';

const filter = (expression: string): ToolStep => ({
  tool: 'filter',
  params: { expression },
});

function recipe(pipeline: ToolStep[]): RecipeAction {
  return {
    kind: 'recipe',
    recipeVersion: 1,
    parameters: [],
    pipeline,
    output: { kind: 'selection', targetParameterRef: '' },
  };
}

describe('workflow canvas chain', () => {
  it('lays a pipeline out as one chain', () => {
    const graph = layoutChain([filter('a > 1'), filter('b > 2')]);
    expect(chainOrder(graph)).toEqual(['n0', 'n1']);
    expect(graph.edges).toEqual([{ source: 'n0', target: 'n1' }]);
    expect(graph.nodes[1]?.position?.y).toBeGreaterThan(graph.nodes[0]?.position?.y ?? 0);
  });

  it('refuses a branch', () => {
    const graph = layoutChain([filter('a'), filter('b'), filter('c')]);
    graph.edges.push({ source: 'n0', target: 'n2' });
    expect(chainOrder(graph)).toBeNull();
  });

  it('moves a node and keeps the pipeline in that order', () => {
    const graph = layoutChain([filter('a'), filter('b'), filter('c')]);
    const moved = placeAfter(graph, 'n2', null);
    expect(moved).not.toBeNull();
    expect(chainOrder(moved!)).toEqual(['n2', 'n0', 'n1']);
    const committed = commitChain(recipe(graph.nodes.map((node) => node.step)), moved!);
    expect(committed?.pipeline.map((step) => step.tool === 'filter' && step.params.expression)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('splices a removed node out of the chain', () => {
    const graph = layoutChain([filter('a'), filter('b'), filter('c')]);
    const next = removeNode(graph, 'n1');
    expect(chainOrder(next!)).toEqual(['n0', 'n2']);
    expect(next?.edges).toEqual([{ source: 'n0', target: 'n2' }]);
  });

  it('appends a step after the last node', () => {
    const graph = layoutChain([filter('a')]);
    const next = appendStep(graph, filter('b'));
    expect(chainOrder(next!)).toEqual(['n0', 'n1']);
  });

  it('copies a step edit onto the matching node', () => {
    const graph = layoutChain([filter('a'), filter('b')]);
    const synced = syncSteps(graph, [filter('a2'), filter('b2')]);
    expect(synced.nodes.map((node) => node.position)).toEqual(
      graph.nodes.map((node) => node.position),
    );
    expect(synced.nodes.map((node) => node.step.tool === 'filter' && node.step.params.expression)).toEqual([
      'a2',
      'b2',
    ]);
  });
});

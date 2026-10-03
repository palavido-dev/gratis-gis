// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  pipelineToGraph,
  topologicalSort,
  type RecipeAction,
  type ToolStep,
  type WorkflowGraph,
  type WorkflowNode,
} from '@gratis-gis/shared-types';

/**
 * The recipe runner still executes one sequence. The canvas keeps
 * the graph as a single chain so the arrows and that sequence are
 * the same thing. A branch would sort into a line and then run as
 * a line, which would not match the drawing.
 */

export function chainOrder(graph: WorkflowGraph): string[] | null {
  const sorted = topologicalSort(graph);
  if (!sorted.order) return null;
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const node of graph.nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, 0);
  }
  for (const edge of graph.edges) {
    if (edge.source === edge.target) return null;
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) return null;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  for (const node of graph.nodes) {
    if ((incoming.get(node.id) ?? 0) > 1) return null;
    if ((outgoing.get(node.id) ?? 0) > 1) return null;
  }
  if (graph.edges.length !== Math.max(0, graph.nodes.length - 1)) return null;
  return sorted.order;
}

export function layoutChain(
  pipeline: ToolStep[],
  positions?: Array<{ x: number; y: number } | undefined>,
): WorkflowGraph {
  const graph = pipelineToGraph(pipeline);
  return {
    ...graph,
    nodes: graph.nodes.map((node, index) => ({
      ...node,
      position: positions?.[index] ?? { x: 48, y: 24 + index * 148 },
    })),
  };
}

export function commitChain(
  recipe: RecipeAction,
  graph: WorkflowGraph,
): RecipeAction | null {
  const order = chainOrder(graph);
  if (!order) return null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const pipeline: ToolStep[] = [];
  for (const id of order) {
    const node = byId.get(id);
    if (!node) return null;
    pipeline.push(node.step);
  }
  return { ...recipe, graph, pipeline };
}

export function openOnCanvas(recipe: RecipeAction): RecipeAction {
  if (recipe.graph && chainOrder(recipe.graph)) return recipe;
  const flattened = recipe.graph ? flattenToChain(recipe.graph) : null;
  const graph = flattened ?? layoutChain(recipe.pipeline);
  return commitChain(recipe, graph) ?? { ...recipe, graph, pipeline: recipe.pipeline };
}

export function flattenToChain(graph: WorkflowGraph): WorkflowGraph | null {
  const sorted = topologicalSort(graph);
  if (!sorted.order) return null;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps: ToolStep[] = [];
  const positions: Array<{ x: number; y: number } | undefined> = [];
  for (const id of sorted.order) {
    const node = byId.get(id);
    if (!node) return null;
    steps.push(node.step);
    positions.push(node.position);
  }
  return layoutChain(steps, positions);
}

export function placeAfter(
  graph: WorkflowGraph,
  nodeId: string,
  afterId: string | null,
): WorkflowGraph | null {
  const order = chainOrder(graph);
  if (!order || !order.includes(nodeId)) return null;
  const rest = order.filter((id) => id !== nodeId);
  let next: string[];
  if (afterId === null) {
    next = [nodeId, ...rest];
  } else {
    const index = rest.indexOf(afterId);
    if (index < 0) return null;
    next = [...rest.slice(0, index + 1), nodeId, ...rest.slice(index + 1)];
  }
  return chainFromOrder(graph, next);
}

export function appendStep(graph: WorkflowGraph, step: ToolStep): WorkflowGraph | null {
  const order = chainOrder(graph);
  if (!order) return null;
  const id = nextId(graph);
  const lastId = order[order.length - 1];
  const last = lastId ? graph.nodes.find((node) => node.id === lastId) : undefined;
  const node: WorkflowNode = {
    id,
    step,
    position: {
      x: 48,
      y: last?.position ? last.position.y + 148 : 24,
    },
  };
  const edges = lastId
    ? [...graph.edges, { source: lastId, target: id }]
    : [];
  return {
    nodes: [...graph.nodes, node],
    edges,
    graphVersion: 1,
  };
}

export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph | null {
  const order = chainOrder(graph);
  if (!order || !order.includes(nodeId)) return null;
  return chainFromOrder(
    graph,
    order.filter((id) => id !== nodeId),
  );
}

export function moveNode(
  graph: WorkflowGraph,
  id: string,
  position: { x: number; y: number },
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? { ...node, position } : node)),
  };
}

export function replaceStep(
  graph: WorkflowGraph,
  id: string,
  step: ToolStep,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === id ? { ...node, step } : node)),
  };
}

export function syncSteps(graph: WorkflowGraph, pipeline: ToolStep[]): WorkflowGraph {
  const order = chainOrder(graph);
  if (order && order.length === pipeline.length) {
    const steps = new Map(order.map((id, index) => [id, pipeline[index]!]));
    return {
      ...graph,
      nodes: graph.nodes.map((node) => {
        const step = steps.get(node.id);
        return step ? { ...node, step } : node;
      }),
    };
  }
  const positions = order
    ? order.map((id) => graph.nodes.find((node) => node.id === id)?.position)
    : undefined;
  return layoutChain(pipeline, positions);
}

function chainFromOrder(graph: WorkflowGraph, order: string[]): WorkflowGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes = order.map((id) => byId.get(id)!).filter((node) => node !== undefined);
  const edges = nodes.slice(0, -1).map((node, index) => ({
    source: node.id,
    target: nodes[index + 1]!.id,
  }));
  return { nodes, edges, graphVersion: 1 };
}

function nextId(graph: WorkflowGraph): string {
  const used = new Set(graph.nodes.map((node) => node.id));
  let n = graph.nodes.length;
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
}

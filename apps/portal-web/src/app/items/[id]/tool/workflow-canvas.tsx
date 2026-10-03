// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { RecipeAction, ToolStep, WorkflowGraph } from '@gratis-gis/shared-types';
import { DEFAULT_FILTER_STEP } from '@gratis-gis/shared-types';
import {
  appendStep,
  chainOrder,
  commitChain,
  moveNode,
  openOnCanvas,
  placeAfter,
  removeNode,
  replaceStep,
} from '@/lib/workflow-canvas';

const NODE_W = 220;
const NODE_H = 112;

/**
 * Arranges a recipe as a single chain. Dragging changes where a
 * box sits. "Runs after" changes the order the runner uses. A
 * branch is not offered: the runner still executes one sequence,
 * and the arrows on this canvas are that sequence.
 */
export function WorkflowCanvas({
  recipe,
  canEdit,
  onChange,
}: {
  recipe: RecipeAction;
  canEdit: boolean;
  onChange: (next: RecipeAction) => void;
}) {
  const graph = recipe.graph;
  const order = graph ? chainOrder(graph) : null;

  if (!graph) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink-0">Canvas</h3>
        <p className="text-2xs text-muted">
          Lay the pipeline out as connected steps. The order of the
          boxes is the order the recipe runs.
        </p>
        {canEdit ? (
          <button
            type="button"
            onClick={() => onChange(openOnCanvas(recipe))}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-0 hover:bg-surface-2"
          >
            Open on canvas
          </button>
        ) : (
          <p className="text-2xs text-muted">This recipe has no canvas yet.</p>
        )}
      </section>
    );
  }

  if (!order) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-ink-0">Canvas</h3>
        <p className="text-2xs text-muted">
          This graph is not a single chain. The runner would flatten
          it into one sequence, so the canvas will not draw branches.
        </p>
        {canEdit ? (
          <button
            type="button"
            onClick={() => onChange(openOnCanvas(recipe))}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-ink-0 hover:bg-surface-2"
          >
            Arrange as a chain
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <CanvasBody
      recipe={recipe}
      graph={graph}
      order={order}
      canEdit={canEdit}
      onChange={onChange}
    />
  );
}

function CanvasBody({
  recipe,
  graph,
  order,
  canEdit,
  onChange,
}: {
  recipe: RecipeAction;
  graph: WorkflowGraph;
  order: string[];
  canEdit: boolean;
  onChange: (next: RecipeAction) => void;
}) {
  const [live, setLive] = useState<Record<string, { x: number; y: number }>>({});

  function commit(next: WorkflowGraph | null) {
    if (!next) return;
    const updated = commitChain(recipe, next);
    if (updated) onChange(updated);
  }

  function positionOf(id: string, index: number): { x: number; y: number } {
    if (live[id]) return live[id];
    const node = graph.nodes.find((item) => item.id === id);
    return node?.position ?? { x: 48, y: 24 + index * 148 };
  }

  function onPointerDown(event: ReactPointerEvent, id: string, index: number) {
    if (!canEdit) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, select, input, textarea')) return;
    event.preventDefault();
    const origin = positionOf(id, index);
    const startX = event.clientX;
    const startY = event.clientY;
    function move(ev: PointerEvent) {
      setLive((prev) => ({
        ...prev,
        [id]: {
          x: Math.max(8, Math.round(origin.x + ev.clientX - startX)),
          y: Math.max(8, Math.round(origin.y + ev.clientY - startY)),
        },
      }));
    }
    function up(ev: PointerEvent) {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const position = {
        x: Math.max(8, Math.round(origin.x + ev.clientX - startX)),
        y: Math.max(8, Math.round(origin.y + ev.clientY - startY)),
      };
      setLive({});
      commit(moveNode(graph, id, position));
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const boxes = order.map((id, index) => ({ id, index, ...positionOf(id, index) }));
  const width = Math.max(560, ...boxes.map((box) => box.x + NODE_W + 32));
  const height = Math.max(180, ...boxes.map((box) => box.y + NODE_H + 32));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-ink-0">Canvas</h3>
          <p className="text-2xs text-muted">
            Drag a step to place it. Runs after changes the sequence
            the recipe executes.
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => commit(appendStep(graph, DEFAULT_FILTER_STEP))}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-ink-0 hover:bg-surface-2"
          >
            <Plus className="h-3 w-3" />
            Add filter
          </button>
        ) : null}
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-md border border-border bg-surface-2">
        <div className="relative" style={{ width, height }}>
          <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
            {graph.edges.map((edge) => {
              const source = boxes.find((box) => box.id === edge.source);
              const target = boxes.find((box) => box.id === edge.target);
              if (!source || !target) return null;
              return (
                <line
                  key={`${edge.source}-${edge.target}`}
                  x1={source.x + NODE_W / 2}
                  y1={source.y + NODE_H}
                  x2={target.x + NODE_W / 2}
                  y2={target.y}
                  stroke="currentColor"
                  className="text-muted"
                  strokeWidth={1.5}
                />
              );
            })}
          </svg>
          {boxes.map((box) => {
            const node = byId.get(box.id);
            if (!node) return null;
            const afterId = graph.edges.find((edge) => edge.target === box.id)?.source ?? '';
            return (
              <div
                key={box.id}
                className="absolute rounded-md border border-border bg-surface-0 p-2 shadow-card"
                style={{ left: box.x, top: box.y, width: NODE_W, height: NODE_H }}
                onPointerDown={(event) => onPointerDown(event, box.id, box.index)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="cursor-grab font-mono text-2xs uppercase tracking-wide text-muted">
                    {node.step.tool}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      title="Remove step"
                      onClick={() => commit(removeNode(graph, box.id))}
                      className="rounded border border-border p-0.5 text-danger hover:bg-danger/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
                {node.step.tool === 'filter' ? (
                  <input
                    type="text"
                    disabled={!canEdit}
                    value={node.step.params.expression}
                    placeholder="acres > 5"
                    onChange={(event) => {
                      const step: ToolStep = {
                        tool: 'filter',
                        params: { expression: event.target.value },
                      };
                      commit(replaceStep(graph, box.id, step));
                    }}
                    className="mt-1 w-full rounded border border-border bg-surface-0 px-1.5 py-1 font-mono text-2xs text-ink-0"
                  />
                ) : (
                  <p className="mt-1 truncate text-2xs text-ink-1">{stepSummary(node.step)}</p>
                )}
                <label className="mt-1 flex items-center gap-1 text-2xs text-muted">
                  Runs after
                  <select
                    disabled={!canEdit}
                    value={afterId}
                    onChange={(event) => {
                      const value = event.target.value;
                      commit(placeAfter(graph, box.id, value ? value : null));
                    }}
                    className="max-w-[8rem] rounded border border-border bg-surface-0 px-1 py-0.5 text-2xs text-ink-0"
                  >
                    <option value="">Start</option>
                    {order
                      .filter((id) => id !== box.id)
                      .map((id) => (
                        <option key={id} value={id}>
                          {order.indexOf(id) + 1}. {byId.get(id)?.step.tool ?? id}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function stepSummary(step: ToolStep): string {
  if (step.tool === 'filter') return step.params.expression || 'Filter';
  if (step.tool === 'buffer') return 'Buffer';
  return step.tool;
}

---
id: analysis-workflows
title: Workflows (graphs of analysis steps)
summary: Arrange an analysis recipe as a chain of steps. The canvas saves positions and order. Branching execution is not available.
category: analysis
order: 5
complexity: intermediate
tags:
  - workflows
  - tools
  - recipe
  - dag
related:
  - items-tool
---

Tools in GratisGIS can run an analysis pipeline behind a single
button click. The recipe editor shows that pipeline as a list
and, when you open it on the canvas, as boxes in one chain.

Dragging a box changes where it sits. **Runs after** changes
which step comes next. The arrows and the list stay in the
same order, and that order is what runs. A branch is not
drawn: the runner still executes one sequence, so a fork
would not do what the drawing suggested. Joins and unions
are not steps on this canvas.

## What "graph" means here

If you're new to the term: imagine each analysis step as a box
on a whiteboard, and arrows between boxes showing where the
output of one box flows into the next box. The whole drawing is
a workflow graph.

The graph rule we enforce is that those arrows never form a
loop — you can't have an arrow that eventually comes back to a
box you already passed through. (In computer-science terms,
this is a "directed acyclic graph," or DAG.) The reason is
practical: a loop would let the engine run forever.

## What ships in Phase 1

The engine now reads a workflow as either:

- a **linear pipeline** (the existing shape every tool today
  uses), or
- a **graph** (a list of nodes plus a list of edges connecting
  them).

When a tool carries a graph, the engine sorts the nodes into
the right execution order, checks for loops, and runs them. If
a loop is detected, the tool refuses to run with a clear error
("This workflow has a cycle"); the author fixes the graph and
tries again.

Existing tools continue to work unchanged. Every tool you
authored before this lands keeps running as a linear pipeline.

## What the canvas does

Open a recipe and choose **Open on canvas**. Each step is a
box. Filter steps can be edited on the box. **Add filter**
appends one. Removing a box splices the chain back together.
The list under the canvas is the same sequence.

Positions are saved with the recipe. They do not change the
result. Only the order does.

## What a chain is good for

Stacked questions fit this canvas. "Parcels within 200 meters
of a school, owned by the city, and not zoned residential" is
three filters in order. Put them on the canvas in that order.

A union of two searches, where one layer feeds two steps that
later meet, is not what this canvas runs. The runner has one
sequence.

## For tool authors

Recipes saved before the canvas still run as a list. Open
them on the canvas when you want to rearrange the chain.
The list remains, and editing a step there updates the box.

## Related

- [Tool item](items-tool) for the tool item type itself.

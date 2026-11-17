// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContainerWidgetConfig, CustomWidget } from '@gratis-gis/shared-types';
import {
  allWidgetsDeep,
  containerFlowsInRow,
  defaultFollowMap,
  insertionIndex,
  moveWidgetInTree,
  pastDragThreshold,
} from './custom-app-tree';

const L = { col: 1, row: 1, colSpan: 1, rowSpan: 1 };

function tool(id: string): CustomWidget {
  return { id, kind: 'legend', layout: L, config: { kind: 'legend' } } as unknown as CustomWidget;
}

function dock(id: string, children: CustomWidget[]): CustomWidget {
  return {
    id,
    kind: 'container',
    layout: L,
    config: { kind: 'container', position: 'dock-left', widgets: children },
  } as CustomWidget;
}

function childIds(widgets: CustomWidget[], containerId: string): string[] {
  const c = widgets.find((w) => w.id === containerId)!;
  return (c.config as ContainerWidgetConfig).widgets.map((w) => w.id);
}

// Index the designer computes: sibling centers with the dragged
// widget left out, cursor against those centers.
function dropIndex(order: string[], dragged: string, cursorSlot: number): number {
  const centers = order.filter((id) => id !== dragged).map((_, i) => i * 10 + 5);
  return insertionIndex(centers, cursorSlot);
}

describe('moveWidgetInTree reorder inside a dock', () => {
  const page = () => [dock('d', [tool('A0'), tool('A1'), tool('A2')])];

  it('moves forward to between the next two siblings', () => {
    // Cursor between A1 (center 5) and A2 (center 15) once A0 is out.
    const idx = dropIndex(['A0', 'A1', 'A2'], 'A0', 10);
    expect(idx).toBe(1);
    expect(childIds(moveWidgetInTree(page(), 'A0', 'd', idx, null), 'd')).toEqual([
      'A1',
      'A0',
      'A2',
    ]);
  });

  it('reaches the last slot', () => {
    const idx = dropIndex(['A0', 'A1', 'A2'], 'A0', 99);
    expect(childIds(moveWidgetInTree(page(), 'A0', 'd', idx, null), 'd')).toEqual([
      'A1',
      'A2',
      'A0',
    ]);
  });

  it('still moves backward', () => {
    const idx = dropIndex(['A0', 'A1', 'A2'], 'A2', 0);
    expect(childIds(moveWidgetInTree(page(), 'A2', 'd', idx, null), 'd')).toEqual([
      'A2',
      'A0',
      'A1',
    ]);
  });
});

describe('drag threshold', () => {
  it('treats a release without movement as a click', () => {
    expect(pastDragThreshold(0, 0)).toBe(false);
    expect(pastDragThreshold(3, -3)).toBe(false);
    expect(pastDragThreshold(4, 0)).toBe(true);
    expect(pastDragThreshold(0, -6)).toBe(true);
  });
});

describe('containerFlowsInRow', () => {
  const cfg = (c: Partial<ContainerWidgetConfig>): ContainerWidgetConfig => ({
    kind: 'container',
    widgets: [],
    ...c,
  });
  it('stacks dock, overlay and menu containers vertically whatever layout says', () => {
    expect(containerFlowsInRow(cfg({ position: 'dock-left' }))).toBe(false);
    expect(containerFlowsInRow(cfg({ position: 'dock-right', layout: 'row' }))).toBe(false);
    expect(containerFlowsInRow(cfg({ position: 'overlay-trigger' }))).toBe(false);
    expect(containerFlowsInRow(cfg({ position: 'menu' }))).toBe(false);
  });
  it('uses layout and the documented defaults for flow containers', () => {
    expect(containerFlowsInRow(cfg({ position: 'sticky-top' }))).toBe(true);
    expect(containerFlowsInRow(cfg({ position: 'inline' }))).toBe(false);
    expect(containerFlowsInRow(cfg({ position: 'inline', layout: 'row' }))).toBe(true);
  });
});

describe('allWidgetsDeep', () => {
  it('reaches maps inside containers and tabs', () => {
    const map = (id: string) =>
      ({ id, kind: 'map', layout: L, config: { kind: 'map' } }) as CustomWidget;
    const tabs = {
      id: 't',
      kind: 'tabs',
      layout: L,
      config: { kind: 'tabs', tabs: [{ id: 'x', title: 'X', widgets: [map('m2')] }] },
    } as unknown as CustomWidget;
    const ids = allWidgetsDeep([map('m0'), dock('d', [map('m1'), tabs])]).map((w) => w.id);
    expect(ids).toEqual(['m0', 'd', 'm1', 't', 'm2']);
  });
});

describe('defaultFollowMap', () => {
  const map = (id: string) =>
    ({ id, kind: 'map', layout: L, config: { kind: 'map' } }) as CustomWidget;
  it('prefers the active page, then any page', () => {
    const pages = [{ widgets: [map('p1')] }, { widgets: [dock('d', [map('p2')])] }, { widgets: [] }];
    expect(defaultFollowMap(pages, 1)?.id).toBe('p2');
    expect(defaultFollowMap(pages, 2)?.id).toBe('p1');
    expect(defaultFollowMap([{ widgets: [] }], 0)).toBeUndefined();
  });
});

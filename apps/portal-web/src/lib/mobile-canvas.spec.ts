// SPDX-License-Identifier: AGPL-3.0-or-later
import { mobilePlacements, type MobileWidgetBox } from './mobile-canvas';

function box(
  id: string,
  kind: string,
  col: number,
  row: number,
  colSpan: number,
  rowSpan: number,
): MobileWidgetBox {
  return { id, kind, col, row, colSpan, rowSpan };
}

describe('mobilePlacements', () => {
  it('puts a row of indicators two-up, in column order', () => {
    const placed = mobilePlacements([
      box('d', 'indicator', 145, 1, 48, 40),
      box('a', 'indicator', 1, 1, 48, 40),
      box('c', 'indicator', 97, 1, 48, 40),
      box('b', 'indicator', 49, 1, 48, 40),
    ]);
    expect(placed.map((item) => [item.id, item.column, item.row])).toEqual([
      ['a', '1', '1'],
      ['b', '2', '1'],
      ['c', '1', '2'],
      ['d', '2', '2'],
    ]);
    expect(placed.every((item) => item.height === 'auto')).toBe(true);
  });

  it('stacks a map and the charts beside it, map first', () => {
    const placed = mobilePlacements([
      box('kpi', 'indicator', 1, 1, 192, 40),
      box('chart-b', 'chart', 97, 90, 96, 50),
      box('map', 'map', 1, 41, 96, 120),
      box('chart-a', 'chart', 97, 41, 96, 49),
    ]);
    expect(placed.map((item) => [item.id, item.column, item.height])).toEqual([
      ['kpi', '1 / -1', 'auto'],
      ['map', '1 / -1', 'min(58dvh, 480px)'],
      ['chart-a', '1 / -1', '300px'],
      ['chart-b', '1 / -1', '300px'],
    ]);
  });

  it('keeps side-by-side charts full width, one after the other', () => {
    const placed = mobilePlacements([
      box('right', 'chart', 97, 41, 96, 110),
      box('left', 'chart', 1, 41, 96, 110),
    ]);
    expect(placed.map((item) => item.id)).toEqual(['left', 'right']);
    expect(placed.every((item) => item.column === '1 / -1')).toBe(true);
  });
});

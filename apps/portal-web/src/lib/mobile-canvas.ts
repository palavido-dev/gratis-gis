// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phone placement for a custom-app canvas.
 *
 * The authoring grid is 192 columns. On a phone that grid keeps
 * widgets side by side, so a row of indicators and a map-beside-charts
 * layout collapse into unreadable slivers. This module names a
 * reading order instead: indicators that share a band sit two-up,
 * everything else stacks full width, top to bottom.
 *
 * The runtime writes the result onto each widget as CSS variables.
 * A max-width media query applies them. Desktop placement is untouched.
 */

export interface MobileWidgetBox {
  id: string;
  kind: string;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface MobilePlacement {
  id: string;
  /** CSS grid-column. */
  column: string;
  /** CSS grid-row. */
  row: string;
  /** CSS height. `auto` sizes to the widget's content. */
  height: string;
  minHeight: string;
}

export function mobilePlacements(widgets: MobileWidgetBox[]): MobilePlacement[] {
  const bands = bandWidgets(widgets);
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const out: MobilePlacement[] = [];
  let row = 1;
  for (const band of bands) {
    const indicatorsOnly =
      band.length > 1 && band.every((widget) => widget.kind === 'indicator');
    if (indicatorsOnly) {
      const ordered = [...band].sort((a, b) => a.col - b.col);
      ordered.forEach((widget, index) => {
        out.push({
          id: widget.id,
          column: index % 2 === 0 ? '1' : '2',
          row: String(row + Math.floor(index / 2)),
          height: 'auto',
          minHeight: '104px',
        });
      });
      row += Math.ceil(ordered.length / 2);
      continue;
    }
    const ordered = [...band].sort((a, b) => a.col - b.col || a.row - b.row);
    for (const widget of ordered) {
      const height = mobileStackHeight(byId.get(widget.id)?.kind ?? widget.kind);
      out.push({
        id: widget.id,
        column: '1 / -1',
        row: String(row),
        height: height ?? 'auto',
        minHeight: height ?? '0px',
      });
      row += 1;
    }
  }
  return out;
}

/** Explicit height for widgets that measure a canvas. Content widgets
 *  stay `null` so the card grows with its label. */
export function mobileStackHeight(kind: string): string | null {
  switch (kind) {
    case 'map':
      return 'min(58dvh, 480px)';
    case 'chart':
      return '300px';
    case 'attribute-table':
      return '360px';
    case 'image':
    case 'embed':
      return '240px';
    case 'indicator':
    case 'text':
    case 'button':
    case 'divider':
      return null;
    default:
      return '220px';
  }
}

function bandWidgets(widgets: MobileWidgetBox[]): MobileWidgetBox[][] {
  const sorted = [...widgets].sort((a, b) => a.row - b.row || a.col - b.col);
  const groups: MobileWidgetBox[][] = [];
  for (const widget of sorted) {
    const last = groups[groups.length - 1];
    if (!last || !overlapsBand(last, widget)) {
      groups.push([widget]);
      continue;
    }
    last.push(widget);
  }
  return groups;
}

function overlapsBand(band: MobileWidgetBox[], widget: MobileWidgetBox): boolean {
  const top = Math.min(...band.map((item) => item.row));
  const bottom = Math.max(...band.map((item) => item.row + item.rowSpan));
  const overlap =
    Math.min(bottom, widget.row + widget.rowSpan) - Math.max(top, widget.row);
  return overlap > 0;
}

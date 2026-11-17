// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Miniature wireframe of a print template's page layout. Used as the
 * hover preview in the "Print this map" chooser so authors can see
 * where the map / legend / title sit before committing to a render.
 */

import {
  resolvePaperInches,
  type PrintElement,
  type PrintTemplateData,
} from '@gratis-gis/shared-types';

const KIND_FILL: Record<PrintElement['kind'], string> = {
  map: '#c5d4e8',
  text: '#e8e2d6',
  legend: '#d9e8d0',
  scalebar: '#ddd6c8',
  'north-arrow': '#ddd6c8',
  image: '#d6dde8',
  line: '#b7ae9f',
  rectangle: '#efeae1',
};

interface Props {
  data: PrintTemplateData;
  /** Max width of the thumbnail in CSS pixels. */
  maxWidth?: number;
  className?: string;
}

export function PrintLayoutThumb({
  data,
  maxWidth = 168,
  className,
}: Props) {
  const inches = resolvePaperInches(data.paper);
  const scale = maxWidth / inches.w;
  const width = maxWidth;
  const height = Math.max(1, Math.round(inches.h * scale));

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        height,
        background: '#fffdf9',
        border: '1px solid #d8d0c2',
        boxShadow: '0 1px 2px rgba(43, 38, 32, 0.06)',
        overflow: 'hidden',
      }}
      aria-hidden
    >
      {(data.elements ?? []).map((el) => {
        const fill = KIND_FILL[el.kind] ?? '#efeae1';
        const isLine = el.kind === 'line';
        return (
          <div
            key={el.id}
            style={{
              position: 'absolute',
              left: el.box.x * scale,
              top: el.box.y * scale,
              width: Math.max(isLine ? 2 : 3, el.box.w * scale),
              height: Math.max(isLine ? 1 : 3, el.box.h * scale),
              background: fill,
              border: el.kind === 'map' ? '1px solid #8fa4c0' : '1px solid #cfc6b6',
              boxSizing: 'border-box',
            }}
          />
        );
      })}
    </div>
  );
}

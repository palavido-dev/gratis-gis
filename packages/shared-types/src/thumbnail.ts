// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Item thumbnail design + renderer (#66).
 *
 * Every item ships with a generated thumbnail.  The design is a small
 * JSON blob stored on the item; the rendered output is SVG returned by
 * a backend endpoint that the portal points its <img> tags at.  SVG
 * instead of baked PNG because:
 *
 *   - It scales perfectly at any card size.
 *   - It re-renders against current item state on every request, so a
 *     renamed item shows the new title immediately with zero re-bake.
 *   - It's tiny: under 2 KB per thumbnail vs 30-60 KB for a baked PNG.
 *   - No image-library dependency (sharp, node-canvas, satori) needs
 *     to live in the portal-api Docker image.
 *
 * Forced consistency: sidebar + title overlays are ALWAYS rendered.
 * There is no toggle to hide them.  That's the deliberate design
 * choice from the project memory: every thumbnail across the portal
 * follows the same visual grammar, and no author can bake a title
 * into a background image that then can't follow a rename.
 */
import type { ItemType } from './item-types';

export interface ThumbnailDesign {
  /** Schema version.  Bumped on any breaking change to the shape. */
  version: 1;
  /**
   * Background fill color as a CSS color string.  Hex, rgb(), or hsl()
   * all work.  Renders as the bottom layer; visible wherever the
   * background image (if any) leaves space and through the
   * semi-transparent sidebar / title bar overlays.
   */
  background: string;
  /**
   * Optional full-bleed background image, either an absolute URL or
   * a `data:` URL.  Renders above the background color and below
   * the sidebar + title-bar overlays.  Honors `backgroundOpacity`
   * so the underlying color can show through.
   */
  backgroundImage?: string | null;
  /**
   * Background image opacity (0..1).  Defaults to 1 (fully visible).
   * Lets the author fade the image so the chrome reads cleanly.
   */
  backgroundOpacity?: number;
  /** Sidebar strip fill color. */
  sidebar: string;
  /**
   * Sidebar fill opacity (0..1).  Defaults to 1.  Lower values let
   * the background bleed through, mimicking AGO's polished
   * thumbnail look.
   */
  sidebarOpacity?: number;
  /**
   * Optional override of the type-label text shown in the sidebar.
   * When null / missing the renderer falls back to whatever the
   * backend passes in (typically getItemTypeLabel(item.type)).
   * The override only changes the LABEL, never the layout.
   */
  sidebarLabelOverride?: string | null;
  /**
   * Title-bar fill color.  The title overlay sits across the bottom
   * of the canvas behind the item title text.  Defaults to the
   * sidebar color when unset so an author who only edits sidebar
   * still gets a coordinated palette.
   */
  titleBar?: string;
  /**
   * Title-bar fill opacity (0..1).  Defaults to ~0.85 so the title
   * stays legible while letting the background tease through.
   */
  titleBarOpacity?: number;
  /**
   * Optional logo image URL (absolute or `data:`).  Renders in the
   * top-right of the background area, above the title bar.  Null /
   * missing = no logo.
   */
  logo?: string | null;
}

/**
 * Per-item-type default colors used to seed a new item's thumbnail
 * design.  Sidebar drives the type-coded right-side strip and the
 * title-bar tint; background is a desaturated tint of the same hue
 * so the two work as a pair when there's no background image.
 */
const TYPE_PALETTE: Record<string, { sidebar: string; background: string }> = {
  map: { sidebar: '#5c6b58', background: '#eef1ec' },
  data_layer: { sidebar: '#55677a', background: '#edf1f5' },
  derived_layer: { sidebar: '#4c5f45', background: '#edf1eb' },
  arcgis_service: { sidebar: '#4e6e69', background: '#ecf2f1' },
  form: { sidebar: '#7d5a64', background: '#f4eef0' },
  form_submission_collection: { sidebar: '#8d6a74', background: '#f4eef0' },
  web_app: { sidebar: '#9c7648', background: '#f5f0e8' },
  report_template: { sidebar: '#8a5252', background: '#f4eded' },
  dashboard: { sidebar: '#8f7440', background: '#f4f0e6' },
  file: { sidebar: '#6e675e', background: '#f2f0ec' },
  layer_package: { sidebar: '#6f6b3f', background: '#f2f1e7' },
  tool: { sidebar: '#85683f', background: '#f3efe6' },
  widget_package: { sidebar: '#74573b', background: '#f2ede7' },
  pick_list: { sidebar: '#837448', background: '#f3f0e6' },
  geo_boundary: { sidebar: '#96573b', background: '#f5eee9' },
  basemap: { sidebar: '#625f55', background: '#f1f0ec' },
  wms_service: { sidebar: '#43625e', background: '#ecf2f1' },
  wfs_service: { sidebar: '#3a5652', background: '#ecf2f1' },
  service: { sidebar: '#4e6e69', background: '#ecf2f1' },
  folder: { sidebar: '#a1793f', background: '#f5f0e6' },
  editor: { sidebar: '#6d5570', background: '#f1edf2' },
  data_collection: { sidebar: '#7c6280', background: '#f1edf2' },
  geocoding_service: { sidebar: '#92603a', background: '#f5efe9' },
  tile_layer: { sidebar: '#715e6e', background: '#f1eef1' },
  app_template: { sidebar: '#8f6c42', background: '#f5f0e8' },
  theme: { sidebar: '#94606b', background: '#f5eef0' },
  print_template: { sidebar: '#565049', background: '#f1f0ee' },
  point_cloud: { sidebar: '#5b6472', background: '#eef0f3' },
};

/**
 * Build the default thumbnail design for a newly-created item.  The
 * caller is responsible for passing the item's type; title is read
 * live by the renderer at request time, not baked in here.
 *
 * Defaults reach for a polished out-of-the-box look that resembles
 * the AGO Story Map template that inspired the redesign: full-bleed
 * background color, type-coded sidebar at ~95% opacity, title bar
 * across the bottom at ~80% opacity so the background reads
 * through.
 */
export function defaultThumbnailDesign(type: ItemType): ThumbnailDesign {
  const palette = TYPE_PALETTE[type] ?? { sidebar: '#475569', background: '#f8fafc' };
  return {
    version: 1,
    background: palette.background,
    backgroundImage: null,
    backgroundOpacity: 1,
    sidebar: palette.sidebar,
    sidebarOpacity: 0.95,
    sidebarLabelOverride: null,
    titleBar: palette.sidebar,
    titleBarOpacity: 0.8,
    logo: null,
  };
}

/**
 * Render a thumbnail SVG.  Returns a complete `<svg>` document
 * string ready for `Content-Type: image/svg+xml`.
 *
 * Four-layer composition (AGO Story Map style), viewBox 600x400:
 *
 *   +---------------------------------------+--+
 *   |   [logo]                              |  |
 *   |                                       |  |
 *   |        background (image or color)    |s |
 *   |                                       |i |
 *   |                                       |d |
 *   |                                       |e |
 *   +---------------------------------------+b |
 *   |   title text on title bar (transp.)   |ar|
 *   +---------------------------------------+--+
 *
 * Layer order (bottom to top):
 *   1. background color (always)
 *   2. background image (optional, honors backgroundOpacity)
 *   3. title bar (semi-transparent strip across the bottom)
 *   4. sidebar (semi-transparent strip on the right, overlaps title bar)
 *   5. logo (optional, top-left of background area)
 *   6. title text (on title bar, right of sidebar)
 *   7. rotated type label (on sidebar)
 */
/**
 * Type-keyed background motifs. Bold cartographic set: one unique,
 * deterministic motif per item type, drawn in the type's sidebar hue
 * over the TYPE_PALETTE background tint, fitted (translate + scale)
 * into the open area beside the sidebar strip and above the title bar
 * with ~26px padding. No randomness, so renders are stable and
 * cacheable.
 */
// ---- per-type motifs -------------------------------------------------
// Each returns SVG markup (no outer <svg>). `c` = escaped sidebar hue.

function mMap(c: string): string {
  // Contour hill: nested index contours around a summit, spot elevation.
  const ring = 'M -190 25 C -160 -70 -55 -125 45 -105 C 145 -85 205 -10 175 60 C 145 130 -5 150 -100 120 C -175 96 -215 80 -190 25 Z';
  const rings = (
    [
      [1, 0.35, 3], [0.78, 0.5, 2.5], [0.56, 0.65, 4.5], [0.36, 0.5, 2.5],
    ] as Array<[number, number, number]>
  ).map(([s, o, w]) =>
    `<g transform="translate(250 168) scale(${s})"><path d="${ring}" fill="none" stroke="${c}" stroke-width="${w / s}" opacity="${o}"/></g>`
  ).join('');
  return `${rings}
  <g transform="translate(250 168) scale(0.18)"><path d="${ring}" fill="${c}" opacity="0.3"/></g>
  <circle cx="252" cy="168" r="6" fill="${c}" opacity="0.9"/>
  <path d="M 252 132 l 9 16 h -18 Z" fill="${c}" opacity="0.75"/>`;
}

function mBasemap(c: string): string {
  // Globe with graticule and a coast landmass.
  const cx = 250, cy = 168, r = 132;
  const chord = (dy: number) => Math.round(Math.sqrt(r * r - dy * dy));
  const par = [-88, -44, 44, 88].map((dy) =>
    `<line x1="${cx - chord(dy)}" y1="${cy + dy}" x2="${cx + chord(dy)}" y2="${cy + dy}" stroke="${c}" stroke-width="2.5" opacity="0.4"/>`
  ).join('');
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" opacity="0.07"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="4" opacity="0.7"/>
  <ellipse cx="${cx}" cy="${cy}" rx="44" ry="${r}" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.4"/>
  <ellipse cx="${cx}" cy="${cy}" rx="88" ry="${r}" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.4"/>
  <line x1="${cx}" y1="${cy - r}" x2="${cx}" y2="${cy + r}" stroke="${c}" stroke-width="2.5" opacity="0.4"/>
  ${par}
  <path d="M 190 100 C 225 80 268 92 280 120 C 292 148 260 162 230 158 C 196 154 168 150 168 132 C 168 116 172 110 190 100 Z" fill="${c}" opacity="0.45"/>`;
}

function mGeoBoundary(c: string): string {
  const pts = [[110, 70], [300, 50], [455, 120], [430, 250], [260, 300], [95, 240]];
  const d = 'M ' + pts.map((p) => p.join(' ')).join(' L ') + ' Z';
  const verts = pts.map(([x, y]) =>
    `<circle cx="${x}" cy="${y}" r="9" fill="#ffffff" stroke="${c}" stroke-width="4" opacity="0.95"/>`
  ).join('');
  return `<path d="${d}" fill="${c}" opacity="0.1"/>
  <path d="${d}" fill="none" stroke="${c}" stroke-width="5" stroke-dasharray="20 12" stroke-linejoin="round" opacity="0.8"/>
  ${verts}`;
}

function mDerivedLayer(c: string): string {
  const para = (cx: number, cy: number, w: number, h: number) =>
    `M ${cx - w} ${cy} L ${cx} ${cy - h} L ${cx + w} ${cy} L ${cx} ${cy + h} Z`;
  return `<path d="${para(165, 95, 140, 55)}" fill="${c}" opacity="0.1"/>
  <path d="${para(165, 95, 140, 55)}" fill="none" stroke="${c}" stroke-width="3" opacity="0.55"/>
  <path d="${para(350, 95, 140, 55)}" fill="${c}" opacity="0.1"/>
  <path d="${para(350, 95, 140, 55)}" fill="none" stroke="${c}" stroke-width="3" opacity="0.55"/>
  <line x1="256" y1="158" x2="256" y2="200" stroke="${c}" stroke-width="6" opacity="0.75"/>
  <path d="M 256 216 l -13 -18 h 26 Z" fill="${c}" opacity="0.75"/>
  <path d="${para(256, 268, 165, 58)}" fill="${c}" opacity="0.3"/>
  <path d="${para(256, 268, 165, 58)}" fill="none" stroke="${c}" stroke-width="4.5" opacity="0.85"/>`;
}

function mTileLayer(c: string): string {
  const ops = [0.1, 0.24, 0.1, 0.16, 0.1, 0.24];
  let tiles = '';
  for (let j = 0; j < 2; j += 1) {
    for (let i = 0; i < 3; i += 1) {
      tiles += `<rect x="${58 + i * 148}" y="${62 + j * 122}" width="128" height="102" rx="10" fill="${c}" opacity="${ops[j * 3 + i]}"/>`;
    }
  }
  return `${tiles}
  <rect x="346" y="168" width="128" height="102" rx="10" fill="none" stroke="${c}" stroke-width="4" opacity="0.8" transform="translate(10 -10)"/>
  <path d="M 60 130 C 140 100 220 150 320 118 C 400 92 450 130 500 110" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.45"/>`;
}

function mLayerPackage(c: string): string {
  const dia = (cy: number) =>
    `M 66 ${cy} L 256 ${cy - 62} L 446 ${cy} L 256 ${cy + 62} Z`;
  return `<path d="${dia(258)}" fill="${c}" opacity="0.08"/>
  <path d="${dia(258)}" fill="none" stroke="${c}" stroke-width="3" opacity="0.45"/>
  <path d="${dia(188)}" fill="${c}" opacity="0.14"/>
  <path d="${dia(188)}" fill="none" stroke="${c}" stroke-width="3" opacity="0.55"/>
  <path d="${dia(118)}" fill="${c}" opacity="0.3"/>
  <path d="${dia(118)}" fill="none" stroke="${c}" stroke-width="4.5" opacity="0.85"/>
  <path d="M 170 112 C 210 96 300 96 342 112" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.5"/>`;
}

function mDataLayer(c: string): string {
  const grid = [130, 260, 390].map((x) => `<line x1="${x}" y1="20" x2="${x}" y2="320" stroke="${c}" stroke-width="2" opacity="0.1"/>`).join('') +
    [110, 200, 290].map((y) => `<line x1="20" y1="${y}" x2="510" y2="${y}" stroke="${c}" stroke-width="2" opacity="0.1"/>`).join('');
  const pts = [[140, 110, 34], [320, 90, 20], [432, 152, 26], [212, 228, 44], [392, 258, 30], [108, 268, 16]];
  const dots = pts.map(([x, y, r]) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="0.16"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.7"/>
  <circle cx="${x}" cy="${y}" r="4.5" fill="${c}" opacity="0.85"/>`
  ).join('');
  return grid + dots;
}

function mPickList(c: string): string {
  const rows: Array<[number, number]> = [
    [0.8, 300], [0.5, 240], [0.32, 270], [0.18, 200],
  ];
  return `<rect x="52" y="52" width="430" height="52" rx="12" fill="${c}" opacity="0.1"/>` +
    rows.map(([op, w], i) => {
      const y = 66 + i * 66;
      return `<rect x="72" y="${y}" width="26" height="26" rx="6" fill="${c}" opacity="${op}"/>
  <rect x="122" y="${y + 8}" width="${w}" height="11" rx="5.5" fill="${c}" opacity="${i === 0 ? 0.5 : 0.25}"/>`;
    }).join('');
}

function mForm(c: string): string {
  const field = (y: number) => `<rect x="72" y="${y}" width="360" height="48" rx="10" fill="#ffffff" opacity="0.5"/>
  <rect x="72" y="${y}" width="360" height="48" rx="10" fill="none" stroke="${c}" stroke-width="3" opacity="0.5"/>`;
  return `${field(52)}${field(124)}${field(196)}
  <rect x="90" y="68" width="150" height="14" rx="7" fill="${c}" opacity="0.35"/>
  <rect x="90" y="140" width="200" height="14" rx="7" fill="${c}" opacity="0.25"/>
  <circle cx="96" cy="220" r="9" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.6"/>
  <circle cx="96" cy="220" r="4" fill="${c}" opacity="0.75"/>
  <rect x="118" y="212" width="140" height="14" rx="7" fill="${c}" opacity="0.25"/>
  <rect x="72" y="268" width="176" height="46" rx="23" fill="${c}" opacity="0.8"/>`;
}

function mFormSubmissions(c: string): string {
  const card = 'x="-150" y="-100" width="300" height="200" rx="14"';
  return `<g transform="translate(238 172) rotate(-9)"><rect ${card} fill="${c}" opacity="0.12"/><rect ${card} fill="none" stroke="${c}" stroke-width="3" opacity="0.4"/></g>
  <g transform="translate(252 176) rotate(-3)"><rect ${card} fill="${c}" opacity="0.16"/></g>
  <g transform="translate(268 180) rotate(3)">
    <rect ${card} fill="#ffffff" opacity="0.6"/>
    <rect ${card} fill="none" stroke="${c}" stroke-width="3.5" opacity="0.7"/>
    <rect x="-120" y="-64" width="180" height="13" rx="6.5" fill="${c}" opacity="0.45"/>
    <rect x="-120" y="-30" width="230" height="11" rx="5.5" fill="${c}" opacity="0.25"/>
    <rect x="-120" y="-2" width="230" height="11" rx="5.5" fill="${c}" opacity="0.25"/>
    <circle cx="96" cy="58" r="20" fill="${c}" opacity="0.8"/>
    <path d="M 87 58 l 7 8 l 14 -16" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
}

function mReportTemplate(c: string): string {
  const bars = (
    [[0, 46], [1, 78], [2, 60], [3, 100]] as Array<[number, number]>
  ).map(([i, h]) =>
    `<rect x="${182 + i * 42}" y="${232 - h}" width="30" height="${h}" fill="${c}" opacity="${0.3 + i * 0.15}"/>`
  ).join('');
  return `<rect x="150" y="30" width="220" height="292" rx="10" fill="#ffffff" opacity="0.55"/>
  <rect x="150" y="30" width="220" height="292" rx="10" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.6"/>
  <rect x="176" y="56" width="120" height="15" rx="7.5" fill="${c}" opacity="0.55"/>
  <rect x="176" y="88" width="168" height="10" rx="5" fill="${c}" opacity="0.25"/>
  <rect x="176" y="110" width="168" height="10" rx="5" fill="${c}" opacity="0.25"/>
  ${bars}
  <line x1="176" y1="232" x2="344" y2="232" stroke="${c}" stroke-width="3" opacity="0.55"/>
  <rect x="176" y="258" width="168" height="10" rx="5" fill="${c}" opacity="0.25"/>
  <rect x="176" y="280" width="120" height="10" rx="5" fill="${c}" opacity="0.25"/>`;
}

function mFile(c: string): string {
  return `<path d="M 192 42 h 138 l 52 52 v 200 a 10 10 0 0 1 -10 10 H 202 a 10 10 0 0 1 -10 -10 V 52 a 10 10 0 0 1 10 -10 Z" fill="${c}" opacity="0.14"/>
  <path d="M 192 42 h 138 l 52 52 v 200 a 10 10 0 0 1 -10 10 H 202 a 10 10 0 0 1 -10 -10 V 52 a 10 10 0 0 1 10 -10 Z" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.65"/>
  <path d="M 330 42 l 52 52 h -52 Z" fill="${c}" opacity="0.5"/>
  <rect x="218" y="140" width="146" height="11" rx="5.5" fill="${c}" opacity="0.3"/>
  <rect x="218" y="168" width="146" height="11" rx="5.5" fill="${c}" opacity="0.3"/>
  <rect x="218" y="196" width="104" height="11" rx="5.5" fill="${c}" opacity="0.3"/>`;
}

function mPrintTemplate(c: string): string {
  const mark = (x: number, y: number, dx: number, dy: number) =>
    `<line x1="${x + dx * 12}" y1="${y}" x2="${x + dx * 40}" y2="${y}" stroke="${c}" stroke-width="3" opacity="0.7"/>
  <line x1="${x}" y1="${y + dy * 12}" x2="${x}" y2="${y + dy * 40}" stroke="${c}" stroke-width="3" opacity="0.7"/>`;
  return `${mark(92, 52, 1, 1)}${mark(440, 52, -1, 1)}${mark(92, 300, 1, -1)}${mark(440, 300, -1, -1)}
  <rect x="92" y="52" width="348" height="248" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="10 8" opacity="0.35"/>
  <rect x="122" y="82" width="288" height="150" fill="${c}" opacity="0.08"/>
  <rect x="122" y="82" width="288" height="150" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.5"/>
  <path d="M 138 200 C 200 160 260 210 320 172 C 360 148 380 170 396 158" fill="none" stroke="${c}" stroke-width="3" opacity="0.45"/>
  <rect x="122" y="252" width="150" height="11" rx="5.5" fill="${c}" opacity="0.35"/>
  <rect x="122" y="274" width="100" height="9" rx="4.5" fill="${c}" opacity="0.22"/>`;
}

function mWebApp(c: string): string {
  return `<rect x="62" y="46" width="408" height="266" rx="14" fill="#ffffff" opacity="0.4"/>
  <rect x="62" y="46" width="408" height="266" rx="14" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.65"/>
  <line x1="62" y1="94" x2="470" y2="94" stroke="${c}" stroke-width="2.5" opacity="0.4"/>
  <circle cx="88" cy="70" r="5.5" fill="${c}" opacity="0.55"/>
  <circle cx="108" cy="70" r="5.5" fill="${c}" opacity="0.4"/>
  <circle cx="128" cy="70" r="5.5" fill="${c}" opacity="0.25"/>
  <rect x="80" y="112" width="112" height="182" rx="8" fill="${c}" opacity="0.14"/>
  <rect x="94" y="128" width="84" height="10" rx="5" fill="${c}" opacity="0.35"/>
  <rect x="94" y="152" width="66" height="10" rx="5" fill="${c}" opacity="0.35"/>
  <rect x="94" y="176" width="76" height="10" rx="5" fill="${c}" opacity="0.35"/>
  <path d="M 210 240 C 260 200 310 250 360 210 C 400 180 430 205 452 190" fill="none" stroke="${c}" stroke-width="3" opacity="0.4"/>
  <path d="M 210 190 C 262 152 312 198 364 162 C 402 136 432 158 452 145" fill="none" stroke="${c}" stroke-width="3" opacity="0.4"/>
  <circle cx="340" cy="180" r="20" fill="${c}" opacity="0.85"/>
  <path d="M 326 194 L 340 226 L 354 194 Z" fill="${c}" opacity="0.85"/>
  <circle cx="340" cy="180" r="8" fill="#ffffff" opacity="0.95"/>`;
}

function mAppTemplate(c: string): string {
  const spark = (x: number, y: number, s: number) => `<path transform="translate(${x} ${y}) scale(${s})" d="M 0 -22 C 3 -8 8 -3 22 0 C 8 3 3 8 0 22 C -3 8 -8 3 -22 0 C -8 -3 -3 -8 0 -22 Z" fill="${c}" opacity="0.85"/>`;
  return `<rect x="62" y="46" width="408" height="266" rx="14" fill="none" stroke="${c}" stroke-width="3.5" stroke-dasharray="14 10" opacity="0.6"/>
  <line x1="62" y1="94" x2="470" y2="94" stroke="${c}" stroke-width="2.5" stroke-dasharray="10 8" opacity="0.4"/>
  <rect x="80" y="112" width="112" height="182" rx="8" fill="none" stroke="${c}" stroke-width="2.5" stroke-dasharray="10 8" opacity="0.4"/>
  <rect x="210" y="112" width="242" height="182" rx="8" fill="none" stroke="${c}" stroke-width="2.5" stroke-dasharray="10 8" opacity="0.3"/>
  ${spark(400, 90, 1)}${spark(438, 130, 0.55)}`;
}

function mDashboard(c: string): string {
  const arc = 2 * Math.PI * 46 * 0.42;
  const gap = 2 * Math.PI * 46 - arc;
  return `<rect x="56" y="50" width="280" height="158" rx="12" fill="${c}" opacity="0.08"/>
  <polyline points="80,180 140,120 200,150 260,92 312,118" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
  <circle cx="140" cy="120" r="6" fill="${c}" opacity="0.9"/>
  <circle cx="260" cy="92" r="6" fill="${c}" opacity="0.9"/>
  <circle cx="428" cy="128" r="46" fill="none" stroke="${c}" stroke-width="18" opacity="0.2"/>
  <circle cx="428" cy="128" r="46" fill="none" stroke="${c}" stroke-width="18" stroke-dasharray="${arc.toFixed(1)} ${gap.toFixed(1)}" transform="rotate(-90 428 128)" opacity="0.75"/>
  <rect x="56" y="232" width="280" height="82" rx="12" fill="${c}" opacity="0.08"/>
  <rect x="80" y="256" width="150" height="14" rx="7" fill="${c}" opacity="0.5"/>
  <rect x="80" y="284" width="220" height="10" rx="5" fill="${c}" opacity="0.25"/>
  <rect x="360" y="232" width="136" height="82" rx="12" fill="${c}" opacity="0.22"/>`;
}

function mWidgetPackage(c: string): string {
  return `<path d="M 256 78 L 368 134 L 256 190 L 144 134 Z" fill="${c}" opacity="0.35"/>
  <path d="M 144 134 L 256 190 L 256 302 L 144 246 Z" fill="${c}" opacity="0.18"/>
  <path d="M 256 190 L 368 134 L 368 246 L 256 302 Z" fill="${c}" opacity="0.55"/>
  <path d="M 256 78 L 368 134 L 368 246 L 256 302 L 144 246 L 144 134 Z" fill="none" stroke="${c}" stroke-width="3.5" stroke-linejoin="round" opacity="0.7"/>
  <line x1="256" y1="190" x2="256" y2="302" stroke="${c}" stroke-width="3" opacity="0.6"/>
  <line x1="256" y1="190" x2="144" y2="134" stroke="${c}" stroke-width="3" opacity="0.6"/>
  <line x1="256" y1="190" x2="368" y2="134" stroke="${c}" stroke-width="3" opacity="0.6"/>
  <circle cx="88" cy="80" r="5" fill="${c}" opacity="0.3"/>
  <circle cx="430" cy="72" r="5" fill="${c}" opacity="0.3"/>
  <circle cx="452" cy="286" r="5" fill="${c}" opacity="0.3"/>`;
}

function mEditor(c: string): string {
  const pts: Array<[number, number]> = [
    [130, 220], [200, 90], [330, 70], [410, 150], [390, 270], [210, 290],
  ];
  const d = 'M ' + pts.map((p) => p.join(' ')).join(' L ') + ' Z';
  const verts = pts.map(([x, y]) =>
    `<rect x="${x - 8}" y="${y - 8}" width="16" height="16" fill="#ffffff" stroke="${c}" stroke-width="3.5" opacity="0.95"/>`
  ).join('');
  return `<path d="${d}" fill="${c}" opacity="0.1"/>
  <path d="${d}" fill="none" stroke="${c}" stroke-width="4" stroke-linejoin="round" opacity="0.7"/>
  <line x1="330" y1="70" x2="462" y2="108" stroke="${c}" stroke-width="3" stroke-dasharray="10 8" opacity="0.5"/>
  <line x1="410" y1="150" x2="462" y2="108" stroke="${c}" stroke-width="3" stroke-dasharray="10 8" opacity="0.5"/>
  ${verts}
  <rect x="454" y="100" width="16" height="16" fill="${c}" opacity="0.85"/>
  <circle cx="462" cy="108" r="26" fill="none" stroke="${c}" stroke-width="2.5" stroke-dasharray="6 6" opacity="0.5"/>`;
}

function mDataCollection(c: string): string {
  return `<rect x="190" y="30" width="150" height="290" rx="24" fill="#ffffff" opacity="0.45"/>
  <rect x="190" y="30" width="150" height="290" rx="24" fill="none" stroke="${c}" stroke-width="4" opacity="0.7"/>
  <line x1="240" y1="54" x2="290" y2="54" stroke="${c}" stroke-width="4" stroke-linecap="round" opacity="0.5"/>
  <circle cx="265" cy="140" r="30" fill="${c}" opacity="0.85"/>
  <path d="M 244 160 L 265 208 L 286 160 Z" fill="${c}" opacity="0.85"/>
  <circle cx="265" cy="140" r="11" fill="#ffffff" opacity="0.95"/>
  <rect x="216" y="238" width="98" height="10" rx="5" fill="${c}" opacity="0.35"/>
  <rect x="216" y="262" width="72" height="10" rx="5" fill="${c}" opacity="0.25"/>
  <path d="M 372 90 a 40 40 0 0 1 40 40" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" opacity="0.5"/>
  <path d="M 372 116 a 16 16 0 0 1 16 16" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" opacity="0.65"/>
  <circle cx="372" cy="138" r="6" fill="${c}" opacity="0.75"/>`;
}

function mTheme(c: string): string {
  const card = 'x="-58" y="-80" width="116" height="160" rx="14"';
  return `<g transform="translate(186 176) rotate(-14)"><rect ${card} fill="${c}" opacity="0.18"/><rect ${card} fill="none" stroke="${c}" stroke-width="3" opacity="0.45"/></g>
  <g transform="translate(262 164) rotate(0)"><rect ${card} fill="${c}" opacity="0.4"/><rect ${card} fill="none" stroke="${c}" stroke-width="3" opacity="0.55"/></g>
  <g transform="translate(338 176) rotate(14)">
    <rect ${card} fill="${c}" opacity="0.75"/>
    <circle cx="0" cy="-30" r="20" fill="#ffffff" opacity="0.65"/>
    <rect x="-34" y="16" width="68" height="10" rx="5" fill="#ffffff" opacity="0.55"/>
    <rect x="-34" y="40" width="46" height="10" rx="5" fill="#ffffff" opacity="0.4"/>
  </g>`;
}

function mTool(c: string): string {
  return `<circle cx="256" cy="176" r="145" fill="none" stroke="${c}" stroke-width="3" opacity="0.25"/>
  <circle cx="256" cy="176" r="100" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="14 10" opacity="0.45"/>
  <circle cx="256" cy="176" r="55" fill="${c}" opacity="0.12"/>
  <circle cx="256" cy="176" r="55" fill="none" stroke="${c}" stroke-width="4" opacity="0.65"/>
  <circle cx="256" cy="176" r="10" fill="${c}" opacity="0.9"/>
  <line x1="256" y1="176" x2="374" y2="94" stroke="${c}" stroke-width="3.5" opacity="0.6"/>
  <path d="M 388 84 l -20 2 l 8 18 Z" fill="${c}" opacity="0.7"/>`;
}

function mService(c: string): string {
  const nodes = [[112, 92, 20], [420, 96, 20], [142, 274, 17], [400, 266, 17]];
  const spokes = nodes.map(([x, y]) =>
    `<line x1="256" y1="176" x2="${x}" y2="${y}" stroke="${c}" stroke-width="4" opacity="0.45"/>`
  ).join('');
  const dots = nodes.map(([x, y, r]) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="0.22"/><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.65"/>`
  ).join('');
  return `${spokes}${dots}
  <circle cx="256" cy="176" r="36" fill="${c}" opacity="0.85"/>
  <circle cx="256" cy="176" r="12" fill="#ffffff" opacity="0.9"/>`;
}

function mArcgisService(c: string): string {
  const shelf = (y: number) => `<rect x="120" y="${y}" width="250" height="54" rx="10" fill="${c}" opacity="0.15"/>
  <rect x="120" y="${y}" width="250" height="54" rx="10" fill="none" stroke="${c}" stroke-width="3" opacity="0.6"/>
  <circle cx="148" cy="${y + 27}" r="6.5" fill="${c}" opacity="0.8"/>
  <rect x="172" y="${y + 21}" width="120" height="12" rx="6" fill="${c}" opacity="0.3"/>`;
  return `${shelf(88)}${shelf(156)}${shelf(224)}
  <path d="M 408 168 a 52 52 0 0 1 52 52" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <path d="M 408 196 a 26 26 0 0 1 26 26" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" opacity="0.6"/>
  <circle cx="410" cy="228" r="8" fill="${c}" opacity="0.8"/>`;
}

function mWmsService(c: string): string {
  return `<rect x="96" y="64" width="300" height="192" rx="10" fill="${c}" opacity="0.06"/>
  <rect x="96" y="64" width="300" height="192" rx="10" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.35"/>
  <rect x="124" y="88" width="300" height="192" rx="10" fill="${c}" opacity="0.06"/>
  <rect x="124" y="88" width="300" height="192" rx="10" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.35"/>
  <rect x="152" y="112" width="300" height="192" rx="10" fill="#ffffff" opacity="0.4"/>
  <rect x="152" y="112" width="300" height="192" rx="10" fill="none" stroke="${c}" stroke-width="3.5" opacity="0.7"/>
  <circle cx="404" cy="156" r="18" fill="${c}" opacity="0.5"/>
  <path d="M 168 250 C 210 216 250 252 296 222 C 340 194 380 224 436 198" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" opacity="0.55"/>
  <path d="M 168 282 C 214 254 258 284 306 258 C 348 236 388 260 436 240" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round" opacity="0.35"/>`;
}

function mWfsService(c: string): string {
  return `<path d="M 152 62 L 206 101 L 185 165 L 119 165 L 98 101 Z" fill="${c}" opacity="0.2"/>
  <path d="M 152 62 L 206 101 L 185 165 L 119 165 L 98 101 Z" fill="none" stroke="${c}" stroke-width="3.5" stroke-linejoin="round" opacity="0.7"/>
  <polyline points="150,232 220,268 290,236 372,290" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  <circle cx="150" cy="232" r="7" fill="#ffffff" stroke="${c}" stroke-width="3.5"/>
  <circle cx="290" cy="236" r="7" fill="#ffffff" stroke="${c}" stroke-width="3.5"/>
  <circle cx="372" cy="112" r="11" fill="${c}" opacity="0.85"/>
  <circle cx="422" cy="164" r="8" fill="${c}" opacity="0.6"/>
  <circle cx="330" cy="150" r="6" fill="${c}" opacity="0.45"/>`;
}

function mGeocodingService(c: string): string {
  return `<circle cx="230" cy="168" r="88" fill="none" stroke="${c}" stroke-width="3" opacity="0.35"/>
  <line x1="230" y1="52" x2="230" y2="96" stroke="${c}" stroke-width="3" opacity="0.35"/>
  <line x1="230" y1="240" x2="230" y2="284" stroke="${c}" stroke-width="3" opacity="0.35"/>
  <line x1="114" y1="168" x2="158" y2="168" stroke="${c}" stroke-width="3" opacity="0.35"/>
  <line x1="302" y1="168" x2="346" y2="168" stroke="${c}" stroke-width="3" opacity="0.35"/>
  <circle cx="230" cy="152" r="36" fill="${c}" opacity="0.85"/>
  <path d="M 205 178 L 230 232 L 255 178 Z" fill="${c}" opacity="0.85"/>
  <circle cx="230" cy="152" r="13" fill="#ffffff" opacity="0.95"/>
  <rect x="366" y="140" width="128" height="12" rx="6" fill="${c}" opacity="0.45"/>
  <rect x="366" y="168" width="96" height="10" rx="5" fill="${c}" opacity="0.28"/>
  <rect x="366" y="194" width="110" height="10" rx="5" fill="${c}" opacity="0.28"/>`;
}

function mFolder(c: string): string {
  return `<path d="M 76 96 h 128 l 32 32 h 232 a 14 14 0 0 1 14 14 v 20 H 76 Z" fill="${c}" opacity="0.22"/>
  <path d="M 94 152 h 396 l -34 156 H 60 Z" fill="${c}" opacity="0.5"/>
  <path d="M 130 218 C 190 192 260 226 330 200 C 386 180 420 202 452 188" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="0.45"/>
  <circle cx="272" cy="248" r="16" fill="#ffffff" opacity="0.75"/>
  <path d="M 261 259 L 272 284 L 283 259 Z" fill="#ffffff" opacity="0.75"/>`;
}

function mPointCloud(c: string): string {
  let dots = '';
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 14; col += 1) {
      const x = 46 + col * 34 + (row % 2) * 17;
      if (x > 500) continue;
      const wave = Math.sin(col * 0.55 + row * 0.9);
      const y = 64 + row * 38 + wave * 10;
      const r = (2.4 + 2.6 * Math.abs(Math.sin(col * 1.3 + row * 0.7))).toFixed(1);
      const o = (0.2 + 0.5 * Math.abs(Math.sin(col * 0.8 + row * 1.4))).toFixed(2);
      dots += `<circle cx="${x}" cy="${y.toFixed(0)}" r="${r}" fill="${c}" opacity="${o}"/>`;
    }
  }
  return dots;
}

const MOTIFS: Record<string, (c: string) => string> = {
  map: mMap,
  basemap: mBasemap,
  geo_boundary: mGeoBoundary,
  derived_layer: mDerivedLayer,
  tile_layer: mTileLayer,
  layer_package: mLayerPackage,
  data_layer: mDataLayer,
  pick_list: mPickList,
  form: mForm,
  form_submission_collection: mFormSubmissions,
  report_template: mReportTemplate,
  file: mFile,
  print_template: mPrintTemplate,
  web_app: mWebApp,
  app_template: mAppTemplate,
  dashboard: mDashboard,
  widget_package: mWidgetPackage,
  editor: mEditor,
  data_collection: mDataCollection,
  theme: mTheme,
  tool: mTool,
  service: mService,
  arcgis_service: mArcgisService,
  wms_service: mWmsService,
  wfs_service: mWfsService,
  geocoding_service: mGeocodingService,
  folder: mFolder,
  point_cloud: mPointCloud,
};

// Per-type [tx, ty, scale] that fits each motif inside the open area left
// by the chrome (sidebar x>=530, title bar y>=310) with ~26px padding,
// centered at (265, 155). Applied as translate(tx ty) scale(s).
const FIT: Record<string, [number, number, number]> = {
  map: [35.2, -14.3, 0.938], basemap: [25.2, -6.1, 0.959], geo_boundary: [0.2, -13.5, 0.963],
  derived_layer: [32.7, -10.1, 0.902], tile_layer: [-15, -19, 1], layer_package: [16.7, -27.4, 0.97],
  data_layer: [37.1, 8.8, 0.86], pick_list: [-2, -20, 1], form: [16.8, -25.2, 0.985],
  form_submission_collection: [12, -21, 1], report_template: [35.2, -0.6, 0.884], file: [-13.4, -12.8, 0.97],
  print_template: [-1, -21, 1], web_app: [10.7, -16.1, 0.956], app_template: [10.7, -16.1, 0.956],
  dashboard: [-4.7, -22.8, 0.977], widget_package: [-5, -29.5, 1], editor: [-40, -25, 1],
  data_collection: [-0.2, 1.3, 0.878], theme: [3, -21, 1], tool: [40.2, 0.5, 0.878],
  service: [-1, -26.5, 1], arcgis_service: [-25, -28, 1], wms_service: [-9, -29, 1],
  wfs_service: [2.5, -23.5, 1], geocoding_service: [-37.5, -13, 1], folder: [-17, -47, 1],
  point_cloud: [-8, -23, 1],
};

/** Render the background motif markup for an item type, centered with
 *  padding in the open area beside the sidebar strip and above the title
 *  bar. `hue` must be XML-escaped by the caller. */
function renderMotif(type: string, hue: string): string {
  const fn = MOTIFS[type];
  if (!fn) return '';
  const [tx, ty, s] = FIT[type] ?? [0, 0, 1];
  return `<g transform="translate(${tx} ${ty}) scale(${s})">${fn(hue)}</g>`;
}
export function renderThumbnailSvg(args: {
  title: string;
  /** Resolved type label (e.g. via getItemTypeLabel(type)). */
  typeLabel: string;
  design: ThumbnailDesign;
  /** Raw item type; enables the type-keyed background motif when no
   *  background image is set. Optional for callers that predate it. */
  type?: string;
}): string {
  const { title, typeLabel, design, type } = args;
  const label = design.sidebarLabelOverride ?? typeLabel;

  // Effective opacities + colors with sensible fallbacks so older
  // rows without the new fields still render.
  const bgImageOpacity = clamp01(design.backgroundOpacity ?? 1);
  const sidebarOpacity = clamp01(design.sidebarOpacity ?? 0.95);
  const titleBarColor = design.titleBar ?? design.sidebar;
  const titleBarOpacity = clamp01(design.titleBarOpacity ?? 0.8);

  // Layout: right-side sidebar so the AGO-template look feels
  // familiar to authors coming from there.
  const W = 600;
  const H = 400;
  const sidebarWidth = 70;
  const sidebarX = W - sidebarWidth;
  const titleBarHeight = 90;
  const titleBarY = H - titleBarHeight;
  const titleAreaLeft = 24;
  const titleAreaWidth = sidebarX - titleAreaLeft - 24;

  // Title color reads on the title bar, not the bare background,
  // so contrast picks against the bar's effective tint.
  const titleColor = pickContrastColor(titleBarColor);
  const labelColor = pickContrastColor(design.sidebar);

  const { lines, fontSize } = wrapTitle(title, titleAreaWidth, titleBarHeight);
  const lineHeight = fontSize * 1.15;
  const blockHeight = lineHeight * lines.length;
  // Vertically center the title block inside the title bar.
  const blockTop =
    titleBarY + (titleBarHeight - blockHeight) / 2 + fontSize * 0.82;

  // Logo position: top-left corner of the main area, with comfortable
  // padding.  64x64 max; the <image> preserves aspect ratio.
  const logoSize = 88;
  const logoX = 20;
  const logoY = 20;

  // Rotated type label: anchor on the sidebar center, rotate -90
  // around that anchor so the text runs from bottom to top.  Bumps
  // the font size a touch since the label is the primary affordance
  // on the sidebar.
  const labelSize = 22;
  const labelCx = sidebarX + sidebarWidth / 2;
  // Center vertically within the part of the sidebar that's not
  // covered by the title bar so the label doesn't collide with it.
  const labelCy = (titleBarY) / 2 + 30;

  const bgImageHref = design.backgroundImage;
  const logoHref = design.logo;

  // Motif renders only on bare backgrounds: an image already fills
  // the space, and layering a pattern under a translucent image
  // muddies both.

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeXml(label)}: ${escapeXml(title)}">
  <rect width="${W}" height="${H}" fill="${escapeXml(design.background)}"/>
  ${!bgImageHref && type ? renderMotif(type, escapeXml(design.sidebar)) : ''}
  ${
    bgImageHref
      ? `<image href="${escapeXml(bgImageHref)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" opacity="${bgImageOpacity}"/>`
      : ''
  }
  <rect x="0" y="${titleBarY}" width="${W}" height="${titleBarHeight}" fill="${escapeXml(titleBarColor)}" fill-opacity="${titleBarOpacity}"/>
  <rect x="${sidebarX}" y="0" width="${sidebarWidth}" height="${H}" fill="${escapeXml(design.sidebar)}" fill-opacity="${sidebarOpacity}"/>
  ${
    logoHref
      ? `<image href="${escapeXml(logoHref)}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`
      : ''
  }
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${titleColor}" font-weight="700">
    ${lines
      .map(
        (line, i) =>
          `<text x="${titleAreaLeft}" y="${blockTop + i * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`,
      )
      .join('\n    ')}
  </g>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${labelColor}" font-weight="600" letter-spacing="0.08em">
    <text x="${labelCx}" y="${labelCy}" font-size="${labelSize}" text-anchor="middle" transform="rotate(-90 ${labelCx} ${labelCy})">${escapeXml(label.toUpperCase())}</text>
  </g>
</svg>`;
}

function clamp01(v: unknown): number {
  // Accept `unknown` (not `number`): the thumbnailDesign blob is
  // a Prisma JSON column whose runtime type is unenforced. A
  // non-numeric value here would otherwise flow straight into SVG
  // attribute values and let an attacker break out of the attribute
  // ("0.5/><script>"). Coerce to a real number; non-finite, non-
  // numeric, and out-of-range values collapse to safe defaults
  // (CodeQL js/html-constructed-from-input).
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Word-wrap the title across up to two lines (the title bar is
 * deliberately short so the title doesn't tower over the background
 * image).  Picks the largest font that fits in the available width
 * and line count.  Character widths are estimated at ~0.55 em for
 * the system stack; close enough for layout without a real font-
 * metrics lookup.
 */
function wrapTitle(
  title: string,
  maxWidthPx: number,
  maxHeightPx: number,
): { lines: string[]; fontSize: number } {
  const cleaned = title.trim() || '(Untitled)';
  // Cap lines so the title fits in the bar: roughly fontSize * 1.15 *
  // lines <= maxHeightPx, with a 1.6 padding factor.
  for (const fontSize of [34, 30, 26, 22, 20, 18]) {
    const approxCharWidth = fontSize * 0.55;
    const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
    const lines = greedyWrap(cleaned, maxChars);
    const blockHeight = fontSize * 1.15 * lines.length;
    if (lines.length <= 2 && blockHeight <= maxHeightPx - 12) {
      return { lines, fontSize };
    }
  }
  // Title is huge; truncate to 2 lines at the smallest font.
  const fontSize = 16;
  const approxCharWidth = fontSize * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
  const lines = greedyWrap(cleaned, maxChars).slice(0, 2);
  const last = lines[lines.length - 1];
  if (last && last.length > 3) {
    lines[lines.length - 1] = last.slice(0, maxChars - 1) + '…';
  }
  return { lines, fontSize };
}

function greedyWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/);
  let cur = '';
  for (const w of words) {
    // Single word longer than the line: hard-break it.
    if (w.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      for (let i = 0; i < w.length; i += maxChars) {
        const chunk = w.slice(i, i + maxChars);
        if (i + maxChars >= w.length) {
          cur = chunk;
        } else {
          out.push(chunk);
        }
      }
      continue;
    }
    const candidate = cur ? cur + ' ' + w : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
    } else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Pick a high-contrast text color (near-black or near-white) for
 * the given background fill.  Parses #rgb / #rrggbb / rgb() / hsl()
 * just well enough to estimate luminance; anything we don't
 * recognize falls through to dark text since most defaults are
 * light-tinted.
 */
function pickContrastColor(bg: string): string {
  const lum = estimateLuminance(bg);
  return lum > 0.55 ? '#0f172a' : '#f8fafc';
}

function estimateLuminance(color: string): number {
  const c = color.trim().toLowerCase();
  // #rgb
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (m) {
    const r = parseInt(m[1]! + m[1]!, 16) / 255;
    const g = parseInt(m[2]! + m[2]!, 16) / 255;
    const b = parseInt(m[3]! + m[3]!, 16) / 255;
    return relLum(r, g, b);
  }
  // #rrggbb
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(c);
  if (m) {
    const r = parseInt(m[1]!, 16) / 255;
    const g = parseInt(m[2]!, 16) / 255;
    const b = parseInt(m[3]!, 16) / 255;
    return relLum(r, g, b);
  }
  // rgb(r, g, b)
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (m) {
    return relLum(
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
    );
  }
  // hsl(h, s%, l%) -- use l directly as a luminance proxy.
  //
  // Parsed by hand rather than with a single regex. The old regex
  // had three `\d+(?:\.\d+)?` runs separated by optional commas and
  // CodeQL flagged it as polynomial-redos: adversarial inputs like
  // 'hsl(0000000000...' would let the engine try many `\d+` /
  // optional-fraction splits. Splitting on the structural characters
  // is O(n) and rejects malformed inputs cleanly.
  if (c.startsWith('hsl(') || c.startsWith('hsla(')) {
    const open = c.indexOf('(');
    const close = c.indexOf(')', open + 1);
    if (open > 0 && close > open) {
      const parts = c.slice(open + 1, close).split(',');
      const lRaw = parts[2]?.trim().replace(/%$/, '');
      if (lRaw && /^-?\d+(\.\d+)?$/.test(lRaw)) {
        const l = Number(lRaw);
        if (Number.isFinite(l)) return l / 100;
      }
    }
  }
  return 0.7;
}

function relLum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

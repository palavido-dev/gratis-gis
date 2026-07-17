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
 * Type-keyed background motifs (#173). When a thumbnail has no
 * background image, the bare fill used to read as unfinished next to
 * basemap items (which derive a real map tile). Each type family gets
 * a subtle deterministic vector motif drawn in the sidebar hue at low
 * opacity: contours for map-shaped things, a dot grid for data,
 * document rules for forms and files, panel blocks for apps, a node
 * graph for tools and services, and a folder silhouette for folders.
 * Deterministic on purpose: no randomness, so renders are stable and
 * cacheable.
 */
type MotifKind = 'contour' | 'dots' | 'rules' | 'panels' | 'nodes' | 'folder';

const MOTIF_BY_TYPE: Record<string, MotifKind> = {
  map: 'contour',
  basemap: 'contour',
  geo_boundary: 'contour',
  derived_layer: 'contour',
  tile_layer: 'contour',
  layer_package: 'contour',
  data_layer: 'dots',
  pick_list: 'dots',
  form: 'rules',
  form_submission_collection: 'rules',
  report_template: 'rules',
  file: 'rules',
  print_template: 'rules',
  web_app: 'panels',
  app_template: 'panels',
  dashboard: 'panels',
  widget_package: 'panels',
  editor: 'panels',
  data_collection: 'panels',
  theme: 'panels',
  tool: 'nodes',
  service: 'nodes',
  arcgis_service: 'nodes',
  wms_service: 'nodes',
  wfs_service: 'nodes',
  geocoding_service: 'nodes',
  folder: 'folder',
};

function renderMotif(kind: MotifKind, hue: string): string {
  const c = escapeXml(hue);
  switch (kind) {
    case 'contour':
      return `<g fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" opacity="0.14">
    <path d="M-20 250 C 90 200 150 260 260 215 C 370 175 420 235 550 190"/>
    <path d="M-20 200 C 90 150 160 205 265 165 C 375 128 430 185 550 140"/>
    <path d="M-20 150 C 95 105 165 155 270 118 C 380 82 435 135 550 92"/>
    <path d="M-20 100 C 100 60 170 105 275 72 C 385 40 440 88 550 48"/>
  </g>`;
    case 'dots': {
      const dots: string[] = [];
      for (let row = 0; row < 5; row += 1) {
        const y = 45 + row * 58;
        const offset = row % 2 === 0 ? 0 : 30;
        for (let col = 0; col < 9; col += 1) {
          const x = 40 + offset + col * 58;
          if (x > 505) continue;
          dots.push(`<circle cx="${x}" cy="${y}" r="5" fill="${c}"/>`);
        }
      }
      return `<g opacity="0.14">
    ${dots.join('\n    ')}
  </g>`;
    }
    case 'rules':
      return `<g stroke="${c}" stroke-linecap="round" opacity="0.14">
    <line x1="40" y1="58" x2="240" y2="58" stroke-width="12"/>
    <line x1="40" y1="112" x2="500" y2="112" stroke-width="6"/>
    <line x1="40" y1="152" x2="500" y2="152" stroke-width="6"/>
    <line x1="40" y1="192" x2="500" y2="192" stroke-width="6"/>
    <line x1="40" y1="232" x2="380" y2="232" stroke-width="6"/>
  </g>`;
    case 'panels':
      return `<g fill="${c}" opacity="0.12">
    <rect x="40" y="40" width="212" height="118" rx="14"/>
    <rect x="278" y="40" width="212" height="118" rx="14"/>
    <rect x="40" y="184" width="212" height="118" rx="14"/>
    <rect x="278" y="184" width="212" height="118" rx="14"/>
  </g>`;
    case 'nodes':
      return `<g opacity="0.14">
    <g stroke="${c}" stroke-width="5">
      <line x1="112" y1="92" x2="300" y2="198" />
      <line x1="300" y1="198" x2="152" y2="268" />
      <line x1="300" y1="198" x2="428" y2="92" />
    </g>
    <g fill="${c}">
      <circle cx="112" cy="92" r="26"/>
      <circle cx="300" cy="198" r="26"/>
      <circle cx="152" cy="268" r="20"/>
      <circle cx="428" cy="92" r="20"/>
    </g>
  </g>`;
    case 'folder':
      return `<g fill="${c}" opacity="0.12">
    <path d="M84 118 h118 l30 30 h204 a16 16 0 0 1 16 16 v122 a16 16 0 0 1 -16 16 H100 a16 16 0 0 1 -16 -16 z"/>
  </g>`;
  }
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
  const motifKind = !bgImageHref && type ? MOTIF_BY_TYPE[type] : undefined;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeXml(label)}: ${escapeXml(title)}">
  <rect width="${W}" height="${H}" fill="${escapeXml(design.background)}"/>
  ${motifKind ? renderMotif(motifKind, design.sidebar) : ''}
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

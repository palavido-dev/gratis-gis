// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Built-in starter print templates.  Seeded per-org by auth-sync so
 * every freshly-bootstrapped org has a sensible default set of
 * layouts the Print tool can pick from on day one.  Admins can edit
 * or delete them like any other item; deletion is sticky, mirroring
 * the app_template + theme starter model.
 *
 * Each starter is a tiny factory that returns a fresh
 * PrintTemplateData blueprint.  We avoid sharing a single object
 * reference across seeds so accidental mutation of one starter's
 * data after seed doesn't leak into the others.
 */

import type { PrintTemplateData } from './print-template.js';

export interface PrintTemplateStarter {
  /** Stable seedKind value written to the item row.  Used by the
   *  housekeeping "Restore starter print templates" action to
   *  re-create one without inserting duplicates. */
  kind: string;
  /** Display title for the seeded item. */
  label: string;
  /** Description shown on the item card + detail page. */
  description: string;
  /** Tags to attach to the seeded item.  `built-in` is always added
   *  by the seeder; this is for category tags ("portrait",
   *  "landscape", "compact"). */
  tags: string[];
  /** Factory that returns a fresh PrintTemplateData each call.
   *  Editing the template after seeding does NOT mutate this
   *  blueprint, so the housekeeping restore path is safe. */
  seed(): PrintTemplateData;
}

// ---- Common building blocks --------------------------------------

// Contour print colors (fixed hex; print is always on paper). These
// mirror the renderer defaults in the portal's print-theme so a
// freshly seeded starter matches what the renderer draws for elements
// that leave a color unset. Kept as literals here because
// shared-types cannot import portal-web's print-theme module.
const PRINT_INK = '#2b2620';
const PRINT_MUTED = '#7a7268';
const PRINT_HAIRLINE = '#d8d0c2';
const PRINT_HAIRLINE_STRONG = '#b7ae9f';
const PRINT_CARD = '#fffdf9';

/** Title parameter shared by every starter so the user can override
 *  the map title at print time. */
const TITLE_PARAM = {
  id: 'title',
  label: 'Map title',
  type: 'text' as const,
  defaultValue: 'Map Title',
};

const SUBTITLE_PARAM = {
  id: 'subtitle',
  label: 'Subtitle',
  type: 'text' as const,
  defaultValue: '',
};

const AUTHOR_PARAM = {
  id: 'author',
  label: 'Author',
  type: 'text' as const,
  defaultValue: '',
};

const PROJECT_PARAM = {
  id: 'project',
  label: 'Project',
  type: 'text' as const,
  defaultValue: '',
};

// ---- Letter portrait ---------------------------------------------

function letterPortrait(): PrintTemplateData {
  return {
    version: 1,
    paper: { size: 'letter', orientation: 'portrait', marginIn: 0.25 },
    parameters: [TITLE_PARAM, SUBTITLE_PARAM, AUTHOR_PARAM, PROJECT_PARAM],
    elements: [
      // Title block at top
      {
        id: 'title-text',
        kind: 'text',
        box: { x: 0.5, y: 0.4, w: 7.5, h: 0.5 },
        segments: [{ kind: 'binding', source: 'parameter', tokenId: 'title' }],
        fontSizePt: 22,
        fontWeight: 'bold',
        align: 'left',
      },
      // Subtitle just below
      {
        id: 'subtitle-text',
        kind: 'text',
        box: { x: 0.5, y: 0.95, w: 7.5, h: 0.3 },
        segments: [
          { kind: 'binding', source: 'parameter', tokenId: 'subtitle' },
        ],
        fontSizePt: 12,
        color: PRINT_MUTED,
        align: 'left',
      },
      // Map fills the body
      {
        id: 'map',
        kind: 'map',
        box: { x: 0.5, y: 1.4, w: 7.5, h: 8.2 },
        border: { widthPt: 0.75, color: PRINT_HAIRLINE_STRONG },
        grid: 'none',
      },
      // Scalebar lower-left
      {
        id: 'scalebar',
        kind: 'scalebar',
        box: { x: 0.5, y: 9.75, w: 2.5, h: 0.4 },
        style: 'bar',
        units: 'imperial',
      },
      // North arrow lower-right
      {
        id: 'north',
        kind: 'north-arrow',
        box: { x: 7.4, y: 9.7, w: 0.6, h: 0.6 },
        style: 'compass',
      },
      // Title-block separator line
      {
        id: 'sep',
        kind: 'line',
        box: { x: 0.5, y: 10.3, w: 7.5, h: 0.02 },
        thicknessPt: 0.75,
        color: PRINT_HAIRLINE,
      },
      // Author + project + date in footer
      {
        id: 'footer-left',
        kind: 'text',
        box: { x: 0.5, y: 10.4, w: 4.5, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'Project: ' },
          { kind: 'binding', source: 'parameter', tokenId: 'project' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'footer-right',
        kind: 'text',
        box: { x: 5.0, y: 10.4, w: 3.0, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'By ' },
          { kind: 'binding', source: 'parameter', tokenId: 'author' },
          { kind: 'literal', text: '  ·  ' },
          { kind: 'binding', source: 'dynamic', tokenId: 'today_date' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'right',
      },
    ],
  };
}

// ---- Letter landscape --------------------------------------------

function letterLandscape(): PrintTemplateData {
  return {
    version: 1,
    paper: { size: 'letter', orientation: 'landscape', marginIn: 0.25 },
    parameters: [TITLE_PARAM, SUBTITLE_PARAM, AUTHOR_PARAM, PROJECT_PARAM],
    elements: [
      {
        id: 'title-text',
        kind: 'text',
        box: { x: 0.5, y: 0.4, w: 10, h: 0.5 },
        segments: [{ kind: 'binding', source: 'parameter', tokenId: 'title' }],
        fontSizePt: 22,
        fontWeight: 'bold',
        align: 'left',
      },
      {
        id: 'subtitle-text',
        kind: 'text',
        box: { x: 0.5, y: 0.95, w: 10, h: 0.3 },
        segments: [
          { kind: 'binding', source: 'parameter', tokenId: 'subtitle' },
        ],
        fontSizePt: 12,
        color: PRINT_MUTED,
        align: 'left',
      },
      // Map fills the body
      {
        id: 'map',
        kind: 'map',
        box: { x: 0.5, y: 1.4, w: 10, h: 5.6 },
        border: { widthPt: 0.75, color: PRINT_HAIRLINE_STRONG },
        grid: 'none',
      },
      {
        id: 'scalebar',
        kind: 'scalebar',
        box: { x: 0.5, y: 7.15, w: 2.5, h: 0.4 },
        style: 'bar',
        units: 'imperial',
      },
      {
        id: 'north',
        kind: 'north-arrow',
        box: { x: 9.9, y: 7.1, w: 0.6, h: 0.6 },
        style: 'compass',
      },
      {
        id: 'sep',
        kind: 'line',
        box: { x: 0.5, y: 7.7, w: 10, h: 0.02 },
        thicknessPt: 0.75,
        color: PRINT_HAIRLINE,
      },
      {
        id: 'footer-left',
        kind: 'text',
        box: { x: 0.5, y: 7.8, w: 6, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'Project: ' },
          { kind: 'binding', source: 'parameter', tokenId: 'project' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'footer-right',
        kind: 'text',
        box: { x: 6.5, y: 7.8, w: 4, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'By ' },
          { kind: 'binding', source: 'parameter', tokenId: 'author' },
          { kind: 'literal', text: '  ·  ' },
          { kind: 'binding', source: 'dynamic', tokenId: 'today_date' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'right',
      },
    ],
  };
}

// ---- Letter landscape with large legend pane ---------------------

function letterLandscapeLargeLegend(): PrintTemplateData {
  return {
    version: 1,
    paper: { size: 'letter', orientation: 'landscape', marginIn: 0.25 },
    parameters: [TITLE_PARAM, SUBTITLE_PARAM, AUTHOR_PARAM, PROJECT_PARAM],
    elements: [
      {
        id: 'title-text',
        kind: 'text',
        box: { x: 0.5, y: 0.4, w: 10, h: 0.5 },
        segments: [{ kind: 'binding', source: 'parameter', tokenId: 'title' }],
        fontSizePt: 22,
        fontWeight: 'bold',
        align: 'left',
      },
      {
        id: 'subtitle-text',
        kind: 'text',
        box: { x: 0.5, y: 0.95, w: 10, h: 0.3 },
        segments: [
          { kind: 'binding', source: 'parameter', tokenId: 'subtitle' },
        ],
        fontSizePt: 12,
        color: PRINT_MUTED,
        align: 'left',
      },
      // Map takes left ~70% of the body
      {
        id: 'map',
        kind: 'map',
        box: { x: 0.5, y: 1.4, w: 7.2, h: 5.6 },
        border: { widthPt: 0.75, color: PRINT_HAIRLINE_STRONG },
      },
      // Legend column on the right
      {
        id: 'legend',
        kind: 'legend',
        box: { x: 7.9, y: 1.4, w: 2.6, h: 5.6 },
        title: 'Legend',
        fontSizePt: 9,
        border: { widthPt: 0.5, color: PRINT_HAIRLINE },
        backgroundColor: PRINT_CARD,
      },
      {
        id: 'scalebar',
        kind: 'scalebar',
        box: { x: 0.5, y: 7.15, w: 2.5, h: 0.4 },
        style: 'bar',
        units: 'imperial',
      },
      {
        id: 'north',
        kind: 'north-arrow',
        box: { x: 7.1, y: 7.1, w: 0.6, h: 0.6 },
        style: 'compass',
      },
      {
        id: 'sep',
        kind: 'line',
        box: { x: 0.5, y: 7.7, w: 10, h: 0.02 },
        thicknessPt: 0.75,
        color: PRINT_HAIRLINE,
      },
      {
        id: 'footer-left',
        kind: 'text',
        box: { x: 0.5, y: 7.8, w: 6, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'Project: ' },
          { kind: 'binding', source: 'parameter', tokenId: 'project' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'footer-right',
        kind: 'text',
        box: { x: 6.5, y: 7.8, w: 4, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'By ' },
          { kind: 'binding', source: 'parameter', tokenId: 'author' },
          { kind: 'literal', text: '  ·  ' },
          { kind: 'binding', source: 'dynamic', tokenId: 'today_date' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'right',
      },
    ],
  };
}

// ---- Tabloid landscape (big presentation) ------------------------

function tabloidLandscape(): PrintTemplateData {
  return {
    version: 1,
    paper: { size: 'tabloid', orientation: 'landscape', marginIn: 0.5 },
    parameters: [TITLE_PARAM, SUBTITLE_PARAM, AUTHOR_PARAM, PROJECT_PARAM],
    elements: [
      {
        id: 'title-text',
        kind: 'text',
        box: { x: 0.5, y: 0.4, w: 16, h: 0.6 },
        segments: [{ kind: 'binding', source: 'parameter', tokenId: 'title' }],
        fontSizePt: 32,
        fontWeight: 'bold',
        align: 'left',
      },
      {
        id: 'subtitle-text',
        kind: 'text',
        box: { x: 0.5, y: 1.05, w: 16, h: 0.4 },
        segments: [
          { kind: 'binding', source: 'parameter', tokenId: 'subtitle' },
        ],
        fontSizePt: 16,
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'map',
        kind: 'map',
        box: { x: 0.5, y: 1.7, w: 12.5, h: 9 },
        border: { widthPt: 0.75, color: PRINT_HAIRLINE_STRONG },
      },
      {
        id: 'legend',
        kind: 'legend',
        box: { x: 13.3, y: 1.7, w: 2.7, h: 6 },
        title: 'Legend',
        fontSizePt: 10,
        border: { widthPt: 0.5, color: PRINT_HAIRLINE },
      },
      {
        id: 'scalebar',
        kind: 'scalebar',
        box: { x: 0.5, y: 10.85, w: 3, h: 0.4 },
        style: 'bar',
        units: 'imperial',
      },
      {
        id: 'north',
        kind: 'north-arrow',
        box: { x: 12.4, y: 10.8, w: 0.6, h: 0.6 },
        style: 'compass',
      },
      {
        id: 'sep',
        kind: 'line',
        box: { x: 0.5, y: 11.4, w: 16, h: 0.02 },
        thicknessPt: 0.75,
        color: PRINT_HAIRLINE,
      },
      {
        id: 'footer-left',
        kind: 'text',
        box: { x: 0.5, y: 11.5, w: 10, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'Project: ' },
          { kind: 'binding', source: 'parameter', tokenId: 'project' },
        ],
        fontSizePt: 10,
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'footer-right',
        kind: 'text',
        box: { x: 11, y: 11.5, w: 5.5, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'By ' },
          { kind: 'binding', source: 'parameter', tokenId: 'author' },
          { kind: 'literal', text: '  ·  ' },
          { kind: 'binding', source: 'dynamic', tokenId: 'today_date' },
        ],
        fontSizePt: 10,
        color: PRINT_MUTED,
        align: 'right',
      },
    ],
  };
}

// ---- Field summary (Letter portrait, compact field-tech layout) --

function fieldSummary(): PrintTemplateData {
  return {
    version: 1,
    paper: { size: 'letter', orientation: 'portrait', marginIn: 0.25 },
    parameters: [
      TITLE_PARAM,
      AUTHOR_PARAM,
      { id: 'site', label: 'Site / Project', type: 'text', defaultValue: '' },
      { id: 'notes', label: 'Notes', type: 'longtext', defaultValue: '' },
    ],
    elements: [
      {
        id: 'title-text',
        kind: 'text',
        box: { x: 0.5, y: 0.4, w: 7.5, h: 0.5 },
        segments: [{ kind: 'binding', source: 'parameter', tokenId: 'title' }],
        fontSizePt: 18,
        fontWeight: 'bold',
        align: 'left',
      },
      {
        id: 'site-text',
        kind: 'text',
        box: { x: 0.5, y: 0.95, w: 7.5, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'Site: ' },
          { kind: 'binding', source: 'parameter', tokenId: 'site' },
        ],
        fontSizePt: 11,
        color: PRINT_MUTED,
        align: 'left',
      },
      // Map at top half
      {
        id: 'map',
        kind: 'map',
        box: { x: 0.5, y: 1.4, w: 7.5, h: 5 },
        border: { widthPt: 0.75, color: PRINT_HAIRLINE_STRONG },
      },
      // Scalebar + north
      {
        id: 'scalebar',
        kind: 'scalebar',
        box: { x: 0.5, y: 6.55, w: 2.5, h: 0.4 },
        style: 'bar',
        units: 'imperial',
      },
      {
        id: 'north',
        kind: 'north-arrow',
        box: { x: 7.4, y: 6.5, w: 0.6, h: 0.6 },
        style: 'compass',
      },
      // Legend
      {
        id: 'legend',
        kind: 'legend',
        box: { x: 0.5, y: 7.2, w: 3.5, h: 2 },
        title: 'Legend',
        fontSizePt: 9,
        border: { widthPt: 0.5, color: PRINT_HAIRLINE },
      },
      // Notes box on the right
      {
        id: 'notes-frame',
        kind: 'rectangle',
        box: { x: 4.2, y: 7.2, w: 3.8, h: 2 },
        border: { widthPt: 0.5, color: PRINT_HAIRLINE },
      },
      {
        id: 'notes-label',
        kind: 'text',
        box: { x: 4.3, y: 7.25, w: 3.6, h: 0.25 },
        segments: [{ kind: 'literal', text: 'Notes' }],
        fontSizePt: 9,
        fontWeight: 'bold',
        color: PRINT_MUTED,
        align: 'left',
      },
      {
        id: 'notes-body',
        kind: 'text',
        box: { x: 4.3, y: 7.55, w: 3.6, h: 1.6 },
        segments: [
          { kind: 'binding', source: 'parameter', tokenId: 'notes' },
        ],
        fontSizePt: 9,
        color: PRINT_INK,
        align: 'left',
        vAlign: 'top',
      },
      // Footer line + meta
      {
        id: 'sep',
        kind: 'line',
        box: { x: 0.5, y: 10.3, w: 7.5, h: 0.02 },
        thicknessPt: 0.75,
        color: PRINT_HAIRLINE,
      },
      {
        id: 'footer-right',
        kind: 'text',
        box: { x: 0.5, y: 10.4, w: 7.5, h: 0.3 },
        segments: [
          { kind: 'literal', text: 'By ' },
          { kind: 'binding', source: 'parameter', tokenId: 'author' },
          { kind: 'literal', text: '  ·  ' },
          { kind: 'binding', source: 'dynamic', tokenId: 'today_date' },
        ],
        fontSizePt: 9,
        color: PRINT_MUTED,
        align: 'right',
      },
    ],
  };
}

export const PRINT_TEMPLATE_STARTERS: readonly PrintTemplateStarter[] = [
  {
    kind: 'letter-portrait',
    label: 'Letter portrait',
    description: 'Standard 8.5x11 portrait layout with title, map, scalebar, north arrow, and footer.',
    tags: ['letter', 'portrait'],
    seed: letterPortrait,
  },
  {
    kind: 'letter-landscape',
    label: 'Letter landscape',
    description: 'Standard 8.5x11 landscape layout with title, map, scalebar, north arrow, and footer.',
    tags: ['letter', 'landscape'],
    seed: letterLandscape,
  },
  {
    kind: 'letter-landscape-large-legend',
    label: 'Letter landscape with large legend',
    description: 'Letter landscape with a generous legend column for legend-heavy maps.',
    tags: ['letter', 'landscape', 'legend'],
    seed: letterLandscapeLargeLegend,
  },
  {
    kind: 'tabloid-landscape',
    label: 'Tabloid landscape',
    description: '11x17 landscape for presentation-quality prints with title, map, legend, and footer.',
    tags: ['tabloid', 'landscape', 'presentation'],
    seed: tabloidLandscape,
  },
  {
    kind: 'field-summary',
    label: 'Field summary',
    description: 'Letter portrait with map, legend, and a notes box for in-the-field documentation.',
    tags: ['letter', 'portrait', 'field'],
    seed: fieldSummary,
  },
];

export function getPrintTemplateStarter(kind: string): PrintTemplateStarter | null {
  return PRINT_TEMPLATE_STARTERS.find((s) => s.kind === kind) ?? null;
}

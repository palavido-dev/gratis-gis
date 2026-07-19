// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Contour print palette, shared by the print preview
 * (print-preview/[templateId]/print-renderer.tsx) and the PDF render
 * path (print/[templateId]/print-render-client.tsx) so the two never
 * drift.
 *
 * Print is always rendered on paper regardless of the app or portal
 * theme, so these are fixed light-mode hex values derived from the
 * Contour tokens in globals.css, not CSS variables. They are only
 * DEFAULTS: an author who sets an element's own color or font still
 * wins. The font leads with the portal sans (Inter, loaded by the
 * root layout that wraps the print pages) so print stops defaulting to
 * Arial.
 */
export const PRINT_FONT =
  "var(--font-sans), 'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
/** Warm charcoal, softer than pure black. */
export const PRINT_INK = '#2b2620';
/** Warm gray for secondary text. */
export const PRINT_MUTED = '#7a7268';
/** Warm hairline border. */
export const PRINT_HAIRLINE = '#d8d0c2';
export const PRINT_HAIRLINE_STRONG = '#b7ae9f';
/** Deep sage accent. */
export const PRINT_SAGE = '#586b5b';
export const PRINT_SAGE_DEEP = '#3f4d41';
/** Warm paper for placeholders and alternating fills. */
export const PRINT_PAPER = '#faf8f2';
export const PRINT_CARD = '#fffdf9';

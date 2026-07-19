# App and Print Polish: Audit (2026-07-18)

Grounding for the app + print revamp. Covers the three app runtimes
(custom, viewer, editor) and the print-template system. The goal of
this pass is to move these surfaces from "clearly open source" to
"professional grade." The backend is strong; these front ends are
what a first-time visitor judges the whole project by.

This audit is deliberately specific: every finding names the file,
token, or default responsible, so the proposal that follows is
concrete rather than "make it nicer."

## The core problem, in one line

The app and print surfaces were built before the Contour rebrand
and never got pulled forward. They still wear a generic blue-and-
cool-gray "default web app" skin (apps) and an Arial-and-indigo
"office clip art" skin (print), while the rest of the portal moved
to warm Contour earth tones, Geist type, and a considered surface
ladder. The gap between the polished portal shell and these
surfaces is exactly what reads as unfinished.

## Cross-cutting issues (these hit every surface)

### 1. The default app theme is the OLD portal palette
`packages/shared-types/src/app-themes.ts`, the `default` preset:
- `--app-accent: 221 83% 53%` is Tailwind blue-600 (#2563eb). That
  is the blue header in the "Randolph County explorer" screenshot.
- `--app-header-bg` is the same blue.
- Surfaces are cool gray (`210 25% 96%`), ink is cool navy
  (`222 47% 11%`).
- Its description literally says "Portal-matching neutral palette."
  It matched the portal a rebrand ago. It no longer does.

Because it is the default AND the fallback for any unknown id, most
apps render blue-on-cool-gray out of the box. This single preset is
responsible for most of the "hokey" read.

Good news: the `forest` preset is already ~90% Contour (warm cream
surfaces at hue 45, sage accent `155 28% 38%`). The system is sound;
the defaults are pointed at the wrong preset.

### 2. Status and swatch colors are the generic Bootstrap set
Every theme reuses `--app-success: 142 72% 29%`, `--app-warn:
35 92% 50%`, `--app-danger: 0 72% 51%`, `--app-info: 199 89% 48%`.
These are the stock saturated primaries that scream "framework
defaults." They clash with the muted earth palette and pull the eye
for the wrong reasons. The categorical color ramp in the runtime
(`runtime-client.tsx:4227`) opens with `#2563eb, #16a34a, #d97706,
#9333ea, #dc2626`: pure blue/green/orange/purple/red, the same
saturated wheel the portal already moved away from on item cards.

### 3. Typography has no hierarchy or brand voice
- No `--app-font` token exists; apps inherit whatever the body sets.
  There is no way for a theme to carry a display face, so every app
  looks typographically identical and defaults to plain sans.
- Nothing in the app or print chrome uses weight/size/tracking to
  build hierarchy. Titles, tool labels, and body text sit at nearly
  the same visual weight, so nothing anchors the eye.
- Print hardcodes `Arial, sans-serif` in six places
  (`print-renderer.tsx:188, 314, 452, 521`, etc.). Arial is the
  single strongest "unstyled document" signal there is.

### 4. Chrome is flat and undifferentiated
The app shells are a flat colored bar over flat white panels with
1px borders. There is no surface ladder in practice (header, body,
cards, and popovers barely differ), no depth, no branded touches
(logo slot unused, no subtitle, no considered empty states). It
reads as a wireframe that got colored in rather than a designed
product.

### 5. Token inconsistency between app-theme and portal tokens
The custom runtime mixes `--app-*` themed tokens with raw portal
tokens (`bg-surface-1`, `border-border`) in the same shell (e.g.
`DockedBottomPopover` at `runtime-client.tsx:1362` uses
`bg-surface-1`/`border-border`, not the app tokens). So parts of an
app follow the chosen theme and parts follow the portal, which is
why a themed app can still have off-palette patches, and why the
layer-list text went invisible in one theme but not another. It is
a correctness bug as much as a polish bug.

## Surface 1: Custom app runtime (`custom/runtime-client.tsx`)

This is the worst offender and the one in the screenshot.
- Blue header + cool-gray body from the `default` theme (issue 1).
- Layer-list widget text is low-contrast to invisible because the
  widget uses portal tokens while the panel uses app tokens
  (issue 5); in the blue default the two disagree.
- No app title rendered in the runtime header (the seeded app left
  the app-bar title slot blank and the shell does not fall back to
  the item title in the banner).
- Widgets are flat cards with a small icon + title and a hairline
  border. No elevation, no section rhythm, generic.
- The geometry-aware legend swatch here (`runtime-client.tsx:1843`)
  is actually decent; keep it.

## Surface 2: Viewer + Editor app runtime (`editor/editor-runtime.tsx`, used by `viewer/run`)

Shared shell; more restrained than the custom app but still basic.
- Header is `bg-surface-1` with the title and a row of icon-only
  (`h-9 w-9`) tool buttons (`editor-runtime.tsx:2333+`). It is
  on-palette (uses portal tokens, so it inherited dark mode and
  Contour for free) but visually plain: icon-only tools with no
  labels or grouping, no product identity, no subtitle/branding.
- Panels slide in as plain white sheets with hairline borders and a
  small header; same flatness as the custom app.
- The labeled `Search / Basemaps / Attribute table / Print` toolbar
  the viewer surfaces has no visual grouping, spacing rhythm, or
  active-state design; it is a row of text buttons.

The viewer/editor are closer to acceptable than the custom app, so
the lift here is refinement (type, spacing, grouping, an identity
strip), not a reskin.

## Surface 3: Print templates (`print-preview/[templateId]/print-renderer.tsx` + `print/[templateId]/print-render-client.tsx`)

Print is the surface most likely to be handed to an outside
stakeholder as a PDF, and it looks the most like a 2005 GIS export.
- `Arial, sans-serif` hardcoded throughout (issue 3).
- Default element colors are generic: text `#1f2937`, muted
  `#6b7280`, borders `#888` / `#444`, panel fill `#f8fafc`, and the
  legend/point defaults are indigo `#6366f1` / `#4338ca`
  (`print-renderer.tsx:368, 392`). None of this is Contour.
- Legend: a bare list with an 11px bold "Legend" heading, hairline
  border, no card treatment, no title/subtitle. The swatch shaping
  (circle/line/square) is correct; the framing is not.
- Scale bar: an 8px black-bordered bar with 9px Arial labels
  (`print-renderer.tsx:452-463`). Functional, ugly.
- North arrow: an 18px Arial "N" over a basic SVG arrow.
- No cohesive title block: no standard header band with title +
  subtitle + org mark + date/attribution, no consistent margin
  system, no footer with source/credits. Each element is an
  independently floating box the author must place.

The print engine (puppeteer server render, designer-driven element
placement) is solid. What is missing is a designed default
template kit: title block, legend card, scale/north styling, and a
type + color system that isn't Arial-and-indigo.

## Contrast / accessibility bugs surfaced along the way

- Custom-app layer list text invisible in the default theme (token
  mix, issue 5). Real bug, not just taste.
- (Already fixed this session: dark-mode map popup contrast; not an
  app-runtime-only issue but it also affected app popups.)

## What "professional grade" will require (preview of the proposal)

1. Repoint the app `default` theme to Contour, and refit all five
   presets' status/ramp colors to the muted earth system. Add an
   `--app-font` token so themes can carry a voice.
2. Fix the token mix so the app chrome is 100% app-themed (kills the
   invisible-text bug and the off-palette patches).
3. Redesign the app chrome: a real branded header (logo slot, title,
   subtitle), a genuine surface ladder with considered elevation,
   grouped and labeled tools, refined panels, and designed empty +
   loading states.
4. A designed print template kit: Contour type and color, a proper
   title block, a legend card, and styled scale bar + north arrow,
   shipped as the new default so a fresh print looks finished.

Next step: a written proposal that turns each of these into specific
token values and component changes, then a live mockup of the
revamped app shell and a sample print layout for sign-off before any
implementation.

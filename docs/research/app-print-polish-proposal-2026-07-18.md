# App and Print Polish: Proposal (2026-07-18)

Turns the audit into specific token values and component changes.
Ordered so each phase ships and deploys on its own; the palette work
alone visibly fixes the demo, and everything after is refinement.

Design north star: the apps and print output should look like they
were made by the same team that made the Contour portal shell. Calm
warm-paper surfaces, a single deep-sage accent, one branded chrome
band, real type hierarchy, generous but not soft spacing. Restrained,
not decorated. The opposite of "framework defaults."

## Phase A: Refit the theme system to Contour

### A1. Rewrite the `default` app theme to mirror the portal
`packages/shared-types/src/app-themes.ts`. New `default` tokens
(bare HSL, matched to `globals.css` Contour):

```
--app-surface-0:     45 30% 96%     (page between widgets, warm paper)
--app-surface-1:     45 33% 99%     (widget card, bright warm white)
--app-surface-2:     45 22% 93%     (inputs, popovers)
--app-ink-0:         40 12% 13%
--app-ink-1:         40 12% 22%
--app-muted:         40 7% 44%
--app-border:        43 18% 87%
--app-accent:        124 8% 38%     (deep sage)
--app-accent-ink:    0 0% 100%
--app-accent-hover:  124 8% 31%
--app-header-bg:     124 12% 20%    (deep forest-sage banner = branded chrome)
--app-header-ink:    45 40% 96%     (cream)
--app-header-muted:  120 10% 72%
--app-header-border: 124 12% 14%
--app-success:       142 60% 30%
--app-warn:          33 85% 47%
--app-danger:        0 68% 49%
--app-info:          205 75% 42%
--app-radius:        0.5rem
--app-density:       1
```

Rationale for a deep-sage header band rather than a light one: the
audit's issue 4 is that the chrome doesn't read as a designed
product. A calm dark-sage banner with a cream wordmark gives every
app an instant identity and a clear surface ladder (dark header >
paper page > white cards), the way a polished portal app should,
without resorting to a saturated color.

### A2. Refit the other four presets' shared colors
Keep each preset's character (Slate = dark technical, Aurora = teal,
Forest = field cream, Paper = high-contrast print) but replace the
Bootstrap status quartet everywhere with the Contour-tuned set
(`success 142 60% 30%`, `warn 33 85% 47%`, `danger 0 68% 49%`,
`info 205 75% 42%`, lifted for the dark themes). `Forest` also
becomes the recommended "branded" pick and gets its accent nudged to
match portal sage exactly.

### A3. Add a typography token
Add `--app-font` to the `AppThemeTokens` interface and every preset.
Default and Forest use the portal stack (`Geist, ui-sans-serif,
system-ui, sans-serif`); Paper can use a print-appropriate stack.
The runtime applies it at the app root so themes finally carry a
voice. A later addition can offer a serif display option.

### A4. Repoint the seeded demo app + golden
Re-seed the custom explorer app on the `default` (now Contour) theme
and give it a title + subtitle so it stops rendering blue-and-
untitled. Refresh the golden so the demo reflects it.

## Phase B: Fix the token mix (correctness + palette patches)

Sweep the custom runtime so the app shell uses `--app-*` tokens
throughout instead of portal tokens. Concretely, the components
still on `bg-surface-1` / `border-border` (e.g. `DockedBottomPopover`
`runtime-client.tsx:1362`, and the layer-list widget body) move to
`bg-[hsl(var(--app-surface-1))]` / `border-[hsl(var(--app-border))]`.
This removes the off-palette patches and fixes the invisible layer-
list text by construction (the panel and its text will always come
from the same theme).

## Phase C: Redesign the app chrome

Applies to the custom runtime and the shared viewer/editor shell.

1. Branded header: left = logo slot (falls back to the Contour mark)
   + app title + optional subtitle; right = tools. Header uses the
   dark-sage band. When the author leaves the title blank, fall back
   to the item title instead of rendering an empty bar.
2. Tools: grouped and labeled (icon + short label) with a real
   active state (accent underline or filled pill), not an
   undifferentiated row of icon squares. Overflow collapses to a
   "More" menu.
3. Surface ladder + elevation: page = surface-0, widgets = surface-1
   cards with the theme shadow and `--app-radius`, popovers =
   surface-2. Give panels a consistent 12-16px internal rhythm and a
   titled header row.
4. Designed empty and loading states: a layer list with no layers, a
   search with no results, and initial map load get proper
   illustrated/skeleton states instead of bare text.
5. Legend/layer widgets keep the geometry-aware swatch (already
   good) but adopt the card + type treatment.

## Phase D: A designed print kit

`print-renderer.tsx` + the default template(s).

1. Type + color: replace hardcoded `Arial` with a print stack and
   swap the indigo/gray element defaults (`#6366f1`, `#1f2937`,
   `#888`, `#f8fafc`) for Contour equivalents (sage accents, warm
   ink `#2b2721`, warm borders). Print stays lighter than screen but
   in the same family.
2. Title block component: a standard header band (title + subtitle +
   org mark + date), a consistent page-margin system, and a footer
   with source/attribution + optional page number.
3. Legend as a card: bordered card with a titled header, tidy rows,
   and the existing correct swatch shaping.
4. Scale bar + north arrow restyle: a clean alternating-fill scale
   bar with refined labels, and a designed north mark, both in the
   Contour palette.
5. Ship these as the default layout kit and re-seed the demo print
   templates so a fresh print looks finished out of the box.

## Sequencing

A ships first (biggest visible win, low risk: data + token values).
B folds in with A or right after (fixes the real bug). C is the
larger design build, done on the custom runtime first, then the
shared viewer/editor shell. D is parallelizable and ends with new
default templates. Each phase is its own commit + deploy; the mockup
below previews A + C (app shell) and D (print) together.

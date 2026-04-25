# Design System

GratisGIS ships with a single, opinionated design system shared across the
portal, app builder, form designer, report builder, and field app. Every
surface must feel crafted and consistent. "Good enough" is not good enough.

## Principles

1. **Calm, confident, modern.** Ample whitespace, clear hierarchy, not
   noisy. Think Linear, Vercel, Notion, not dated enterprise admin consoles.
2. **Consistency across apps.** A user who's learned the portal should feel
   at home in the field app and the report builder on day one.
3. **Accessibility is table stakes.** Every component meets WCAG 2.2 AA;
   every interactive element has a visible focus state, proper ARIA, and
   keyboard support. We test with screen readers before shipping.
4. **Motion that informs, never distracts.** Short (120–240ms), purposeful,
   and always disabled when `prefers-reduced-motion` is set.
5. **Dark mode from day one.** Not an afterthought, not a toggle bolted on
   later. Every component has matched light and dark tokens.
6. **Empty, loading, error, and success states are non-optional.** No page
   ships with just a happy path.
7. **Visual, guided, or upload: never raw text-entry by default.** When
   a user needs to provide a non-trivial chunk of input (a polygon, a
   schema, a list of values, a URL, a palette, a set of rows), the
   primary surface must be a direct-manipulation or guided workflow:
   draw on a map, pick from a list, upload a file, choose an existing
   portal item, step through a wizard. Raw paste / typed-JSON / manual
   coordinate entry is an *advanced fallback* behind a disclosure
   present for power users and for cases the primary path can't handle,
   never the only way in. This rule applies uniformly: a polygon UI
   shows a map-draw first with "Paste GeoJSON" tucked under an advanced
   tab; a pick list shows "Add row / Upload CSV / Paste text" in that
   order; a service URL shows a searchable list of portal items before
   a URL input; a color shows a swatch picker before a hex field. If
   you catch yourself asking the user to type more than about 40
   characters of structured input by hand, stop and design a
   guided path first.

## Stack

- **Tailwind CSS**: utility-first, great velocity, predictable output
- **shadcn/ui**: component scaffold generated into our repo (not a locked
  npm dependency), so we own the code and can tune every pixel
- **Radix UI** primitives: a11y-correct dialogs, menus, popovers, tabs,
  tooltips, toasts (what shadcn/ui is built on)
- **lucide-react**: clean, consistent icon set
- **framer-motion**: motion system
- **Inter** (variable) for UI, **Geist Mono** for code/numbers
- **cmdk**: command palette (⌘K) across every app

## Design tokens

All tokens live in `packages/ui/src/tokens.css` as CSS custom properties
and in a Tailwind theme extension. Apps consume tokens, not raw values.

### Color

Semantic roles, not "blue-500":

```
--surface-0   / --surface-0-ink
--surface-1   / --surface-1-ink    // cards
--surface-2   / --surface-2-ink    // inputs, popovers
--muted       / --muted-ink
--accent      / --accent-ink       // primary brand
--success / --warn / --danger / --info
--focus-ring
```

Each has a paired `*-ink` (text color) that hits AA contrast by default.
Dark mode swaps them in one `.dark` block.

### Spacing

4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px (Tailwind `1 / 2 / 3 / 4 / 6 / 8 / 12 / 16`).
No freelance spacing: if you find yourself reaching for `m-[17px]`, a
token is wrong.

### Radii

`sm` 4px · `md` 8px · `lg` 12px · `xl` 16px · `full`.
Default for cards and inputs: `md`. Buttons: `md`. Avatars/pills: `full`.

### Typography scale

| token | size / line-height | use |
| --- | --- | --- |
| `display` | 48 / 56 | Home hero only |
| `h1` | 30 / 36 | Page title |
| `h2` | 24 / 32 | Section |
| `h3` | 18 / 28 | Sub-section |
| `body` | 14 / 22 | Default |
| `small` | 12 / 18 | Meta, captions |
| `mono` | 13 / 20 | Code, IDs, coordinates |

Fluid type up to `lg` breakpoints; fixed beyond.

### Elevation

Three shadow tokens: `shadow-card` (rested), `shadow-raised` (popover),
`shadow-overlay` (modal). No bespoke shadows in components.

## Component checklist

Every component we ship has:

- [ ] States: default, hover, focus, active, disabled, loading, error
- [ ] Dark-mode tokens
- [ ] Keyboard: tab order, enter/space/escape as appropriate
- [ ] Screen reader: role/label/description
- [ ] Visual regression snapshot (Storybook + Chromatic or Playwright)
- [ ] Motion respects `prefers-reduced-motion`

## App-level requirements

Every app ships with:

- A **navigation shell** (top bar + side nav), consistent across apps
- A **command palette** (⌘K / Ctrl-K) with routing + recent items
- **Loading skeletons**, not spinners, for initial data
- **Empty states** with an illustration + a single clear action
- **Toasts** for transient feedback (success, error, undo)
- **Confirmation dialogs** for destructive actions with a typed-name
  confirmation for high-impact ones (deleting a feature service, etc.)

## Map styling

Basemaps default to a light + dark pair we commission as
[Protomaps](https://protomaps.com/) themes so we don't rely on tile-provider
goodwill. Feature layer default styles use a curated 8-color categorical
palette + 5-step sequential ramp that work on both basemaps.

## What we won't do

- Dozens of buttons with subtle size/variant differences
- ASCII-art-style UI full of dividers and dense tables
- Modals inside modals
- Skeuomorphic gradients or drop-shadow blowouts

## Reviewing UI PRs

Reviewers must:

1. Read the diff.
2. Open the change locally (or Chromatic preview), try it with a keyboard
   only, then with a screen reader for a pass.
3. Toggle dark mode.
4. Resize the viewport to 360px wide.
5. Only approve if all four check out.

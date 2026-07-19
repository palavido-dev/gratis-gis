// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Theme presets for Custom Web App rendering. Each preset is a
 * bundle of CSS-variable token values applied at the app root so
 * every widget inside (containers, content widgets, etc.) renders
 * with a consistent palette / typography / density.
 *
 * Why presets instead of per-token authoring: the "pick a vibe"
 * UX takes a single click and produces a coherent look. Authors
 * who want to override individual tokens can do so via the older
 * CustomAppData.theme block (accent, background); preset tokens
 * are the starting point those overrides apply on top of.
 *
 * The token names are stable wire shapes. New themes add new
 * entries; renaming a theme requires a migration step on any
 * persisted CustomAppData that references it (none ship yet).
 *
 * Color token format: bare HSL components ("210 40% 96%"), NOT
 * the full `hsl(...)` wrapper. This is so consumers can wrap with
 * Tailwind's arbitrary-value syntax and apply opacity modifiers,
 * e.g. `bg-[hsl(var(--app-surface-1)/0.7)]`. If we stored the full
 * `hsl(...)` value, consumers would produce invalid `hsl(hsl(...))`.
 * Non-color tokens (radius, shadows, density) are full CSS values.
 */
import type { AppThemePresetId } from './custom-app';

/**
 * Token values for one theme preset. Color values are bare HSL
 * components (e.g. "210 40% 96%"); non-color values are full CSS
 * strings (lengths, shadows, multipliers). See module docstring
 * for the rationale behind this split.
 *
 * Tokens grouped:
 *   - Surface ladder: app shell, cards, popovers (with their ink
 *     pairs that always meet AA contrast against their surface).
 *   - Accent: primary actions, focus rings, active states.
 *   - Status: success, warn, danger, info kept theme-agnostic
 *     enough that all themes use similar hues so a user doesn't
 *     mistake "error" for the brand color.
 *   - Border + muted: chrome / dividers / secondary text.
 *   - Geometry: corner radius + spacing density. Smaller radius
 *     reads as technical / engineering; larger reads as
 *     consumer-friendly.
 */
export interface AppThemeTokens {
  /** Display name shown in the picker UI. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /**
   * Hue character for the preset; used by the picker's swatch
   * preview. Format: full `hsl(h s% l%)` (the swatch is rendered
   * with inline style, not via the token system).
   */
  swatch: string;
  /** Token values applied via `style.setProperty` at the app root. */
  tokens: {
    /** Page background (between widgets). Bare HSL components. */
    '--app-surface-0': string;
    /** Elevated card background (widget shells). Bare HSL. */
    '--app-surface-1': string;
    /** Input / popover background (one step elevated again). Bare HSL. */
    '--app-surface-2': string;
    /** Text color readable on surface-0. Bare HSL. */
    '--app-ink-0': string;
    /** Text color readable on surface-1. Bare HSL. */
    '--app-ink-1': string;
    /** Muted / secondary text. Bare HSL. */
    '--app-muted': string;
    /** Borders + dividers. Bare HSL. */
    '--app-border': string;
    /** Primary accent for buttons, focus rings, active states. Bare HSL. */
    '--app-accent': string;
    /** Text color readable on accent backgrounds. Bare HSL. */
    '--app-accent-ink': string;
    /** Hover state for accent surfaces. Bare HSL. */
    '--app-accent-hover': string;
    /**
     * App-bar surface. Decoupled from surface-1 so each theme can
     * brand its header independently (navy banner over off-white
     * body, etc.) without changing the body card color. The Default
     * theme keeps this neutral; Slate/Aurora/Forest/Paper use bolder
     * choices so the header reads as branded chrome, the way AGO
     * apps do.
     */
    '--app-header-bg': string;
    /** Text color readable on the header bg. Bare HSL. */
    '--app-header-ink': string;
    /** Muted/subtitle text on header. Bare HSL. */
    '--app-header-muted': string;
    /** Border under the header. Bare HSL. */
    '--app-header-border': string;
    /** Status colors. Bare HSL. */
    '--app-success': string;
    '--app-warn': string;
    '--app-danger': string;
    '--app-info': string;
    /** Corner radius for cards / inputs / buttons. CSS length. */
    '--app-radius': string;
    /** Subtle card shadow. CSS box-shadow value. */
    '--app-shadow-card': string;
    /** Stronger shadow for popovers / overlays. */
    '--app-shadow-overlay': string;
    /** Spacing density. Multiplier on Tailwind spacing units. */
    '--app-density': string;
    /**
     * App font stack. Lets a theme carry a typographic voice instead
     * of every app inheriting one face. Applied at the app root as
     * `font-family: var(--app-font)`. Values may reference the
     * portal's own font var (e.g. `var(--font-sans)`) so an app on
     * the default theme matches the portal exactly.
     */
    '--app-font': string;
  };
}

/**
 * Portal-matching sans stack. Resolves to Inter (loaded by the root
 * layout as --font-sans) with system fallbacks, so an app on the
 * default theme uses the same face as the portal chrome around it.
 */
const PORTAL_SANS =
  "var(--font-sans), 'Inter', ui-sans-serif, system-ui, sans-serif";

/**
 * Contour-tuned status colors, shared across the light themes so an
 * app's success/warn/danger/info never drifts into the saturated
 * framework-default look. Mirrors globals.css. The dark Slate theme
 * uses lifted variants (see its entry).
 */
const CONTOUR_STATUS_LIGHT = {
  '--app-success': '142 60% 30%',
  '--app-warn': '33 85% 47%',
  '--app-danger': '0 68% 49%',
  '--app-info': '205 75% 42%',
} as const;

/**
 * Registry of built-in theme presets. Add a new preset by adding
 * an entry here AND adding its id to the AppThemePresetId union
 * in custom-app.ts.
 *
 * Color tokens are bare HSL components; consumers wrap with
 * `hsl(var(--app-*))` (see module docstring).
 */
export const APP_THEMES: Record<AppThemePresetId, AppThemeTokens> = {
  default: {
    label: 'Default',
    description: 'Warm paper and deep sage. Matches the portal.',
    swatch: 'hsl(124 12% 24%)',
    tokens: {
      // Contour: warm-paper surface ladder, deep-sage accent, and a
      // dark forest-sage header band that reads as branded chrome.
      // Mirrors globals.css so an app looks like it belongs to the
      // portal shell around it.
      '--app-surface-0': '45 30% 96%',
      '--app-surface-1': '45 34% 99%',
      '--app-surface-2': '45 22% 93%',
      '--app-ink-0': '40 12% 13%',
      '--app-ink-1': '40 12% 22%',
      '--app-muted': '40 7% 44%',
      '--app-border': '43 18% 87%',
      '--app-accent': '124 8% 38%',
      '--app-accent-ink': '0 0% 100%',
      '--app-accent-hover': '124 8% 31%',
      '--app-header-bg': '124 13% 19%',
      '--app-header-ink': '45 42% 96%',
      '--app-header-muted': '115 12% 74%',
      '--app-header-border': '124 12% 14%',
      ...CONTOUR_STATUS_LIGHT,
      '--app-radius': '0.5rem',
      // Warm-tinted shadow (brown, not neutral gray) so elevation
      // reads on the paper surfaces without a cold cast.
      '--app-shadow-card':
        '0 1px 2px rgba(60, 48, 28, 0.06), 0 1px 1px rgba(60, 48, 28, 0.04)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(55, 44, 26, 0.22), 0 2px 8px -2px rgba(55, 44, 26, 0.10)',
      '--app-density': '1',
      '--app-font': PORTAL_SANS,
    },
  },
  slate: {
    label: 'Slate',
    description: 'Cool gray + indigo accent. Technical, engineering-forward.',
    swatch: 'hsl(217 33% 17%)',
    tokens: {
      '--app-surface-0': '220 26% 14%',
      '--app-surface-1': '217 33% 19%',
      '--app-surface-2': '215 28% 24%',
      '--app-ink-0': '213 31% 91%',
      '--app-ink-1': '213 31% 91%',
      '--app-muted': '215 16% 65%',
      '--app-border': '215 28% 28%',
      '--app-accent': '239 84% 67%',
      '--app-accent-ink': '220 26% 14%',
      '--app-accent-hover': '239 84% 73%',
      '--app-header-bg': '222 47% 9%',
      '--app-header-ink': '213 31% 95%',
      '--app-header-muted': '215 20% 65%',
      '--app-header-border': '239 84% 50%',
      '--app-success': '142 45% 55%',
      '--app-warn': '35 80% 58%',
      '--app-danger': '0 65% 62%',
      '--app-info': '205 70% 60%',
      '--app-radius': '0.5rem',
      '--app-shadow-card':
        '0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 1px rgba(0, 0, 0, 0.3)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(0, 0, 0, 0.55), 0 2px 8px -2px rgba(0, 0, 0, 0.35)',
      '--app-density': '1',
      '--app-font': PORTAL_SANS,
    },
  },
  aurora: {
    label: 'Aurora',
    description: 'Soft teal surfaces, teal accent, generous spacing.',
    swatch: 'hsl(180 30% 95%)',
    tokens: {
      '--app-surface-0': '180 30% 94%',
      '--app-surface-1': '0 0% 100%',
      '--app-surface-2': '180 25% 88%',
      '--app-ink-0': '195 60% 11%',
      '--app-ink-1': '195 60% 18%',
      '--app-muted': '195 15% 42%',
      '--app-border': '180 18% 80%',
      '--app-accent': '173 80% 36%',
      '--app-accent-ink': '0 0% 100%',
      '--app-accent-hover': '173 80% 30%',
      '--app-header-bg': '173 80% 28%',
      '--app-header-ink': '180 30% 97%',
      '--app-header-muted': '180 25% 80%',
      '--app-header-border': '173 80% 20%',
      ...CONTOUR_STATUS_LIGHT,
      '--app-radius': '0.75rem',
      '--app-shadow-card':
        '0 2px 4px rgba(15, 60, 60, 0.08), 0 1px 2px rgba(15, 60, 60, 0.06)',
      '--app-shadow-overlay':
        '0 16px 48px -12px rgba(15, 60, 60, 0.28), 0 4px 12px -4px rgba(15, 60, 60, 0.12)',
      '--app-density': '1.1',
      '--app-font': PORTAL_SANS,
    },
  },
  forest: {
    label: 'Forest',
    description: 'Warm cream surfaces, soft sage-forest chrome. Field-ready.',
    swatch: 'hsl(155 22% 40%)',
    tokens: {
      '--app-surface-0': '45 35% 92%',
      '--app-surface-1': '45 50% 97%',
      '--app-surface-2': '45 30% 86%',
      '--app-ink-0': '155 25% 16%',
      '--app-ink-1': '155 25% 22%',
      '--app-muted': '30 10% 42%',
      '--app-border': '45 22% 78%',
      '--app-accent': '155 28% 38%',
      '--app-accent-ink': '45 50% 97%',
      '--app-accent-hover': '155 28% 30%',
      '--app-header-bg': '155 22% 38%',
      '--app-header-ink': '45 55% 96%',
      '--app-header-muted': '100 14% 80%',
      '--app-header-border': '155 22% 26%',
      ...CONTOUR_STATUS_LIGHT,
      '--app-radius': '0.375rem',
      '--app-shadow-card':
        '0 1px 2px rgba(60, 30, 0, 0.08), 0 1px 1px rgba(60, 30, 0, 0.05)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(60, 30, 0, 0.25), 0 2px 8px -2px rgba(60, 30, 0, 0.12)',
      '--app-density': '1',
      '--app-font': PORTAL_SANS,
    },
  },
  paper: {
    label: 'Paper',
    description: 'High-contrast print-style palette. Reports, public maps.',
    swatch: 'hsl(0 0% 7%)',
    tokens: {
      '--app-surface-0': '0 0% 96%',
      '--app-surface-1': '0 0% 100%',
      '--app-surface-2': '0 0% 92%',
      '--app-ink-0': '0 0% 7%',
      '--app-ink-1': '0 0% 15%',
      '--app-muted': '0 0% 38%',
      '--app-border': '0 0% 80%',
      '--app-accent': '0 0% 7%',
      '--app-accent-ink': '0 0% 100%',
      '--app-accent-hover': '0 0% 20%',
      '--app-header-bg': '0 0% 7%',
      '--app-header-ink': '0 0% 98%',
      '--app-header-muted': '0 0% 65%',
      '--app-header-border': '0 0% 0%',
      ...CONTOUR_STATUS_LIGHT,
      '--app-radius': '0.25rem',
      '--app-shadow-card': 'none',
      '--app-shadow-overlay':
        '0 4px 16px -4px rgba(0, 0, 0, 0.18), 0 1px 4px -1px rgba(0, 0, 0, 0.1)',
      '--app-density': '0.95',
      '--app-font': PORTAL_SANS,
    },
  },
};

/**
 * Resolve a preset id to its token bundle. Falls back to 'default'
 * for any unknown id so a future deprecation of a theme name
 * doesn't break older saved apps.
 */
export function resolveAppTheme(id: AppThemePresetId | undefined): AppThemeTokens {
  if (id && APP_THEMES[id]) return APP_THEMES[id];
  return APP_THEMES.default;
}

/**
 * Minimal DOM surface this module touches. The shared-types package
 * doesn't pull in `lib.dom.d.ts` (it's consumed by both node-side
 * and browser-side code), so we declare the parts we need locally.
 * Any real HTMLElement satisfies this shape.
 */
interface CSSVariableSetter {
  style: { setProperty: (key: string, value: string) => void };
}

/**
 * Apply a theme's tokens to a DOM element by setting CSS custom
 * properties. Mount this on the app's root container in both the
 * designer preview and the runtime so widgets restyle live as the
 * author swaps presets.  Accepts either a starter kind id or a
 * full token bundle (used when resolving against a saved theme
 * item rather than a built-in preset).
 */
export function applyAppTheme(
  el: CSSVariableSetter,
  id: AppThemePresetId | string | undefined,
): void {
  // resolveAppTheme tolerates unknown strings by falling back to
  // 'default'; widen the input here so callers with a theme item
  // UUID can use the same applier as the legacy starter-kind path.
  const theme = resolveAppTheme(id as AppThemePresetId | undefined);
  for (const [key, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(key, value);
  }
}

/**
 * Like applyAppTheme but accepts the tokens directly.  Used by
 * the runtime when the theme came from a `theme` item rather than
 * a built-in starter kind.  Skips unknown keys gracefully so a
 * future token addition doesn't break apps stored against an
 * older shape.
 */
export function applyAppThemeTokens(
  el: CSSVariableSetter,
  tokens: AppThemeTokens['tokens'] | Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === 'string') {
      el.style.setProperty(key, value);
    }
  }
}

// ============================================================
// #22 Theme starter library (themes-as-items).
// ============================================================
//
// Mirror of the app-template starter library above.  The same
// five built-in palettes that used to live behind a string-literal
// AppThemePresetId union now seed per-org as `theme` items via
// auth-sync.  After seeding, admins are free to edit / delete /
// replace them like any other item; the seed_kind column on item
// is the durable "this was originally the default starter" mark.

/**
 * Stable identifier persisted on the seeded theme item's seedKind.
 * Matches the legacy AppThemePresetId values so apps saved before
 * the items-refactor (themePresetId: 'forest' etc.) keep resolving.
 */
export type ThemeStarterKind = AppThemePresetId;

export interface ThemeStarter {
  kind: ThemeStarterKind;
  label: string;
  description: string;
  swatch: string;
  tokens: AppThemeTokens['tokens'];
}

/**
 * Built-in theme starters, derived from APP_THEMES.  Order in this
 * array is the order the housekeeping restore UI displays them.
 */
export const THEME_STARTERS: readonly ThemeStarter[] = (
  Object.entries(APP_THEMES) as Array<[ThemeStarterKind, AppThemeTokens]>
).map(([kind, t]) => ({
  kind,
  label: t.label,
  description: t.description,
  swatch: t.swatch,
  tokens: t.tokens,
}));

export function getThemeStarter(kind: string): ThemeStarter | null {
  return THEME_STARTERS.find((s) => s.kind === kind) ?? null;
}

/**
 * Shape of a saved theme item's data_json payload.  Mirrors the
 * AppThemeTokens bundle the runtime applies; serializes cleanly
 * over Prisma's JSONB column.
 */
export interface ThemeItemData {
  version: 1;
  /** Display swatch (e.g. 'hsl(150 22% 38%)'); rendered in pickers. */
  swatch: string;
  /** Token bundle written as CSS custom properties at the app root. */
  tokens: AppThemeTokens['tokens'];
}

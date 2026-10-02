// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from 'tailwindcss';

/** Token-driven theme. Component code should use these semantic classes
 *  rather than raw palette values (e.g. `bg-surface-1`, not `bg-slate-50`). */
const config: Config = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    container: { center: true, padding: '1rem' },
    extend: {
      fontSize: {
        // 11px, for dense map and table metadata only. Sentences,
        // help, and empty-state body copy use text-sm (14px) or at
        // least text-xs (12px). Do not reintroduce arbitrary bracket
        // sizes below text-xs.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      colors: {
        surface: {
          0: 'hsl(var(--surface-0))',
          1: 'hsl(var(--surface-1))',
          2: 'hsl(var(--surface-2))',
        },
        ink: {
          0: 'hsl(var(--surface-0-ink))',
          1: 'hsl(var(--surface-1-ink))',
          2: 'hsl(var(--surface-2-ink))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-ink))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-ink))',
        },
        success: 'hsl(var(--success))',
        warn: 'hsl(var(--warn))',
        danger: 'hsl(var(--danger))',
        info: 'hsl(var(--info))',
        border: 'hsl(var(--border))',
        brand: {
          chart: 'hsl(var(--brand-chart))',
          contour: 'hsl(var(--brand-contour))',
          index: 'hsl(var(--brand-index))',
        },
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        card: '0 1px 1px hsl(var(--surface-0-ink) / 0.04)',
        raised: '0 8px 20px hsl(var(--surface-0-ink) / 0.08)',
        overlay: '0 20px 40px hsl(var(--surface-0-ink) / 0.16), 0 8px 16px hsl(var(--surface-0-ink) / 0.08)',
      },
      fontFamily: {
        // Both faces load through next/font in the root layout and
        // arrive as CSS variables; the literal names remain as
        // fallbacks for surfaces rendered outside the app shell.
        sans: ['var(--font-sans)', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', '"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        // The dialog's entrance. The centering translate is baked in
        // deliberately, and that is why this is named for the dialog
        // rather than for the motion.
        //
        // It used to be a generic `slide-up` whose keyframes set
        // `transform: translateY(4px)` -> `translateY(0)`. A keyframe
        // sets the whole transform property, and an animation outranks
        // a normal declaration, so for the 180ms it ran it wiped the
        // `-translate-x-1/2 -translate-y-1/2` that centers
        // DialogContent on its `left-1/2 top-1/2` anchor. The dialog's
        // top-left corner sat at the middle of the viewport instead of
        // the dialog being centred there: a max-w-md confirm hung 448px
        // off to the right, clipping on narrower windows, with its
        // buttons far below where they belonged. Because there is no
        // fill-mode it corrected itself after 180ms in a foreground
        // tab, which is what made it look intermittent, but CSS
        // animations are throttled in a hidden or backgrounded
        // document, where it stays stuck at the 0% frame instead.
        //
        // The utilities are still on the element and still own the
        // resting state, so 100% here must equal them exactly or the
        // dialog will jump when the animation ends.
        'dialog-in': {
          '0%': { opacity: '0', transform: 'translate(-50%, calc(-50% + 4px))' },
          '100%': { opacity: '1', transform: 'translate(-50%, -50%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'dialog-in': 'dialog-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

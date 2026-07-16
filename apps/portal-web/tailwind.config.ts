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
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        card: '0 1px 2px hsl(var(--surface-0-ink) / 0.04), 0 1px 3px hsl(var(--surface-0-ink) / 0.06)',
        raised: '0 4px 10px hsl(var(--surface-0-ink) / 0.08), 0 2px 4px hsl(var(--surface-0-ink) / 0.05)',
        overlay: '0 20px 40px hsl(var(--surface-0-ink) / 0.14), 0 8px 16px hsl(var(--surface-0-ink) / 0.08)',
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
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        'slide-up': 'slide-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

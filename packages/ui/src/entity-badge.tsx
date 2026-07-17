// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CSSProperties } from 'react';

/**
 * Visual identity for an entity (item, group, user, org). If an image
 * URL is provided, renders it; otherwise renders a colored square with
 * initials derived from the label and a color derived deterministically
 * from the seed so the same entity gets the same color every render.
 *
 * Design intent:
 *   - Never ship a generic placeholder. An empty grey box is noise; a
 *     colored initial tile is a cheap visual anchor and makes lists
 *     scannable at a glance.
 *   - Colors come from a small curated palette (not HSL rainbow). Keeps
 *     the app from looking like a kindergarten poster while still giving
 *     enough variety that adjacent rows don't collide.
 */

export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type BadgeRounded = 'full' | 'md';

interface Props {
  /** Name used for initials, e.g. "Acme HQ Campus Map" → "AH". */
  label: string;
  /** Stable id used to pick a color from the palette. */
  seed: string;
  /** Optional custom image. Null or missing falls back to the initial tile. */
  imageUrl?: string | null;
  size?: BadgeSize;
  rounded?: BadgeRounded;
  className?: string;
}

// Curated palette. Each entry is [background, foreground]. Backgrounds
// sit around 500-level tailwind saturation so white text reads cleanly
// regardless of which one is picked.
const PALETTE: Array<[string, string]> = [
  ['#0ea5e9', '#ffffff'], // sky
  ['#6366f1', '#ffffff'], // indigo
  ['#a855f7', '#ffffff'], // purple
  ['#ec4899', '#ffffff'], // pink
  ['#ef4444', '#ffffff'], // red
  ['#f97316', '#ffffff'], // orange
  ['#f59e0b', '#111827'], // amber (dark text for contrast)
  ['#10b981', '#ffffff'], // emerald
  ['#14b8a6', '#ffffff'], // teal
  ['#0891b2', '#ffffff'], // cyan
  ['#64748b', '#ffffff'], // slate
];

const SIZE_CLASS: Record<BadgeSize, string> = {
  xs: 'h-6 w-6 text-2xs',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-base',
  xl: 'h-24 w-24 text-2xl',
};

const ROUND_CLASS: Record<BadgeRounded, string> = {
  full: 'rounded-full',
  md: 'rounded-md',
};

/** Sum char codes to pick a stable palette index. djb2 keeps collisions low. */
function hashIndex(seed: string, mod: number): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

/** First letter of first two meaningful words, uppercase, 1-2 chars. */
function initials(label: string): string {
  const words = label
    .split(/[\s._-]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 2);
  if (words.length === 0) return '?';
  return words.map((w) => w[0]!.toUpperCase()).join('');
}

export function EntityBadge({
  label,
  seed,
  imageUrl,
  size = 'md',
  rounded = 'md',
  className = '',
}: Props) {
  const sizeCls = SIZE_CLASS[size];
  const roundCls = ROUND_CLASS[rounded];

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt=""
        aria-hidden="true"
        className={`${sizeCls} ${roundCls} object-cover ${className}`}
      />
    );
  }

  const [bg, fg] = PALETTE[hashIndex(seed, PALETTE.length)]!;
  const style: CSSProperties = { backgroundColor: bg, color: fg };

  return (
    <span
      aria-hidden="true"
      style={style}
      className={`${sizeCls} ${roundCls} inline-flex items-center justify-center font-semibold leading-none ${className}`}
    >
      {initials(label)}
    </span>
  );
}

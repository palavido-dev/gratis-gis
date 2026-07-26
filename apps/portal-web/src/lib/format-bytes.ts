// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared byte-count formatter for every UI surface that shows a
 * size. Five near-identical private copies had drifted apart
 * (offline storage, offline downloads, the tile-layer editor, the
 * backup admin), so the same byte count rendered with different
 * precision depending on which panel you were looking at. One
 * implementation pins the behavior everywhere:
 *
 *   - binary (1024-based) units
 *   - whole numbers below 1 KB, one decimal place above
 *   - tiers through TB
 */

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | bigint): string {
  // bigint callers exist because Prisma surfaces BIGINT columns
  // (backup sizes) as bigint. Display precision tops out at one
  // decimal, so converting through Number is lossless for any size
  // a portal will realistically report.
  let n = typeof bytes === 'bigint' ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1024) return `${Math.round(n)} B`;
  let unitIndex = 0;
  n /= 1024;
  while (n >= 1024 && unitIndex < UNITS.length - 1) {
    n /= 1024;
    unitIndex += 1;
  }
  return `${n.toFixed(1)} ${UNITS[unitIndex]}`;
}

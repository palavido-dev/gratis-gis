// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Positive-finite env number with a fallback. Shared by every
 * env-tunable cost model (#205 merge, #199 mosaic, #208 grid) so
 * the parsing rule cannot drift: junk or non-positive values fall
 * back rather than poisoning an estimate.
 */
export function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

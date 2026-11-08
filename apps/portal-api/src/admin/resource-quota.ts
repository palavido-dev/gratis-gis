// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure quota decision. A null cap means unlimited. Disk exhaustion
 * is separate from the org cap: a full filesystem refuses the
 * reservation even when the org has no cap. The ingest headroom
 * multiplier is not this check.
 */
export function quotaDecision(input: {
  maxBytes: bigint | null;
  usedBytes: bigint;
  requestedBytes: bigint;
  maxConcurrentImports: number | null;
  activeImports: number;
  freeBytes: bigint | null;
}): { ok: true } | { ok: false; reason: 'storage' | 'concurrent' | 'disk' } {
  if (input.freeBytes !== null && input.requestedBytes > input.freeBytes) {
    return { ok: false, reason: 'disk' };
  }
  if (
    input.maxBytes !== null &&
    input.usedBytes + input.requestedBytes > input.maxBytes
  ) {
    return { ok: false, reason: 'storage' };
  }
  if (
    input.maxConcurrentImports !== null &&
    input.activeImports + 1 > input.maxConcurrentImports
  ) {
    return { ok: false, reason: 'concurrent' };
  }
  return { ok: true };
}

// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Free-disk guard. Refuses a reservation larger than the free space
 * on the staging filesystem. A null free count (statfs failed) does
 * not block. There is no per-org cap.
 */
export function diskDecision(input: {
  requestedBytes: bigint;
  freeBytes: bigint | null;
}): { ok: true } | { ok: false; reason: 'disk' } {
  if (input.freeBytes !== null && input.requestedBytes > input.freeBytes) {
    return { ok: false, reason: 'disk' };
  }
  return { ok: true };
}

// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Free-disk guard. Refuses a reservation when it, plus every byte
 * already held by live reservations, is larger than the free space on
 * the staging filesystem. Without the held bytes, N concurrent imports
 * each compare against the same free space and all pass with room for
 * about one. A null free count (statfs failed) does not block. There is
 * no per-org cap.
 */
export function diskDecision(input: {
  requestedBytes: bigint;
  freeBytes: bigint | null;
  heldBytes?: bigint;
}): { ok: true } | { ok: false; reason: 'disk' } {
  const held = input.heldBytes ?? 0n;
  if (input.freeBytes !== null && input.requestedBytes + held > input.freeBytes) {
    return { ok: false, reason: 'disk' };
  }
  return { ok: true };
}

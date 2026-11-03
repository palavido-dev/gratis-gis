// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Frame budget for the drawings CRDT WebSocket
 * (presence-crdt-defaults-2026-11-03). Presence stays at 64 KiB;
 * CRDT updates are larger but still capped.
 */
export const DRAWINGS_WS_MAX_PAYLOAD_BYTES = 256 * 1024;

/** Soft ceiling on updates accepted per connection per second. */
export const DRAWINGS_WS_MAX_UPDATES_PER_SEC = 30;

export function drawingsFrameByteLength(raw: unknown): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return Buffer.byteLength(String(raw), 'utf8');
}

export function isDrawingsFrameWithinBudget(
  raw: unknown,
  maxBytes: number = DRAWINGS_WS_MAX_PAYLOAD_BYTES,
): boolean {
  return drawingsFrameByteLength(raw) <= maxBytes;
}

// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hard ceiling on a single inbound Presence WebSocket frame
 * (SEC-ws-frame-cap). Cursor / heartbeat JSON is a few hundred bytes;
 * the `ws` default of 100 MiB would let one authenticated client pin
 * memory. Applied both as `maxPayload` on the gateway and as an
 * application check before JSON.parse.
 */
export const PRESENCE_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

/**
 * Byte length of a ws `message` event payload (string, Buffer, or
 * Buffer[]). Returns 0 for unrecognized shapes so the caller can
 * reject them as invalid JSON next.
 */
export function presenceFrameByteLength(raw: unknown): number {
  if (typeof raw === 'string') {
    return Buffer.byteLength(raw, 'utf8');
  }
  if (Buffer.isBuffer(raw)) {
    return raw.byteLength;
  }
  if (Array.isArray(raw)) {
    let n = 0;
    for (const part of raw) {
      if (!Buffer.isBuffer(part)) return Number.POSITIVE_INFINITY;
      n += part.byteLength;
    }
    return n;
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  return Number.POSITIVE_INFINITY;
}

/** True when the frame fits under {@link PRESENCE_WS_MAX_PAYLOAD_BYTES}. */
export function isPresenceFrameWithinBudget(
  raw: unknown,
  maxBytes: number = PRESENCE_WS_MAX_PAYLOAD_BYTES,
): boolean {
  return presenceFrameByteLength(raw) <= maxBytes;
}

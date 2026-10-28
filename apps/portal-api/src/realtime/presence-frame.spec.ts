// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  PRESENCE_WS_MAX_PAYLOAD_BYTES,
  isPresenceFrameWithinBudget,
  presenceFrameByteLength,
} from './presence-frame.js';

describe('presence-frame', () => {
  it('exports a 64 KiB ceiling', () => {
    expect(PRESENCE_WS_MAX_PAYLOAD_BYTES).toBe(64 * 1024);
  });

  it('measures string and Buffer frames', () => {
    expect(presenceFrameByteLength('{"type":"heartbeat"}')).toBe(
      Buffer.byteLength('{"type":"heartbeat"}', 'utf8'),
    );
    expect(presenceFrameByteLength(Buffer.from('abc'))).toBe(3);
    expect(
      presenceFrameByteLength([Buffer.from('ab'), Buffer.from('cd')]),
    ).toBe(4);
  });

  it('accepts a cursor-sized frame and rejects an oversized one', () => {
    const ok = JSON.stringify({
      type: 'cursor',
      cursor: { lng: -80.5, lat: 39.1 },
    });
    expect(isPresenceFrameWithinBudget(ok)).toBe(true);
    const huge = 'x'.repeat(PRESENCE_WS_MAX_PAYLOAD_BYTES + 1);
    expect(isPresenceFrameWithinBudget(huge)).toBe(false);
  });
});

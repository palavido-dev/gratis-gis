// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DRAWINGS_WS_MAX_PAYLOAD_BYTES,
  isDrawingsFrameWithinBudget,
} from './drawings-collab-frame.js';

describe('drawings-collab-frame', () => {
  it('exports a 256 KiB ceiling', () => {
    expect(DRAWINGS_WS_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
  });

  it('accepts a small JSON frame and rejects an oversized one', () => {
    expect(isDrawingsFrameWithinBudget('{"type":"update","update":"abc"}')).toBe(
      true,
    );
    const huge = 'x'.repeat(DRAWINGS_WS_MAX_PAYLOAD_BYTES + 1);
    expect(isDrawingsFrameWithinBudget(huge)).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pin for the deep-freeze on the shared viewer / editor defaults.
// Consumers spread these constants into fresh objects, but a spread
// is shallow: nested arrays and objects still alias module state,
// and an accidental in-place mutation would silently rewrite the
// defaults for every later caller. Frozen constants turn that into
// a loud TypeError instead.

import {
  DEFAULT_EDITOR,
  DEFAULT_EDITOR_SNAPPING,
  DEFAULT_EDITOR_TOOLS,
  DEFAULT_VIEWER,
  DEFAULT_VIEWER_TOOLS,
} from '@gratis-gis/shared-types';

describe('shared viewer / editor defaults', () => {
  it('are deep-frozen, including nested arrays and objects', () => {
    expect(Object.isFrozen(DEFAULT_VIEWER)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VIEWER.targets)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VIEWER_TOOLS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EDITOR)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EDITOR.targets)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EDITOR_TOOLS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EDITOR_SNAPPING)).toBe(true);
    // The composite defaults alias the standalone constants on
    // purpose; freezing must cover them through either path.
    expect(Object.isFrozen(DEFAULT_EDITOR.tools)).toBe(true);
    expect(Object.isFrozen(DEFAULT_EDITOR.snapping)).toBe(true);
  });

  it('reject in-place mutation loudly', () => {
    // This module compiles under alwaysStrict, so writes to frozen
    // objects throw rather than failing silently.
    expect(() => {
      (DEFAULT_EDITOR_TOOLS as string[]).push('measure');
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_EDITOR_SNAPPING as { tolerancePx: number }).tolerancePx = 99;
    }).toThrow(TypeError);
  });
});

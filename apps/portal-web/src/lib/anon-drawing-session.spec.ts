// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  anonDrawingDisplayFor,
  readAnonDrawingDisplay,
} from './anon-drawing-session';

describe('anon-drawing-session (client)', () => {
  it('derives the same display label as portal-api', () => {
    expect(anonDrawingDisplayFor('abcdef12-3456-7890-abcd-ef1234567890')).toBe(
      'Anonymous abcdef',
    );
  });

  it('reads the cookie from document.cookie', () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `gg_anon_drawing=${token}; other=1`,
    });
    expect(readAnonDrawingDisplay()).toBe('Anonymous aaaaaa');
  });
});

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

  it('reads the cookie from document.cookie when present', () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const doc = { cookie: `gg_anon_drawing=${token}; other=1` };
    (globalThis as { document?: unknown }).document = doc;
    try {
      expect(readAnonDrawingDisplay()).toBe('Anonymous aaaaaa');
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });

  it('returns null when document is unavailable', () => {
    delete (globalThis as { document?: unknown }).document;
    expect(readAnonDrawingDisplay()).toBeNull();
  });
});

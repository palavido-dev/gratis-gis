// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request, Response } from 'express';

import {
  ANON_DRAWING_COOKIE,
  anonDrawingDisplayFor,
  readAnonDrawingSession,
  readOrMintAnonDrawingSession,
} from './anon-drawing-session.js';

describe('anon-drawing-session', () => {
  it('derives a stable display from the token prefix', () => {
    expect(anonDrawingDisplayFor('abcdef12-3456-7890-abcd-ef1234567890')).toBe(
      'Anonymous abcdef',
    );
  });

  it('reads an existing cookie session', () => {
    const token = '11111111-2222-3333-4444-555555555555';
    const req = {
      headers: { cookie: `${ANON_DRAWING_COOKIE}=${token}` },
    } as unknown as Request;
    expect(readAnonDrawingSession(req)).toEqual({
      token,
      display: 'Anonymous 111111',
    });
  });

  it('mints a cookie when none is present', () => {
    const req = { headers: {} } as unknown as Request;
    const appended: string[] = [];
    const res = {
      append: (name: string, value: string) => {
        if (name === 'Set-Cookie') appended.push(value);
      },
    } as unknown as Response;
    const session = readOrMintAnonDrawingSession(req, res);
    expect(session.token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(session.display).toBe(anonDrawingDisplayFor(session.token));
    expect(appended).toHaveLength(1);
    expect(appended[0]).toContain(`${ANON_DRAWING_COOKIE}=`);
    expect(appended[0]).toContain('Path=/');
    expect(appended[0]).toContain('SameSite=Lax');
  });
});

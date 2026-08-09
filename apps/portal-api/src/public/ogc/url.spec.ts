// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

import { absoluteBase } from './url.js';

const req = (headers: Record<string, string>): Request =>
  ({ headers, protocol: 'https' }) as unknown as Request;

describe('absoluteBase (OGC self-links must not follow a forged Host)', () => {
  const saved = process.env.PORTAL_BASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORTAL_BASE_URL;
    else process.env.PORTAL_BASE_URL = saved;
  });

  it('uses PORTAL_BASE_URL and ignores a spoofed X-Forwarded-Host', () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org';
    const base = absoluteBase(
      req({ 'x-forwarded-host': 'evil.example', host: 'evil.example' }),
    );
    // Not evil.example: a forged host cannot redirect an OGC client
    // following the links this base builds.
    expect(base).toBe('https://gratisgis.org');
  });

  it('strips a trailing slash from the configured base', () => {
    process.env.PORTAL_BASE_URL = 'https://gratisgis.org/';
    expect(absoluteBase(req({}))).toBe('https://gratisgis.org');
  });

  it('falls back to request headers only when the env var is unset (dev)', () => {
    delete process.env.PORTAL_BASE_URL;
    expect(absoluteBase(req({ host: 'localhost:4000' }))).toBe(
      'https://localhost:4000',
    );
  });
});

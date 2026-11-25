// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import { PrivateCacheInterceptor } from './private-cache.interceptor.js';
import { resetTenancyModeForTests } from './tenancy.js';

function run(authorization: string | undefined, preset: Record<string, string> = {}) {
  const headers = new Map<string, string>(Object.entries(preset));
  const res = {
    headersSent: false,
    getHeader: (n: string) => headers.get(n),
    setHeader: (n: string, v: string) => headers.set(n, v),
  };
  const req = { headers: authorization ? { authorization } : {} };
  const ctx = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of(null) };
  new PrivateCacheInterceptor().intercept(ctx, next).subscribe();
  return headers;
}

describe('PrivateCacheInterceptor', () => {
  const before = process.env.GRATIS_TENANCY;
  afterEach(() => {
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });

  function mode(m: 'single' | 'multi'): void {
    if (m === 'multi') process.env.GRATIS_TENANCY = 'multi';
    else delete process.env.GRATIS_TENANCY;
    resetTenancyModeForTests();
  }

  it('one organization: adds nothing', () => {
    mode('single');
    const h = run('Bearer x');
    expect(h.has('Cache-Control')).toBe(false);
    expect(h.has('Vary')).toBe(false);
  });

  it('many organizations: a signed-in answer is private and varies by Authorization', () => {
    mode('multi');
    const h = run('Bearer x', { Vary: 'Origin' });
    expect(h.get('Cache-Control')).toBe('private, no-cache');
    expect(h.get('Vary')).toBe('Origin, Authorization');
  });

  it('many organizations: a signed-out answer is left alone', () => {
    mode('multi');
    const h = run(undefined);
    expect(h.has('Cache-Control')).toBe(false);
    expect(h.has('Vary')).toBe(false);
  });
});

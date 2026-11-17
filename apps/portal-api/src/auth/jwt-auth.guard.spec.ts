// SPDX-License-Identifier: AGPL-3.0-or-later
//
// On a @Public route an expired or invalid JWT falls through as
// anonymous. A bad or read-only API key used to get a 401 or 403
// there instead, for data anyone could fetch with no header.

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard.js';

const KEY = 'ggk_' + 'a'.repeat(43);

function ctx(method: string) {
  const req: { method: string; headers: Record<string, string>; user?: unknown } = {
    method,
    headers: { authorization: `Bearer ${KEY}` },
  };
  const c = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { c, req };
}

function guard(isPublic: boolean, resolve: () => Promise<unknown>) {
  return new JwtAuthGuard(
    { getAllAndOverride: () => isPublic } as never,
    { resolve } as never,
    {} as never,
  );
}

describe('JwtAuthGuard with an API key', () => {
  it('treats a revoked key on a public route as anonymous', async () => {
    const { c, req } = ctx('GET');
    const g = guard(true, async () => {
      throw new UnauthorizedException();
    });
    await expect(g.canActivate(c)).resolves.toBe(true);
    expect(req.user).toBeNull();
  });

  it('still refuses a revoked key on a private route', async () => {
    const { c } = ctx('GET');
    const g = guard(false, async () => {
      throw new UnauthorizedException();
    });
    await expect(g.canActivate(c)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets a read-only key make a public write as nobody, and still refuses a private one', async () => {
    const readOnly = async () => ({ id: 'u', apiKeyReadOnly: true });
    const pub = ctx('POST');
    await expect(guard(true, readOnly).canActivate(pub.c)).resolves.toBe(true);
    expect(pub.req.user).toBeNull();
    const priv = ctx('POST');
    await expect(guard(false, readOnly).canActivate(priv.c)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import { JwtAuthGuard } from './jwt-auth.guard.js';
import {
  PRINT_READ_TTL_MS,
  looksLikePrintReadCredential,
  signPrintReadCredential,
  verifyPrintReadCredential,
} from './print-read-credential.js';
import { PrintReadCredentialService } from './print-read-credential.service.js';
import { PRINT_READABLE_KEY } from './print-readable.decorator.js';

const MAP_LAYER = '11111111-1111-4111-8111-111111111111';
const CLIP = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('print read credential format', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips and is recognised by its prefix', () => {
    const exp = Date.now() + 1000;
    const token = signPrintReadCredential({ uid: 'u1', ids: [MAP_LAYER], exp }, key);
    expect(looksLikePrintReadCredential(token)).toBe(true);
    expect(looksLikePrintReadCredential('ggk_' + 'a'.repeat(43))).toBe(false);
    expect(verifyPrintReadCredential(token, key)).toEqual({ uid: 'u1', ids: [MAP_LAYER], exp });
  });

  it('refuses an expired, tampered or foreign-key credential', () => {
    const token = signPrintReadCredential({ uid: 'u1', ids: [MAP_LAYER], exp: 1000 }, key);
    expect(verifyPrintReadCredential(token, key, 1001)).toBeNull();
    const live = signPrintReadCredential(
      { uid: 'u1', ids: [MAP_LAYER], exp: Date.now() + 1000 },
      key,
    );
    expect(verifyPrintReadCredential(live, Buffer.alloc(32, 8))).toBeNull();
    // Swap in a body that names another user, keep the old signature.
    const [, , sig] = live.split('.');
    const forged = Buffer.from(
      JSON.stringify({ uid: 'u2', ids: [OTHER], exp: Date.now() + 1000 }),
    ).toString('base64url');
    expect(verifyPrintReadCredential(`ggprint.${forged}.${sig}`, key)).toBeNull();
  });
});

function serviceWith(user: Record<string, unknown> | null, groups: string[][]) {
  let call = 0;
  const principalForUserId = jest.fn(async (id: string) => ({
    id,
    orgId: 'o1',
    orgSlug: 'acme',
    username: 'pat',
    email: 'p@x',
    orgRole: 'user',
    groupIds: groups[Math.min(call++, groups.length - 1)],
    capabilities: new Set(),
  }));
  const prisma = { user: { findUnique: jest.fn(async () => user) } };
  const cfg = { get: (_k: string, d: string) => d };
  const svc = new PrintReadCredentialService(
    prisma as never,
    { principalForUserId } as never,
    cfg as never,
  );
  return { svc, principalForUserId, prisma };
}

const LIVE_USER = { deletedAt: null, disabledAt: null, autoDisableAt: null, orgRole: 'user' };

describe('PrintReadCredentialService', () => {
  const read = {
    routeAllowed: true,
    allowedMethod: 'GET' as const,
    method: 'GET',
    itemId: MAP_LAYER,
    clip: undefined,
  };

  it('mints a one-minute credential naming only the given ids', () => {
    const { svc } = serviceWith(LIVE_USER, [[]]);
    const now = Date.now();
    const token = svc.mint('u1', [MAP_LAYER, CLIP, MAP_LAYER], now);
    const body = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { uid: string; ids: string[]; exp: number };
    expect(body).toEqual({ uid: 'u1', ids: [MAP_LAYER, CLIP], exp: now + PRINT_READ_TTL_MS });
  });

  it('resolves to the user, rebuilt on every request', async () => {
    const { svc, principalForUserId } = serviceWith(LIVE_USER, [['g-old'], []]);
    const token = svc.mint('u1', [MAP_LAYER]);
    const first = await svc.resolve(token, read);
    const second = await svc.resolve(token, read);
    expect(first.authKind).toBe('print_read');
    expect(first.groupIds).toEqual(['g-old']);
    // Dropped from the group after the mint: the next read has no group.
    expect(second.groupIds).toEqual([]);
    expect(principalForUserId).toHaveBeenCalledTimes(2);
  });

  it('refuses an expired credential', async () => {
    const { svc } = serviceWith(LIVE_USER, [[]]);
    const token = svc.mint('u1', [MAP_LAYER], Date.now() - PRINT_READ_TTL_MS - 1);
    await expect(svc.resolve(token, read)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses writes and routes not marked for print reads', async () => {
    const { svc, principalForUserId } = serviceWith(LIVE_USER, [[]]);
    const token = svc.mint('u1', [MAP_LAYER]);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
      await expect(svc.resolve(token, { ...read, method })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
    await expect(
      svc.resolve(token, { ...read, routeAllowed: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // A POST read route takes POST only, never GET or a write verb.
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      await expect(
        svc.resolve(token, { ...read, allowedMethod: 'POST', method }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(principalForUserId).not.toHaveBeenCalled();
  });

  it('refuses an item or a clip boundary the print does not reference', async () => {
    const { svc } = serviceWith(LIVE_USER, [[]]);
    const token = svc.mint('u1', [MAP_LAYER, CLIP]);
    await expect(svc.resolve(token, { ...read, itemId: OTHER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.resolve(token, { ...read, itemId: undefined })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.resolve(token, { ...read, clip: OTHER })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.resolve(token, { ...read, clip: [CLIP] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.resolve(token, { ...read, clip: CLIP })).resolves.toMatchObject({ id: 'u1' });
  });

  it('refuses a user who is gone, disabled or auto-disabled since the mint', async () => {
    for (const user of [
      null,
      { ...LIVE_USER, deletedAt: new Date() },
      { ...LIVE_USER, disabledAt: new Date() },
      { ...LIVE_USER, autoDisableAt: new Date(Date.now() - 1000) },
    ]) {
      const { svc } = serviceWith(user, [[]]);
      const token = svc.mint('u1', [MAP_LAYER]);
      await expect(svc.resolve(token, read)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
});

describe('JwtAuthGuard with a print read credential', () => {
  const GET = { method: 'GET', idParam: 'id' };
  function run(
    mark: unknown,
    method: string,
    path: string,
    itemId: string,
    params: Record<string, string> = { id: itemId },
  ) {
    const { svc } = serviceWith(LIVE_USER, [[]]);
    const token = svc.mint('u1', [MAP_LAYER]);
    const req: Record<string, unknown> = {
      method,
      path,
      params,
      query: {},
      headers: { authorization: `Bearer ${token}` },
    };
    const c = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    const reflector = {
      getAllAndOverride: (k: string) => (k === PRINT_READABLE_KEY ? mark : false),
    };
    const g = new JwtAuthGuard(reflector as never, {} as never, svc);
    return { promise: g.canActivate(c), req };
  }

  it('sets the user on a marked GET for an item in scope', async () => {
    const { promise, req } = run(GET, 'GET', `/api/items/${MAP_LAYER}/geojson`, MAP_LAYER);
    await expect(promise).resolves.toBe(true);
    expect(req.user).toMatchObject({ id: 'u1', authKind: 'print_read' });
  });

  it('refuses an unmarked route, even a read', async () => {
    await expect(
      run(undefined, 'GET', `/api/items/${MAP_LAYER}`, MAP_LAYER).promise,
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('holds the proxy to a layer query', async () => {
    const mark = { ...GET, path: /^\/api\/items\/[^/]+\/proxy\/\d+\/query$/ };
    await expect(
      run(mark, 'GET', `/api/items/${MAP_LAYER}/proxy/0/query`, MAP_LAYER).promise,
    ).resolves.toBe(true);
    for (const tail of ['0/applyEdits', 'x/proxy/0/query', '0/query/extra']) {
      await expect(
        run(mark, 'GET', `/api/items/${MAP_LAYER}/proxy/${tail}`, MAP_LAYER).promise,
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('reads the item id from the param the mark names', async () => {
    const mark = { method: 'POST', idParam: 'serviceItemId' };
    const path = `/api/postgis-live/${MAP_LAYER}/features`;
    const ok = run(mark, 'POST', path, MAP_LAYER, { serviceItemId: MAP_LAYER });
    await expect(ok.promise).resolves.toBe(true);
    expect(ok.req.user).toMatchObject({ authKind: 'print_read' });
    await expect(
      run(mark, 'POST', path, OTHER, { serviceItemId: OTHER }).promise,
    ).rejects.toBeInstanceOf(ForbiddenException);
    // An `id` param the mark does not name is not looked at.
    await expect(
      run(mark, 'POST', path, MAP_LAYER, { id: MAP_LAYER, serviceItemId: OTHER }).promise,
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a write on a marked route', async () => {
    await expect(
      run(GET, 'POST', `/api/items/${MAP_LAYER}/geojson`, MAP_LAYER).promise,
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

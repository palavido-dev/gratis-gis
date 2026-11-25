// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorageService } from '@nestjs/throttler';

import { resetTenancyModeForTests } from './tenancy.js';
import {
  AddressThrottlerGuard,
  CREDENTIALED_ADDRESS_FACTOR,
  ORG_CEILING_FACTOR,
  OrgThrottlerGuard,
} from './tenant-throttler.guard.js';

const LIMIT = 3;
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

class SomeController {
  handler(): void {}
}

type Caller = { ip: string; token?: string; user?: { id: string; orgId: string } | null };

/** Response headers each call set, in order; the last call's at the end. */
const sentHeaders: Array<Map<string, unknown>> = [];

function contextFor(caller: Caller): ExecutionContext {
  const req = {
    ip: caller.ip,
    headers: caller.token ? { authorization: `Bearer ${caller.token}` } : {},
    user: caller.user ?? null,
  };
  const headers = new Map<string, unknown>();
  sentHeaders.push(headers);
  const res = {
    header: (name: string, value: unknown) => {
      headers.set(name, value);
    },
  };
  return {
    getType: () => 'http',
    getClass: () => SomeController,
    getHandler: () => SomeController.prototype.handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function mode(m: 'single' | 'multi'): void {
  if (m === 'multi') process.env.GRATIS_TENANCY = 'multi';
  else delete process.env.GRATIS_TENANCY;
  resetTenancyModeForTests();
}

describe('request limits by caller', () => {
  const before = process.env.GRATIS_TENANCY;
  let storage: ThrottlerStorageService;
  let address: AddressThrottlerGuard;
  let org: OrgThrottlerGuard;

  beforeEach(async () => {
    storage = new ThrottlerStorageService();
    const options = [{ name: 'default', ttl: 60_000, limit: LIMIT }];
    // Print credentials in these tests are `ggprint.<user>.sig`; any
    // other signature counts as a bad one.
    const printRead = {
      signedUserId: (t: string) => (t.endsWith('.sig') ? t.split('.')[1]! : null),
    };
    address = new AddressThrottlerGuard(options, storage, new Reflector(), printRead as never);
    org = new OrgThrottlerGuard(options, storage, new Reflector());
    await address.onModuleInit();
    await org.onModuleInit();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
    if (before === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = before;
    resetTenancyModeForTests();
  });

  /** Both guards in the order the app runs them. */
  async function call(caller: Caller): Promise<'ok' | 'limited'> {
    const ctx = contextFor(caller);
    try {
      await address.canActivate(ctx);
      await org.canActivate(ctx);
      return 'ok';
    } catch (err) {
      if (err instanceof ThrottlerException) return 'limited';
      throw err;
    }
  }

  async function spend(caller: Caller, n: number): Promise<void> {
    for (let i = 0; i < n; i++) expect(await call(caller)).toBe('ok');
  }

  const a1 = { ip: '10.0.0.1', token: 't', user: { id: 'a1', orgId: ORG_A } };
  const a2 = { ip: '10.0.0.1', token: 't', user: { id: 'a2', orgId: ORG_A } };
  const b1 = { ip: '10.0.0.1', token: 't', user: { id: 'b1', orgId: ORG_B } };

  it('one organization: everyone behind one address shares its budget, as before', async () => {
    mode('single');
    await spend(a1, LIMIT);
    expect(await call(a1)).toBe('limited');
    expect(await call(b1)).toBe('limited');
    expect(await call({ ip: '10.0.0.2', token: 't', user: a1.user })).toBe('ok');
  });

  it('many organizations: a person at their limit does not stop another organization behind the same address', async () => {
    mode('multi');
    await spend(a1, LIMIT);
    expect(await call(a1)).toBe('limited');
    expect(await call(b1)).toBe('ok');
    expect(await call(a2)).toBe('ok');
  });

  it('many organizations: an organization at its ceiling does not stop another', async () => {
    mode('multi');
    const ceiling = LIMIT * ORG_CEILING_FACTOR;
    // Many people of org A, each under their own limit, on many addresses.
    let sent = 0;
    for (let p = 0; sent < ceiling; p++) {
      const caller = { ip: `10.1.0.${p}`, token: 't', user: { id: `a-${p}`, orgId: ORG_A } };
      for (let i = 0; i < LIMIT && sent < ceiling; i++, sent++) {
        expect(await call(caller)).toBe('ok');
      }
    }
    const fresh = { ip: '10.2.0.1', token: 't', user: { id: 'a-new', orgId: ORG_A } };
    expect(await call(fresh)).toBe('limited');
    expect(await call({ ip: '10.2.0.2', token: 't', user: b1.user })).toBe('ok');
  });

  it('many organizations: a 429 from the organization ceiling says when to retry, and nothing else', async () => {
    mode('multi');
    const ceiling = LIMIT * ORG_CEILING_FACTOR;
    let sent = 0;
    for (let p = 0; sent < ceiling; p++) {
      const caller = { ip: `10.1.0.${p}`, token: 't', user: { id: `a-${p}`, orgId: ORG_A } };
      for (let i = 0; i < LIMIT && sent < ceiling; i++, sent++) await call(caller);
    }
    sentHeaders.length = 0;
    expect(await call({ ip: '10.2.0.1', token: 't', user: { id: 'a-new', orgId: ORG_A } })).toBe(
      'limited',
    );
    const headers = sentHeaders.at(-1)!;
    const retry = headers.get('Retry-After');
    expect(typeof retry).toBe('number');
    expect(retry as number).toBeGreaterThan(0);
    expect(retry as number).toBeLessThanOrEqual(60);
    // The only rate numbers are the person's own: their limit, not the
    // organization's ceiling, and nothing counted across the organization.
    expect(headers.get('X-RateLimit-Limit')).toBe(LIMIT);
    expect(headers.get('X-RateLimit-Remaining')).toBe(LIMIT - 1);
    for (const [name, value] of headers) {
      if (name === 'Retry-After') continue;
      expect(name.toLowerCase()).toMatch(/^x-ratelimit-(limit|remaining|reset)$/);
      if (name !== 'X-RateLimit-Reset') expect(value).not.toBe(ceiling);
    }
  });

  it('many organizations: a request under the ceiling gets no Retry-After', async () => {
    mode('multi');
    sentHeaders.length = 0;
    expect(await call(a1)).toBe('ok');
    expect(sentHeaders.at(-1)!.has('Retry-After')).toBe(false);
  });

  it('one organization: a 429 carries the stock headers, as before', async () => {
    mode('single');
    await spend(a1, LIMIT);
    sentHeaders.length = 0;
    expect(await call(a1)).toBe('limited');
    expect(typeof sentHeaders.at(-1)!.get('Retry-After')).toBe('number');
  });

  it('many organizations: signed-out requests still count by address', async () => {
    mode('multi');
    const anon = { ip: '10.0.0.9' };
    await spend(anon, LIMIT);
    expect(await call(anon)).toBe('limited');
    expect(await call({ ip: '10.0.0.10' })).toBe('ok');
  });

  it('many organizations: a credential that signs nobody in shares the signed-out budget', async () => {
    mode('multi');
    const anon = { ip: '10.0.0.11' };
    await spend(anon, LIMIT);
    expect(await call({ ip: '10.0.0.11', token: 'bogus', user: null })).toBe('limited');
  });

  it('many organizations: credentials from one address are held to a wider address budget', async () => {
    mode('multi');
    const budget = LIMIT * CREDENTIALED_ADDRESS_FACTOR;
    for (let i = 0; i < budget; i++) {
      // A different person each time, so only the address count grows.
      const caller = { ip: '10.0.0.12', token: 't', user: { id: `p-${i}`, orgId: `org-${i}` } };
      expect(await call(caller)).toBe('ok');
    }
    const next = { ip: '10.0.0.12', token: 't', user: { id: 'p-last', orgId: 'org-last' } };
    expect(await call(next)).toBe('limited');
  });

  it('many organizations: a person held back no longer uses up the organization (several addresses)', async () => {
    mode('multi');
    const ceiling = LIMIT * ORG_CEILING_FACTOR;
    // One person sends more than the organization ceiling, spread over
    // addresses so that no address budget stops them first.
    const from = (ip: string) => ({ ip, token: 't', user: { id: 'a1', orgId: ORG_A } });
    let refused = 0;
    for (let i = 0; i < ceiling + LIMIT; i++) {
      if ((await call(from(`10.3.0.${i % 3}`))) === 'limited') refused += 1;
    }
    expect(refused).toBe(ceiling);
    // A colleague is not held back by the organization ceiling.
    expect(await call({ ip: '10.3.0.9', token: 't', user: { id: 'a2', orgId: ORG_A } })).toBe('ok');
  });

  it('one organization: a print credential counts by address, as before', async () => {
    mode('single');
    await spend(
      { ip: '10.4.0.1', token: 'ggprint.p1.sig', user: { id: 'p1', orgId: ORG_A } },
      LIMIT,
    );
    expect(
      await call({ ip: '10.4.0.1', token: 'ggprint.p2.sig', user: { id: 'p2', orgId: ORG_B } }),
    ).toBe('limited');
  });

  it('many organizations: print renders count against the person, not the server address', async () => {
    mode('multi');
    const budget = LIMIT * CREDENTIALED_ADDRESS_FACTOR;
    const server = '10.4.0.2';
    // Many people of A, each under their own limit, all printing
    // through the one server address with one person's credential.
    for (let i = 0; i < budget; i++) {
      const res = await address.canActivate(
        contextFor({ ip: server, token: 'ggprint.p1.sig', user: null }),
      );
      expect(res).toBe(true);
    }
    await expect(
      address.canActivate(contextFor({ ip: server, token: 'ggprint.p1.sig', user: null })),
    ).rejects.toBeInstanceOf(ThrottlerException);
    // Another person's print from the same address has its own budget.
    await expect(
      address.canActivate(contextFor({ ip: server, token: 'ggprint.p2.sig', user: null })),
    ).resolves.toBe(true);
    // A credential with a bad signature counts against the address.
    await expect(
      address.canActivate(contextFor({ ip: server, token: 'ggprint.p3.bad', user: null })),
    ).resolves.toBe(true);
  });
});

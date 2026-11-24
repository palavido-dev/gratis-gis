// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { resetTenancyModeForTests } from './tenancy.js';
import {
  RunAsSystem,
  assertTenantContext,
  currentTenant,
  requireOrgId,
  resetTenantContextReportsForTests,
  runAsAnonymous,
  runAsOrg,
  runAsSystem,
  tenantContextForCaller,
  tenantOrgId,
  type TenantContext,
} from './tenant-context.js';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function orgNow(): string | undefined {
  return tenantOrgId(currentTenant());
}

describe('tenant context', () => {
  it('is undefined outside any run', () => {
    expect(currentTenant()).toBeUndefined();
    expect(() => requireOrgId()).toThrow(/No organization/);
  });

  it('carries the org and user id', () => {
    runAsOrg(ORG_A, () => {
      expect(currentTenant()).toEqual({ kind: 'org', orgId: ORG_A });
      expect(requireOrgId()).toBe(ORG_A);
    });
    runAsOrg(
      ORG_A,
      () => {
        expect(currentTenant()).toEqual({
          kind: 'org',
          orgId: ORG_A,
          userId: 'u1',
        });
      },
      { userId: 'u1' },
    );
    expect(currentTenant()).toBeUndefined();
  });

  it('refuses an empty org id', () => {
    expect(() => runAsOrg('', () => 1)).toThrow(TypeError);
  });

  it('returns what the function returns, sync or async', async () => {
    expect(runAsSystem('test', () => 7)).toBe(7);
    await expect(runAsOrg(ORG_A, async () => 8)).resolves.toBe(8);
  });

  it('keeps two interleaved async chains apart at every step', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const chain = (label: string, orgId: string) =>
      runAsOrg(orgId, async () => {
        seen.push([label, orgNow()]);
        await tick();
        seen.push([label, orgNow()]);
        await sleep(5);
        seen.push([label, orgNow()]);
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            seen.push([label, orgNow()]);
            resolve();
          }, 1),
        );
        await Promise.all([tick(), sleep(2)]);
        seen.push([label, orgNow()]);
        return orgNow();
      });
    const [a, b] = await Promise.all([chain('a', ORG_A), chain('b', ORG_B)]);
    expect(a).toBe(ORG_A);
    expect(b).toBe(ORG_B);
    // The chains really did interleave.
    const labels = seen.map(([l]) => l).join('');
    expect(labels).not.toBe('aaaaabbbbb');
    for (const [label, org] of seen) {
      expect(org).toBe(label === 'a' ? ORG_A : ORG_B);
    }
    expect(currentTenant()).toBeUndefined();
  });

  it('does not bleed between many concurrent runs', async () => {
    const orgs = Array.from(
      { length: 50 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const results = await Promise.all(
      orgs.map((org, i) =>
        runAsOrg(org, async () => {
          await sleep((i * 7) % 5);
          await tick();
          return orgNow();
        }),
      ),
    );
    expect(results).toEqual(orgs);
  });

  it('restores the outer context after a nested run', async () => {
    await runAsOrg(ORG_A, async () => {
      expect(orgNow()).toBe(ORG_A);
      const inner = await runAsSystem('job-claim', async () => {
        await tick();
        return currentTenant();
      });
      expect(inner).toEqual({ kind: 'system', reason: 'job-claim' });
      expect(orgNow()).toBe(ORG_A);
      runAsAnonymous(() => {
        expect(currentTenant()).toEqual({ kind: 'anonymous' });
      });
      expect(orgNow()).toBe(ORG_A);
      await runAsOrg(ORG_B, async () => {
        await sleep(1);
        expect(orgNow()).toBe(ORG_B);
      });
      expect(orgNow()).toBe(ORG_A);
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('restores the outer context when the inner run throws', () => {
    runAsOrg(ORG_A, () => {
      expect(() =>
        runAsSystem('x', () => {
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(orgNow()).toBe(ORG_A);
    });
  });

  it('survives awaits inside a database-style client call', async () => {
    // Stand-in for a Prisma call: the work happens on a later turn of
    // the event loop, behind a promise the caller awaits. A real
    // Prisma round trip needs a database (see the PR notes).
    const fakeClient = {
      async findMany(): Promise<string | undefined> {
        await sleep(2);
        await new Promise<void>((r) => process.nextTick(r));
        return orgNow();
      },
    };
    const [a, b] = await Promise.all([
      runAsOrg(ORG_A, () => fakeClient.findMany()),
      runAsOrg(ORG_B, () => fakeClient.findMany()),
    ]);
    expect([a, b]).toEqual([ORG_A, ORG_B]);
  });

  it('carries the context into timers created inside a run', async () => {
    const got = await runAsOrg(
      ORG_A,
      () =>
        new Promise<string | undefined>((resolve) => {
          const t = setInterval(() => {
            clearInterval(t);
            resolve(orgNow());
          }, 1);
        }),
    );
    expect(got).toBe(ORG_A);
  });

  it('freezes the stored context', () => {
    runAsOrg(ORG_A, () => {
      const ctx = currentTenant() as { orgId: string };
      expect(Object.isFrozen(ctx)).toBe(true);
    });
  });
});

describe('tenantContextForCaller', () => {
  it('maps a signed-in user to an org context with the user id', () => {
    expect(tenantContextForCaller({ id: 'u1', orgId: ORG_A })).toEqual({
      kind: 'org',
      orgId: ORG_A,
      userId: 'u1',
    });
  });

  it('maps no user, or a user without an org, to anonymous', () => {
    const anon: TenantContext = { kind: 'anonymous' };
    expect(tenantContextForCaller(null)).toEqual(anon);
    expect(tenantContextForCaller(undefined)).toEqual(anon);
    expect(tenantContextForCaller({ id: 'u1' })).toEqual(anon);
    expect(tenantContextForCaller({ id: 'u1', orgId: '' })).toEqual(anon);
  });
});

describe('@RunAsSystem', () => {
  class Jobs {
    seen: TenantContext | undefined;
    calls: unknown[] = [];

    @Cron('0 3 * * *', { name: 'decorated-below' })
    @RunAsSystem('cron:below')
    async below(arg: number): Promise<number> {
      await tick();
      this.seen = currentTenant();
      this.calls.push(arg);
      return arg * 2;
    }

    @RunAsSystem('cron:above')
    @Cron('0 4 * * *', { name: 'decorated-above' })
    above(): TenantContext | undefined {
      return currentTenant();
    }
  }

  it('runs the method as system work with its own this and arguments', async () => {
    const jobs = new Jobs();
    await expect(jobs.below(21)).resolves.toBe(42);
    expect(jobs.seen).toEqual({ kind: 'system', reason: 'cron:below' });
    expect(jobs.calls).toEqual([21]);
    expect(jobs.above()).toEqual({ kind: 'system', reason: 'cron:above' });
  });

  it('overrides an outer context for the call only', () => {
    const jobs = new Jobs();
    runAsOrg(ORG_A, () => {
      expect(jobs.above()).toEqual({ kind: 'system', reason: 'cron:above' });
      expect(orgNow()).toBe(ORG_A);
    });
  });

  it('keeps the @Cron metadata in either decorator order', () => {
    class Plain {
      @Cron('0 5 * * *', { name: 'plain' })
      plain(): void {}
    }
    const cronKeys = Reflect.getOwnMetadataKeys(Plain.prototype.plain);
    expect(cronKeys.length).toBeGreaterThan(0);
    const names = (fn: object) => cronKeys.map((k) => Reflect.getOwnMetadata(k, fn) as unknown);
    for (const fn of [Jobs.prototype.below, Jobs.prototype.above]) {
      for (const value of names(fn)) expect(value).toBeDefined();
    }
    expect(JSON.stringify(names(Jobs.prototype.below))).toContain('decorated-below');
    expect(JSON.stringify(names(Jobs.prototype.above))).toContain('decorated-above');
    expect(Jobs.prototype.below.name).toBe('below');
  });
});

describe('assertTenantContext', () => {
  const saved = {
    tenancy: process.env.GRATIS_TENANCY,
    strict: process.env.GRATIS_TENANCY_STRICT,
  };
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    resetTenantContextReportsForTests();
  });

  afterEach(() => {
    warn.mockRestore();
    restore('GRATIS_TENANCY', saved.tenancy);
    restore('GRATIS_TENANCY_STRICT', saved.strict);
    resetTenancyModeForTests();
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  function setMode(tenancy: string | undefined, strict: string | undefined) {
    restore('GRATIS_TENANCY', tenancy);
    restore('GRATIS_TENANCY_STRICT', strict);
    resetTenancyModeForTests();
  }

  it('is silent unless multi mode and strict are both on', () => {
    setMode(undefined, '1');
    expect(assertTenantContext()).toBe(true);
    setMode('multi', undefined);
    expect(assertTenantContext()).toBe(true);
    setMode('single', '1');
    expect(assertTenantContext()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs once per call site when there is no context', () => {
    setMode('multi', '1');
    const siteA = () => assertTenantContext('site-a');
    const siteB = () => assertTenantContext('site-b');
    expect(siteA()).toBe(false);
    expect(siteA()).toBe(false);
    expect(siteB()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/No tenant context at site-a/);
  });

  it('passes when a context is present', () => {
    setMode('multi', '1');
    expect(runAsSystem('x', () => assertTenantContext())).toBe(true);
    expect(runAsAnonymous(() => assertTenantContext())).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { resetTenancyModeForTests } from '../common/tenancy.js';
import { currentTenant } from '../common/tenant-context.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  ORG_SCOPED_WHEN_MULTI,
  OperatorOrgGuard,
  checkOperatorOrgConfig,
  operatorOrgId,
} from './operator-org.js';

/**
 * When the install serves many organizations, the operator is only
 * ever the org GRATIS_OPERATOR_ORG_ID names. Unset means nobody: the
 * "oldest organization" fallback a one-org install uses would hand
 * install-wide powers to whichever customer signed up first.
 */
const ORG_A = '50000000-0000-4000-8000-00000000000a';
const ORG_B = '50000000-0000-4000-8000-00000000000b';
const SRC = join(__dirname, '..');

const admin = (orgId: string): AuthUser =>
  ({
    id: `admin-${orgId}`,
    orgId,
    orgSlug: orgId,
    username: `admin-${orgId}`,
    email: `admin-${orgId}@example.test`,
    orgRole: 'admin',
    groupIds: [],
    capabilities: new Set(),
  }) as unknown as AuthUser;

/** Two orgs; the oldest is ORG_A. Records the context of each read. */
function twoOrgs() {
  const contexts: unknown[] = [];
  const prisma = {
    organization: {
      findFirst: jest.fn(async (args: { where?: { id: string } }) => {
        contexts.push(currentTenant());
        if (args.where)
          return [ORG_A, ORG_B].includes(args.where.id) ? { id: args.where.id } : null;
        return { id: ORG_A };
      }),
    },
  };
  return { prisma, contexts };
}

type Ctor = { new (...args: never[]): unknown; prototype: Record<string, unknown> };

/** Every controller file that uses OperatorOrgGuard. */
function guardedControllers(): Array<{ file: string; cls: Ctor }> {
  const out: Array<{ file: string; cls: Ctor }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.controller.ts')) continue;
      if (!readFileSync(full, 'utf8').includes('OperatorOrgGuard')) continue;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(full) as Record<string, unknown>;
      for (const v of Object.values(mod)) {
        if (typeof v === 'function' && Reflect.getMetadata(PATH_METADATA, v) !== undefined) {
          out.push({ file: relative(SRC, full), cls: v as Ctor });
        }
      }
    }
  };
  walk(SRC);
  return out;
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}

/** Every route handler that runs OperatorOrgGuard. */
function operatorRoutes(): Array<{ route: string; handler: (...a: unknown[]) => unknown }> {
  const routes: Array<{ route: string; handler: (...a: unknown[]) => unknown }> = [];
  for (const { file, cls } of guardedControllers()) {
    const classGuarded = guardsOf(cls).includes(OperatorOrgGuard);
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      if (name === 'constructor') continue;
      const fn = cls.prototype[name];
      if (typeof fn !== 'function' || Reflect.getMetadata(PATH_METADATA, fn) === undefined)
        continue;
      if (classGuarded || guardsOf(fn).includes(OperatorOrgGuard)) {
        routes.push({ route: `${file}#${name}`, handler: fn as (...a: unknown[]) => unknown });
      }
    }
  }
  return routes;
}

function contextFor(user: AuthUser, handler: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** Routes whose setting each org owns once the install serves many. */
const ORG_SCOPED_IN_MULTI = [
  'admin/admin-security.controller.ts#getEmbedOrigins',
  'admin/admin-security.controller.ts#putEmbedOrigins',
];

describe('operator organization in multi mode', () => {
  const saved = {
    tenancy: process.env.GRATIS_TENANCY,
    operator: process.env.GRATIS_OPERATOR_ORG_ID,
  };

  function setEnv(tenancy: string | undefined, operator: string | undefined): void {
    if (tenancy === undefined) delete process.env.GRATIS_TENANCY;
    else process.env.GRATIS_TENANCY = tenancy;
    if (operator === undefined) delete process.env.GRATIS_OPERATOR_ORG_ID;
    else process.env.GRATIS_OPERATOR_ORG_ID = operator;
    resetTenancyModeForTests();
  }

  afterEach(() => setEnv(saved.tenancy, saved.operator));

  const routes = operatorRoutes();

  it('finds the operator routes', () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it('has no "oldest organization" fallback', async () => {
    setEnv('multi', undefined);
    const { prisma } = twoOrgs();
    await expect(operatorOrgId(prisma)).resolves.toBeNull();
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
  });

  it.each(routes.map((r) => [r.route, r.handler] as const))(
    'unset operator id: %s refuses every org admin',
    async (route, handler) => {
      setEnv('multi', undefined);
      const { prisma } = twoOrgs();
      const guard = new OperatorOrgGuard(prisma as unknown as PrismaService);
      if (ORG_SCOPED_IN_MULTI.includes(route)) {
        // Each org's own setting: the admin check beside it applies.
        await expect(guard.canActivate(contextFor(admin(ORG_A), handler))).resolves.toBe(true);
        return;
      }
      for (const orgId of [ORG_A, ORG_B]) {
        await expect(guard.canActivate(contextFor(admin(orgId), handler))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      }
    },
  );

  it('lists exactly the routes marked org scoped', () => {
    const marked = routes
      .filter((r) => Reflect.getMetadata(ORG_SCOPED_WHEN_MULTI, r.handler) === true)
      .map((r) => r.route)
      .sort();
    expect(marked).toEqual([...ORG_SCOPED_IN_MULTI].sort());
  });

  it('a set operator id makes only that org the operator, read as system work', async () => {
    setEnv('multi', ORG_B);
    const { prisma, contexts } = twoOrgs();
    const guard = new OperatorOrgGuard(prisma as unknown as PrismaService);
    const handler = routes.find((r) => !ORG_SCOPED_IN_MULTI.includes(r.route))!.handler;
    await expect(guard.canActivate(contextFor(admin(ORG_B), handler))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor(admin(ORG_A), handler))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(contexts).toEqual([
      { kind: 'system', reason: 'operator-check' },
      { kind: 'system', reason: 'operator-check' },
    ]);
  });

  it('single mode is unchanged: the oldest org, and marked routes stay operator only', async () => {
    setEnv(undefined, undefined);
    const { prisma } = twoOrgs();
    const guard = new OperatorOrgGuard(prisma as unknown as PrismaService);
    for (const route of routes.filter((r) => ORG_SCOPED_IN_MULTI.includes(r.route))) {
      await expect(guard.canActivate(contextFor(admin(ORG_A), route.handler))).resolves.toBe(true);
      await expect(
        guard.canActivate(contextFor(admin(ORG_B), route.handler)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  describe('boot check', () => {
    it('logs an error in multi mode when the operator id is unset', () => {
      setEnv('multi', undefined);
      const log = { error: jest.fn() };
      expect(checkOperatorOrgConfig(log)).toBe(false);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('GRATIS_OPERATOR_ORG_ID'));
    });

    it('is quiet when it is set, and in single mode', () => {
      const log = { error: jest.fn() };
      setEnv('multi', ORG_A);
      expect(checkOperatorOrgConfig(log)).toBe(true);
      setEnv(undefined, undefined);
      expect(checkOperatorOrgConfig(log)).toBe(true);
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});

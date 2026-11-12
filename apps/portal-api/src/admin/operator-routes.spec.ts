// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { OperatorOrgGuard } from '../backup/operator-org.js';

/**
 * Every controller behind AdminGuard must be classified here. An
 * org admin is not an operator: a route that reads or changes
 * something shared by every organization on the install (the
 * Keycloak realm, SMTP, the housekeeping schedule, the backup set,
 * install-wide tables) must also carry OperatorOrgGuard.
 *
 * A new admin controller, or a new route on a mixed controller,
 * fails this spec until someone decides which side it is on.
 *
 * By design, a new route on a controller classified `org` or
 * `operator` passes without review: the class-level rule covers it.
 * An `operator` controller guards at the class, so the new route is
 * operator-only. On an `org` controller the reviewer of that change
 * must check the new route really is org scoped; if it is not, move
 * the controller to `mixed`.
 */

type Rule =
  // Every route in the controller is install-wide.
  | { kind: 'operator' }
  // Every route acts on the caller's own organization.
  | { kind: 'org'; why: string }
  // Some of each. Every route handler must be listed in one of the
  // two arrays.
  | { kind: 'mixed'; operator: string[]; org: string[] };

const RULES: Record<string, Rule> = {
  'admin/admin-security.controller.ts': { kind: 'operator' },
  'admin/maintenance-admin.controller.ts': { kind: 'operator' },
  'admin/readiness.controller.ts': { kind: 'operator' },
  'backup/backup.controller.ts': { kind: 'operator' },
  'feedback/feedback-admin.controller.ts': { kind: 'operator' },
  'notifications/admin.controller.ts': {
    kind: 'mixed',
    operator: [
      'stats',
      'recent',
      'retry',
      'getSmtp',
      'saveSmtp',
      'testSmtp',
      'putDefault',
    ],
    org: [
      'listDefaults',
      'preview',
      'listTemplates',
      'getTemplate',
      'putTemplate',
      'deleteTemplate',
      'previewTemplate',
    ],
  },
  'admin/housekeeping.controller.ts': {
    kind: 'mixed',
    operator: [
      'storage',
      'largestTables',
      'updateConfig',
      'listRuns',
      'runNow',
      'orphanedUploads',
      'purgeOrphanedUploads',
      // Install-wide: lists the biggest fs_ tables across every org.
      'largestDataLayers',
    ],
    org: [
      'summary',
      'staleItems',
      'danglingReferences',
      'staleUsers',
      'largeItems',
      'expiringShares',
      'expiringUsers',
      'getConfig',
      'recomputeExtents',
      'buildSearchIndexes',
    ],
  },
  'import-ago/import-ago.controller.ts': {
    kind: 'mixed',
    operator: ['createConnection', 'updateConnection', 'deleteConnection'],
    org: [
      'listConnections',
      'getConnection',
      'startOauth',
      'preview',
      'run',
      'runStart',
      'runStatus',
      'runCancel',
    ],
  },
  'admin/admin-app-templates.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'admin/admin-audit.controller.ts': { kind: 'org', why: 'lists the caller org audit only' },
  'admin/admin-basemap-probe.controller.ts': {
    kind: 'org',
    why: 'stateless probe of a URL through safeFetch',
  },
  'admin/admin-branding.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'admin/admin-capabilities.controller.ts': { kind: 'org', why: 'target user checked against user.orgId' },
  'admin/admin-integrations.controller.ts': { kind: 'org', why: 'organization row of the caller' },
  'admin/admin-themes.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'admin/admin-users.controller.ts': { kind: 'org', why: 'target user checked against user.orgId' },
  'admin/diagnostics.controller.ts': {
    kind: 'org',
    why: 'the service splits install and org sections itself',
  },
  'admin/jobs-monitor.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'admin/onboarding.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'admin/permissions-report.controller.ts': { kind: 'org', why: 'scoped by user.orgId' },
  'field-queue/field-queue-admin.controller.ts': { kind: 'org', why: 'rows joined to user.orgId' },
  'llm/ai-admin.controller.ts': { kind: 'org', why: 'AI config keyed by orgId' },
  'updates/updates.controller.ts': { kind: 'org', why: 'read-only release check, no data' },
};

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function adminGuardedFiles(): string[] {
  return controllerFiles(SRC)
    .filter((f) => /@UseGuards\([^)]*\bAdminGuard\b/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f).split('\\').join('/'))
    .sort();
}

type Ctor = { prototype: Record<string, unknown>; name: string };

function loadController(file: string): Ctor {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(join(SRC, file)) as Record<string, unknown>;
  const found = Object.values(mod).filter(
    (v): v is Ctor =>
      typeof v === 'function' && Reflect.getMetadata(PATH_METADATA, v) !== undefined,
  );
  if (found.length !== 1) throw new Error(`${file}: expected one controller class`);
  return found[0] as Ctor;
}

function routeHandlers(cls: Ctor): string[] {
  return Object.getOwnPropertyNames(cls.prototype).filter((name) => {
    if (name === 'constructor') return false;
    const fn = cls.prototype[name];
    return typeof fn === 'function' && Reflect.getMetadata(PATH_METADATA, fn) !== undefined;
  });
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}

function routeHasOperatorGuard(cls: Ctor, method: string): boolean {
  return (
    guardsOf(cls).includes(OperatorOrgGuard) ||
    guardsOf(cls.prototype[method] as object).includes(OperatorOrgGuard)
  );
}

describe('install-wide admin routes', () => {
  const files = adminGuardedFiles();

  it('finds the admin controllers', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('classifies every AdminGuard controller', () => {
    const missing = files.filter((f) => RULES[f] === undefined);
    expect(missing).toEqual([]);
    const stale = Object.keys(RULES).filter((f) => !files.includes(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(RULES))('%s matches its rule', (file, rule) => {
    const cls = loadController(file);
    const handlers = routeHandlers(cls);
    expect(handlers.length).toBeGreaterThan(0);

    if (rule.kind === 'operator') {
      expect(guardsOf(cls)).toContain(OperatorOrgGuard);
      return;
    }
    if (rule.kind === 'org') {
      const guarded = handlers.filter((h) => routeHasOperatorGuard(cls, h));
      // An org-scoped controller that gained an operator route is
      // mixed now; move it there.
      expect(guarded).toEqual([]);
      return;
    }
    const listed = [...rule.operator, ...rule.org].sort();
    expect([...handlers].sort()).toEqual(listed);
    for (const h of rule.operator) {
      expect([h, routeHasOperatorGuard(cls, h)]).toEqual([h, true]);
    }
    for (const h of rule.org) {
      expect([h, routeHasOperatorGuard(cls, h)]).toEqual([h, false]);
    }
  });
});

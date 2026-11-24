// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every route the API registers must have an entry in routes.ts, so
// nobody adds a controller route without deciding which organization
// may reach it. Runs without a database.

import { AppModule } from '../../app.module.js';
import { discoverRoutes } from './route-discovery.js';
import { ROUTES } from './routes.js';

const CONFIG_FOR_IMPORT: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
};

describe('isolation route table', () => {
  for (const [k, v] of Object.entries(CONFIG_FOR_IMPORT)) process.env[k] ??= v;
  const routes = discoverRoutes(AppModule);
  const registered = new Set(routes.map((r) => r.key));

  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('classifies every registered route', () => {
    const missing = routes
      .filter((r) => !(r.key in ROUTES))
      .map((r) => `${r.key}  (${r.controller}#${r.handler})`);
    if (missing.length > 0) {
      throw new Error(
        `Routes missing from src/testing/isolation/routes.ts (see docs/testing/org-isolation.md):\n  ${missing.join('\n  ')}`,
      );
    }
  });

  it('lists no route that is gone', () => {
    const stale = Object.keys(ROUTES).filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
  });

  it('keeps operator-only for routes behind the operator guard, and only those', () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const entry = ROUTES[r.key];
      if (!entry) continue;
      const guarded = r.guards.includes('OperatorOrgGuard');
      if (entry.cls === 'operator-only' && !guarded)
        wrong.push(`${r.key} is not behind the operator guard`);
      if (guarded && entry.cls !== 'operator-only' && !ORG_SCOPED_WHEN_MULTI.has(r.key)) {
        wrong.push(`${r.key} is behind the operator guard but classified ${entry.cls}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives a reason for every route it does not probe', () => {
    const silent = Object.entries(ROUTES)
      .filter(([, e]) => (e.check === 'skip' || e.control === 'skip') && !e.reason)
      .map(([k]) => k);
    expect(silent).toEqual([]);
  });

  it('marks @Public routes as public or no-tenant-data', () => {
    const wrong = routes
      .filter((r) => r.isPublic)
      .filter((r) => ROUTES[r.key] && ROUTES[r.key]!.cls === 'operator-only')
      .map((r) => r.key);
    expect(wrong).toEqual([]);
  });
});

/** Operator-guarded routes whose setting each org owns in multi mode. */
const ORG_SCOPED_WHEN_MULTI = new Set([
  'GET /api/admin/security/embed-origins',
  'PUT /api/admin/security/embed-origins',
]);

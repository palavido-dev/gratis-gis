// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two-organization isolation suite, run once per tenancy mode by
// isolation.multi.pg.spec.ts and isolation.single.pg.spec.ts.
//
// Every route in routes.ts is probed according to its check. A route
// listed in known-gaps.ts for the mode must still fail (so the list
// shrinks when a gap is fixed); every other route must pass.

import { Pool } from 'pg';

import type { TenancyMode } from '../../common/tenancy.js';
import {
  changedTables,
  fingerprint,
  resetFingerprintPlan,
  type Fingerprint,
} from './fingerprint.js';
import {
  bootIsolationApp,
  createMigratedDatabase,
  dropDatabase,
  type IsolationApp,
} from './harness.js';
import { KNOWN_GAPS, type KnownGap } from './known-gaps.js';
import { DEFAULT_PARAMS, ROUTES, type Ref, type RouteEntry } from './routes.js';
import { api, orgId, seedTwoOrgs, type ApiResult, type Fixtures, type OrgFixture } from './seed.js';

export type Verdict = { ok: boolean; problems: string[] };

export type SuiteState = {
  mode: TenancyMode;
  app: IsolationApp;
  fx: Fixtures;
  pool: Pool;
  databaseUrl: string;
};

const is2xx = (s: number): boolean => s >= 200 && s < 300;

// ---------------------------------------------------------------- refs and requests

export function resolveRef(ref: Ref, victim: OrgFixture, caller: OrgFixture): string {
  if (ref.startsWith('=')) return ref.slice(1);
  if (ref.startsWith('own:')) return resolveRef(ref.slice(4), caller, caller);
  const fail = (): never => {
    throw new Error(`fixture "${ref}" is missing for org ${victim.key}`);
  };
  switch (ref) {
    case 'feature':
      return victim.featureIds[0] ?? fail();
    case 'publicFeature':
      return victim.publicFeatureIds[0] ?? fail();
    case 'group':
      return victim.groupId || fail();
    case 'thread':
      return victim.threadId ?? fail();
    case 'reply':
      return victim.replyId ?? fail();
    case 'drawing':
      return victim.drawingId ?? fail();
    case 'snapshot':
      return victim.snapshotId ?? fail();
    case 'apiKey':
      return victim.apiKeyId ?? fail();
    case 'attachment':
      return victim.attachmentId ?? fail();
    case 'notification':
      return victim.notificationId || fail();
    case 'attachmentKey':
      return victim.attachmentKey || fail();
    default:
      break;
  }
  if (ref.startsWith('job:')) return victim.jobs[ref.slice(4)] ?? fail();
  if (ref.startsWith('user:')) return victim.users[ref.slice(5) as 'admin']?.id ?? fail();
  return victim.items[ref] ?? fail();
}

/** The same ref for the org's public twin (public item, public feature). */
/** The same ref for the org's `org` access twin (visible to its own members). */
function orgTwin(ref: Ref): Ref {
  return ref.replace(/:private$/, ':org');
}

function publicTwin(ref: Ref): Ref {
  if (ref === 'feature') return 'publicFeature';
  return ref.replace(/:private$/, ':public');
}

function twinOf(ref: Ref, opts: { publicTwin?: boolean; orgTwin?: boolean }): Ref {
  if (opts.publicTwin) return publicTwin(ref);
  if (opts.orgTwin) return orgTwin(ref);
  return ref;
}

export type BuiltRequest = { method: string; path: string; body: unknown };

export function buildRequest(
  key: string,
  entry: RouteEntry,
  victim: OrgFixture,
  caller: OrgFixture,
  opts: { publicTwin?: boolean; orgTwin?: boolean } = {},
): BuiltRequest {
  const [method, template] = key.split(' ') as [string, string];
  const refFor = (name: string): Ref => {
    const ref = entry.params?.[name] ?? DEFAULT_PARAMS[name] ?? `=${name}`;
    return twinOf(ref, opts);
  };
  let path = template
    .replace(/\/\*$/, '/x')
    .replace(/(?<=\/):([A-Za-z]+)/g, (_m, name: string) =>
      encodeURIComponent(resolveRef(refFor(name), victim, caller)),
    );
  const q = new URLSearchParams();
  for (const [k, ref] of Object.entries(entry.query ?? {})) {
    q.set(k, resolveRef(twinOf(ref, opts), victim, caller));
  }
  if ([...q.keys()].length > 0) path += `?${q.toString()}`;
  const body = entry.body
    ? entry.body(victim, caller)
    : method === 'GET' || method === 'DELETE'
      ? undefined
      : {};
  return { method, path, body };
}

/** Victim secrets in a response, leaving out any the request itself carried. */
export function leakedSecrets(res: ApiResult, req: BuiltRequest, victim: OrgFixture): string[] {
  const sent = req.path + JSON.stringify(req.body ?? '');
  return victim.secrets.filter((s) => res.text.includes(s) && !sent.includes(s));
}

const short = (r: ApiResult): string =>
  `${r.status} ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`;

// ---------------------------------------------------------------- checks

async function snapshot(state: SuiteState): Promise<Fingerprint> {
  return fingerprint(state.pool, state.fx.A.orgId);
}

async function call(
  state: SuiteState,
  who: { token: string } | null,
  req: BuiltRequest,
): Promise<ApiResult> {
  return api(state.app.baseUrl, who, req.method, req.path, req.body);
}

export async function runCheck(state: SuiteState, key: string, base: RouteEntry): Promise<Verdict> {
  const { fx, mode } = state;
  const entry: RouteEntry = mode === 'single' && base.single ? { ...base, ...base.single } : base;
  const A = fx.A;
  const B = fx.B;
  const problems: string[] = [];
  const req = buildRequest(key, entry, A, B);

  switch (entry.check) {
    case 'read': {
      const r = await call(state, B.users.admin, req);
      const expect = entry.expect ?? [404];
      if (!expect.includes(r.status))
        problems.push(`B with A's ids: expected ${expect.join('/')}, got ${short(r)}`);
      const leaks = leakedSecrets(r, req, A);
      if (leaks.length) problems.push(`B saw A's data: ${leaks.join(', ')}`);
      await controlCall(state, entry, req, problems);
      await orgTwinProbe(state, key, entry, req, problems);
      break;
    }
    case 'write': {
      const before = await snapshot(state);
      const r = await call(state, B.users.admin, req);
      const after = await snapshot(state);
      const expect = entry.expect ?? [404];
      if (!expect.includes(r.status))
        problems.push(`B with A's ids: expected ${expect.join('/')}, got ${short(r)}`);
      const changed = changedTables(before, after);
      if (changed.length) problems.push(`A's rows changed: ${changed.join(', ')}`);
      const leaks = leakedSecrets(r, req, A);
      if (leaks.length) problems.push(`B saw A's data: ${leaks.join(', ')}`);
      await orgTwinProbe(state, key, entry, req, problems);
      break;
    }
    case 'list':
    case 'none':
    case 'own': {
      const before = entry.check === 'own' ? await snapshot(state) : undefined;
      const r = await call(state, B.users.admin, req);
      const expect = entry.expect ?? [200, 201, 204];
      if (!expect.includes(r.status))
        problems.push(`B: expected ${expect.join('/')}, got ${short(r)}`);
      const leaks = leakedSecrets(r, req, A);
      if (leaks.length) problems.push(`B saw A's data: ${leaks.join(', ')}`);
      if (before) {
        const changed = changedTables(before, await snapshot(state));
        if (changed.length) problems.push(`A's rows changed: ${changed.join(', ')}`);
      }
      break;
    }
    case 'public': {
      const before = req.method === 'GET' ? undefined : await snapshot(state);
      for (const [who, label] of [
        [null, 'anonymous'],
        [B.users.admin, 'B'],
      ] as const) {
        const r = await call(state, who, req);
        const expect = entry.expect ?? [404];
        if (!expect.includes(r.status)) {
          problems.push(
            `${label} with A's private ids: expected ${expect.join('/')}, got ${short(r)}`,
          );
        }
        const leaks = leakedSecrets(r, req, A);
        if (leaks.length) problems.push(`${label} saw A's data: ${leaks.join(', ')}`);
      }
      if (before) {
        const changed = changedTables(before, await snapshot(state));
        if (changed.length) problems.push(`A's rows changed: ${changed.join(', ')}`);
      }
      if (entry.control !== 'skip') {
        const twin = buildRequest(key, entry, A, B, { publicTwin: true });
        const r = await call(state, null, twin);
        const ok = entry.control ?? [200, 201, 204];
        if (!ok.includes(r.status))
          problems.push(
            `control (anonymous, A's public ids): expected ${ok.join('/')}, got ${short(r)}`,
          );
      }
      break;
    }
    case 'public-list': {
      const [, path] = key.split(' ') as [string, string];
      const noOrg = await api(state.app.baseUrl, null, 'GET', path);
      // Fail closed: 404, or an answer that names no org's items.
      const names = (r: ApiResult): boolean =>
        [...Object.values(A.items), ...Object.values(B.items)].some((id) => r.text.includes(id));
      if (mode === 'multi' && noOrg.status !== 404 && !(is2xx(noOrg.status) && !names(noOrg))) {
        problems.push(`no ?org= in multi mode: expected 404 or nothing, got ${short(noOrg)}`);
      }
      if (mode === 'single' && !is2xx(noOrg.status))
        problems.push(`no ?org= in single mode: expected 2xx, got ${short(noOrg)}`);
      const unknown = await api(state.app.baseUrl, null, 'GET', `${path}?org=no-such-org`);
      if (unknown.status !== 404 && !(is2xx(unknown.status) && !names(unknown))) {
        problems.push(`unknown ?org=: expected 404 or nothing, got ${short(unknown)}`);
      }
      for (const [who, label] of [
        [null, 'anonymous'],
        [B.users.admin, 'B'],
      ] as const) {
        const r = await api(state.app.baseUrl, who, 'GET', `${path}?org=${A.slug}`);
        if (!is2xx(r.status))
          problems.push(`${label} with ?org=<A>: expected 2xx, got ${short(r)}`);
        const leaks = A.secrets.filter((s) => r.text.includes(s));
        if (leaks.length)
          problems.push(`${label} with ?org=<A> saw A's non-public data: ${leaks.join(', ')}`);
        if (path.endsWith('/items') || path.endsWith('/landing') || path.endsWith('catalog.json')) {
          const bIds = Object.values(B.items).filter((id) => r.text.includes(id));
          if (bIds.length) problems.push(`${label} with ?org=<A> saw B's items`);
        }
      }
      break;
    }
    case 'operator': {
      const opId = orgId('OP');
      const expectRefused = mode === 'multi' ? [A.users.admin, B.users.admin] : [B.users.admin];
      for (const who of expectRefused) {
        const r = await call(state, who, req);
        if (r.status !== 403) problems.push(`${who.username}: expected 403, got ${short(r)}`);
      }
      // The operator's own call is made for reads only: a write would
      // really run (a backup, maintenance mode).
      if (req.method === 'GET') {
        const operator = mode === 'multi' ? fx.OP.users.admin : A.users.admin;
        const r = await call(state, operator, req);
        if (r.status === 401 || r.status === 403) {
          problems.push(`operator admin was refused: ${short(r)}`);
        }
      }
      // With no operator named, the guard refuses everyone before the
      // handler runs, so writes are safe to try here.
      if (mode === 'multi') {
        const saved = process.env.GRATIS_OPERATOR_ORG_ID;
        delete process.env.GRATIS_OPERATOR_ORG_ID;
        try {
          const unset = await call(state, fx.OP.users.admin, req);
          if (unset.status !== 403) {
            problems.push(`operator id unset: expected 403 for everyone, got ${short(unset)}`);
          }
        } finally {
          process.env.GRATIS_OPERATOR_ORG_ID = saved ?? opId;
        }
      }
      break;
    }
    case 'legacy': {
      const before = req.method === 'GET' ? undefined : await snapshot(state);
      const callers = mode === 'multi' ? [B.users.admin, A.users.admin] : [B.users.admin];
      const expect = entry.expect ?? [404];
      for (const who of callers) {
        const r = await call(state, who, req);
        if (!expect.includes(r.status)) {
          problems.push(`${who.username}: expected ${expect.join('/')}, got ${short(r)}`);
        }
      }
      if (before) {
        const changed = changedTables(before, await snapshot(state));
        if (changed.length) problems.push(`A's rows changed: ${changed.join(', ')}`);
      }
      break;
    }
    case 'skip':
      break;
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The same probe against A's `org` access item, which every member of
 * A may read: org-wide visibility must not reach another org.
 */
async function orgTwinProbe(
  state: SuiteState,
  key: string,
  entry: RouteEntry,
  req: BuiltRequest,
  problems: string[],
): Promise<void> {
  const { A, B } = state.fx;
  let twin: BuiltRequest;
  try {
    twin = buildRequest(key, entry, A, B, { orgTwin: true });
  } catch {
    return; // no org-access twin of this fixture
  }
  if (twin.path === req.path) return;
  const before = req.method === 'GET' ? undefined : await snapshot(state);
  const r = await call(state, B.users.admin, twin);
  const expect = entry.expect ?? [404];
  if (!expect.includes(r.status)) {
    problems.push(`B with A's org-access ids: expected ${expect.join('/')}, got ${short(r)}`);
  }
  const leaks = leakedSecrets(r, twin, A);
  if (leaks.length) problems.push(`B saw A's data through an org-access item: ${leaks.join(', ')}`);
  if (before) {
    const changed = changedTables(before, await snapshot(state));
    if (changed.length)
      problems.push(`A's rows changed through an org-access item: ${changed.join(', ')}`);
  }
}

async function controlCall(
  state: SuiteState,
  entry: RouteEntry,
  req: BuiltRequest,
  problems: string[],
): Promise<void> {
  if (entry.control === 'skip') return;
  const r = await call(state, state.fx.A.users.admin, req);
  const ok = entry.control ?? [200, 201, 204];
  if (!ok.includes(r.status))
    problems.push(`control (A's admin, own ids): expected ${ok.join('/')}, got ${short(r)}`);
}

// ---------------------------------------------------------------- suite

export function gapFor(mode: TenancyMode, key: string): KnownGap | undefined {
  const gap = KNOWN_GAPS[key];
  return gap && gap.modes.includes(mode) ? gap : undefined;
}

/** Assert a verdict against the known gaps for the mode. */
export function expectVerdict(mode: TenancyMode, key: string, v: Verdict): void {
  const gap = gapFor(mode, key);
  if (gap) {
    if (v.ok) {
      throw new Error(
        `${key} now passes in ${mode} mode. Remove it from known-gaps.ts (${gap.area}: ${gap.note}).`,
      );
    }
    return;
  }
  if (!v.ok) throw new Error(`${key} (${mode}):\n  ${v.problems.join('\n  ')}`);
}

export async function startSuite(mode: TenancyMode, baseUrl: string): Promise<SuiteState> {
  const name = `gg_isolation_${mode}`;
  const databaseUrl = await createMigratedDatabase(baseUrl, name);
  resetFingerprintPlan();
  const app = await bootIsolationApp({
    mode,
    databaseUrl,
    operatorOrgId: mode === 'multi' ? orgId('OP') : undefined,
  });
  const fx = await seedTwoOrgs(databaseUrl, app.baseUrl, app.realm);
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  return { mode, app, fx, pool, databaseUrl };
}

export async function stopSuite(
  state: SuiteState | undefined,
  baseUrl: string,
  mode: TenancyMode,
): Promise<void> {
  await state?.pool.end();
  await state?.app.close();
  await dropDatabase(baseUrl, `gg_isolation_${mode}`);
}

/** Routes in the order the suite probes them: reads, then writes, deletes last. */
export function probeOrder(): Array<[string, RouteEntry]> {
  const rank = (k: string): number => (k.startsWith('GET ') ? 0 : k.startsWith('DELETE ') ? 2 : 1);
  return Object.entries(ROUTES)
    .filter(([, e]) => e.check !== 'skip')
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { currentTenant, runAsAnonymous } from '../common/tenant-context.js';
import type { LeaderElectionService } from '../cron/leader-election.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { dataLayerScopes } from './feature-oid.js';
import {
  FeatureOidService,
  LAYER_PREPARING_MESSAGE,
  REQUEST_BACKFILL_WAIT_MS,
} from './feature-oid.service.js';

describe('dataLayerScopes', () => {
  it('lists one scope per v3 sublayer and table', () => {
    expect(
      dataLayerScopes('i1', { version: 3, layers: [{ id: 'parcels' }, { id: 'owners' }] }),
    ).toEqual(['data_layer:i1:parcels', 'data_layer:i1:owners']);
  });

  it('has none for legacy or malformed data', () => {
    expect(dataLayerScopes('i1', { version: 2, layers: [{ id: 'x' }] })).toEqual([]);
    expect(dataLayerScopes('i1', null)).toEqual([]);
    expect(dataLayerScopes('i1', { version: 3, layers: [{}, { id: '' }, { id: 7 }] })).toEqual([]);
  });
});

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A PrismaService stand-in. Each backfill transaction waits on a gate
 * the test opens, so a test decides when (and whether) it finishes.
 */
function fakePrisma() {
  const marked = new Set<string>();
  const gates: Array<{ scope: string; gate: Deferred }> = [];
  const contexts: Array<ReturnType<typeof currentTenant>> = [];
  const sql: string[] = [];
  const prisma = {
    featureOidScope: {
      findUnique: jest.fn(async ({ where }: { where: { scope: string } }) =>
        marked.has(where.scope) ? { scope: where.scope } : null,
      ),
    },
    featureOid: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
      let scope = '';
      const tx = {
        $executeRawUnsafe: jest.fn(async (text: string) => {
          sql.push(text);
          return 0;
        }),
        $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('?');
          sql.push(text);
          if (text.includes('pg_advisory_xact_lock')) {
            scope = String(values[0]).replace('feature-oid-backfill|', '');
            contexts.push(currentTenant());
            const gate = deferred();
            gates.push({ scope, gate });
            await gate.promise;
          }
          return 0;
        }),
        featureOidScope: {
          findUnique: jest.fn(async ({ where }: { where: { scope: string } }) =>
            marked.has(where.scope) ? { scope: where.scope } : null,
          ),
          upsert: jest.fn(async ({ where }: { where: { scope: string } }) => {
            marked.add(where.scope);
          }),
        },
      };
      await fn(tx);
    }),
  };
  const svc = new FeatureOidService(
    prisma as unknown as PrismaService,
    { shouldRun: () => true } as unknown as LeaderElectionService,
  );
  return { svc, prisma, marked, gates, contexts, sql };
}

/** Let pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('FeatureOidService backfill', () => {
  const A = 'data_layer:i1:a';
  const B = 'data_layer:i1:b';

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns at once for a scope that is already numbered', async () => {
    const { svc, prisma, marked } = fakePrisma();
    marked.add(A);
    await svc.ensureScope(A);
    await svc.ensureScopeForRequest(A);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('runs one backfill for many callers of the same scope', async () => {
    const { svc, prisma, gates, marked } = fakePrisma();
    const calls = [svc.ensureScope(A), svc.ensureScopeForRequest(A), svc.ensureScope(A)];
    await settle();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    gates[0]!.gate.resolve();
    await Promise.all(calls);
    expect(marked.has(A)).toBe(true);
    // Done: a later call reads the marker and starts nothing.
    await svc.ensureScope(A);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('runs backfills of different scopes side by side', async () => {
    const { svc, prisma, gates, marked } = fakePrisma();
    const a = svc.ensureScope(A);
    const b = svc.ensureScope(B);
    await settle();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(gates.map((g) => g.scope).sort()).toEqual([A, B]);
    for (const g of gates) g.gate.resolve();
    await Promise.all([a, b]);
    expect([...marked].sort()).toEqual([A, B]);
  });

  it('takes the lock before numbering, as system work, with no statement timeout', async () => {
    const { svc, gates, contexts, sql } = fakePrisma();
    const done = runAsAnonymous(() => svc.ensureScopeForRequest(A));
    await settle();
    gates[0]!.gate.resolve();
    await done;
    expect(contexts).toEqual([{ kind: 'system', reason: 'feature-oid-backfill' }]);
    expect(sql[0]).toBe('SET LOCAL statement_timeout = 0');
    expect(sql[1]).toContain('pg_advisory_xact_lock');
    expect(sql[2]).toContain('INSERT INTO feature_oid');
  });

  it('skips the numbering when another replica finished the scope meanwhile', async () => {
    const { svc, gates, marked, sql } = fakePrisma();
    const done = svc.ensureScope(A);
    await settle();
    // The other replica marks it while this one waits on the lock.
    marked.add(A);
    gates[0]!.gate.resolve();
    await done;
    expect(sql.some((s) => s.includes('INSERT INTO feature_oid'))).toBe(false);
  });

  it('clears a failed backfill so the next call tries again', async () => {
    const { svc, prisma, gates, marked } = fakePrisma();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const first = svc.ensureScope(A);
    await settle();
    gates[0]!.gate.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    expect(marked.has(A)).toBe(false);

    const second = svc.ensureScope(A);
    await settle();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    gates[1]!.gate.resolve();
    await second;
    expect(marked.has(A)).toBe(true);
    warn.mockRestore();
  });

  it('answers a request with a 503 when the backfill outlasts the wait, and keeps numbering', async () => {
    jest.useFakeTimers();
    const { svc, prisma, gates, marked } = fakePrisma();
    const request = svc.ensureScopeForRequest(A);
    const outcome = request.then(
      () => null,
      (err: unknown) => err,
    );
    await settle();
    await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_WAIT_MS);
    const err = await outcome;
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as ServiceUnavailableException).message).toBe(LAYER_PREPARING_MESSAGE);
    expect(marked.has(A)).toBe(false);

    // A retry joins the backfill still running rather than starting one.
    const retry = svc.ensureScopeForRequest(A);
    await settle();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    gates[0]!.gate.resolve();
    await retry;
    expect(marked.has(A)).toBe(true);
  });

  it('logs a failure of a backfill no request waits for any more', async () => {
    jest.useFakeTimers();
    const { svc, gates, marked } = fakePrisma();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const request = svc.ensureScopeForRequest(A).catch((err: unknown) => err);
    await settle();
    await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_WAIT_MS);
    expect(await request).toBeInstanceOf(ServiceUnavailableException);
    gates[0]!.gate.reject(new Error('boom'));
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(marked.has(A)).toBe(false);
    warn.mockRestore();
  });

  it('gives a fresh edit its ObjectIDs even while a big backfill runs', async () => {
    jest.useFakeTimers();
    const { svc, prisma, gates } = fakePrisma();
    prisma.featureOid.findMany.mockResolvedValueOnce([{ entity: 'e1', oid: 7n }] as never);
    const lookup = svc.oidsFor(A, ['e1']);
    await settle();
    await jest.advanceTimersByTimeAsync(REQUEST_BACKFILL_WAIT_MS);
    expect((await lookup).get('e1')).toBe(7n);
    gates[0]!.gate.resolve();
    await settle();
  });
});

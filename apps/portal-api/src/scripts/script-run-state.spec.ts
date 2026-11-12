// SPDX-License-Identifier: AGPL-3.0-or-later
import { ScriptRunnerWorker } from './script-runner.worker.js';
import { ScriptsService } from './scripts.service.js';

/**
 * Script run state moves under two writers: the person pressing Cancel
 * and the claimer. Every transition has to be conditional on the state
 * it was decided from, or one writer silently overwrites the other.
 */

type Row = { id: string; scriptId: string; state: string };

/** A tiny in-memory script_run table that honours `where.state`. */
function fakeRuns(initial: Row) {
  const row = { ...initial, heartbeatAt: new Date(0) } as Row & {
    heartbeatAt: Date;
    [k: string]: unknown;
  };
  const matches = (where: Record<string, unknown>) => {
    const st = where.state as string | { in: string[] } | undefined;
    if (typeof st === 'string' && st !== row.state) return false;
    if (st && typeof st === 'object' && !st.in.includes(row.state)) {
      return false;
    }
    const hb = where.heartbeatAt as { lt: Date } | undefined;
    if (hb && !(row.heartbeatAt < hb.lt)) return false;
    return true;
  };
  return {
    row,
    scriptRun: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async () => {
        throw new Error('unconditional update used');
      }),
      updateMany: jest.fn(
        async (args: { where: Record<string, unknown>; data: object }) => {
          if (!matches(args.where)) return { count: 0 };
          Object.assign(row, args.data);
          return { count: 1 };
        },
      ),
    },
  };
}

function scriptsServiceFor(db: ReturnType<typeof fakeRuns>) {
  const svc = new ScriptsService(
    { scriptRun: db.scriptRun } as never,
    {} as never,
    {} as never,
  );
  // Authorisation is not under test here.
  (svc as unknown as { assertRunnable: () => Promise<void> }).assertRunnable =
    async () => undefined;
  return svc;
}

describe('ScriptsService.cancelRun', () => {
  it('does not relabel a run that finished between the read and the write', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'running' });
    // The read sees `running`; the run finishes before the write.
    db.scriptRun.findUnique.mockImplementationOnce(async () => {
      const snapshot = { ...db.row };
      db.row.state = 'done';
      return snapshot;
    });
    const out = await scriptsServiceFor(db).cancelRun({} as never, 'r');
    expect(out.state).toBe('done');
    expect(db.row.state).toBe('done');
  });

  it('asks a run claimed between the read and the write to stop, instead of calling it cancelled', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'queued' });
    db.scriptRun.findUnique.mockImplementationOnce(async () => {
      const snapshot = { ...db.row };
      db.row.state = 'running';
      return snapshot;
    });
    const out = await scriptsServiceFor(db).cancelRun({} as never, 'r');
    expect(out.state).toBe('cancel_requested');
    expect(db.row.state).toBe('cancel_requested');
  });

  it('cancels a queued run outright', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'queued' });
    const out = await scriptsServiceFor(db).cancelRun({} as never, 'r');
    expect(out.state).toBe('cancelled');
  });
});

describe('ScriptRunnerWorker terminal writes', () => {
  function workerFor(db: ReturnType<typeof fakeRuns>) {
    const revoked: string[] = [];
    const w = new ScriptRunnerWorker(
      { scriptRun: db.scriptRun } as never,
      {
        revokeSystemKey: async (id: string) => {
          revoked.push(id);
        },
      } as never,
    );
    return { w, revoked };
  }

  it('never overwrites a run that is already terminal, but still revokes its key', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'done' });
    const { w, revoked } = workerFor(db);
    const moved = await (
      w as unknown as {
        finish(id: string, input: object): Promise<boolean>;
      }
    ).finish('r', { state: 'cancelled', apiKeyId: 'k1' });
    expect(moved).toBe(false);
    expect(db.row.state).toBe('done');
    expect(revoked).toEqual(['k1']);
  });

  it('does not reclaim a run that finished after the stale read', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'cancel_requested' });
    const findMany = jest.fn(async () => {
      const snapshot = [{ id: 'r', state: 'cancel_requested', apiKeyId: null }];
      db.row.state = 'done';
      return snapshot;
    });
    const { w } = workerFor({
      ...db,
      scriptRun: { ...db.scriptRun, findMany },
    } as never);
    await (w as unknown as { reclaimStale(): Promise<void> }).reclaimStale();
    expect(db.row.state).toBe('done');
  });
});

describe('ScriptRunnerWorker failure labels', () => {
  it('fails a run whose key cannot be minted, instead of stranding it', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'running' });
    const w = new ScriptRunnerWorker(
      { scriptRun: db.scriptRun } as never,
      {
        mintForRun: async () => {
          throw new Error('owner is gone');
        },
        revokeSystemKey: async () => undefined,
      } as never,
    );
    await (w as unknown as { dispatch(j: object): Promise<void> }).dispatch({
      id: 'r',
      userId: 'u',
      source: 'print(1)',
      format: 'python',
    });
    expect(db.row.state).toBe('failed');
    expect(String(db.row.error)).toMatch(/Could not start the run: owner is gone/);
  });

  it('strips NUL characters before saving a log', async () => {
    const db = fakeRuns({ id: 'r', scriptId: 's', state: 'running' });
    const w = new ScriptRunnerWorker(
      { scriptRun: db.scriptRun } as never,
      { revokeSystemKey: async () => undefined } as never,
    );
    await (
      w as unknown as { finish(id: string, input: object): Promise<boolean> }
    ).finish('r', { state: 'done', log: 'a\u0000b', notebook: '{\u0000}', apiKeyId: null });
    expect(db.row.log).toBe('ab');
    expect(db.row.notebook).toBe('{}');
  });
});

describe('ScriptRunnerWorker run time limit', () => {
  const saved = process.env.SCRIPT_TIMEOUT_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCRIPT_TIMEOUT_SECONDS;
    else process.env.SCRIPT_TIMEOUT_SECONDS = saved;
  });

  function limitFor(data: unknown) {
    const w = new ScriptRunnerWorker(
      { item: { findUnique: async () => ({ data }) } } as never,
      {} as never,
    );
    return (w as unknown as {
      runTimeoutSeconds(id: string): Promise<number>;
    }).runTimeoutSeconds('s');
  }

  it('uses the per-script setting', async () => {
    delete process.env.SCRIPT_TIMEOUT_SECONDS;
    await expect(limitFor({ timeoutSeconds: 1800 })).resolves.toBe(1800);
  });

  it('never goes above the operator setting', async () => {
    process.env.SCRIPT_TIMEOUT_SECONDS = '600';
    await expect(limitFor({ timeoutSeconds: 1800 })).resolves.toBe(600);
  });

  it('falls back to the default without a per-script value', async () => {
    delete process.env.SCRIPT_TIMEOUT_SECONDS;
    await expect(limitFor({})).resolves.toBe(300);
  });
});

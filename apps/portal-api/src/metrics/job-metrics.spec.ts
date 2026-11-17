// SPDX-License-Identifier: AGPL-3.0-or-later
import { JobMetricsReader, snapshotFromRows } from './job-metrics';

describe('snapshotFromRows', () => {
  it('maps rows to fixed job types and drops anything else', () => {
    const snap = snapshotFromRows([
      { t: 'import', bucket: 'queued', n: 3, oldest: 42 },
      { t: 'import', bucket: 'running', n: 1, oldest: 0 },
      { t: 'analysis', bucket: 'failed', n: 2, oldest: 0 },
      { t: 'not-a-type', bucket: 'queued', n: 9, oldest: 9 },
    ]);
    expect(snap.queued.import).toBe(3);
    expect(snap.oldestQueuedSeconds.import).toBe(42);
    expect(snap.running.import).toBe(1);
    expect(snap.failedRecent.analysis).toBe(2);
    expect(Object.keys(snap.queued).sort()).toEqual(
      ['ago_import', 'analysis', 'import', 'offline_package', 'script'],
    );
  });
});

describe('JobMetricsReader', () => {
  function prisma(result: () => Promise<unknown>) {
    return {
      $transaction: jest.fn(result),
      $executeRawUnsafe: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
  }

  it('caches a snapshot and shares one query between concurrent reads', async () => {
    let now = 0;
    const db = prisma(async () => [0, [{ t: 'script', bucket: 'queued', n: 1, oldest: 1 }]]);
    const reader = new JobMetricsReader(db as never, 15_000, () => now);
    await Promise.all([reader.read(), reader.read()]);
    await reader.read();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    now = 15_000;
    await reader.read();
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good snapshot and flags the error when the query fails', async () => {
    let now = 0;
    let fail = false;
    const db = prisma(async () => {
      if (fail) throw new Error('boom');
      return [0, [{ t: 'import', bucket: 'queued', n: 5, oldest: 1 }]];
    });
    const reader = new JobMetricsReader(db as never, 10, () => now);
    expect((await reader.read())!.queued.import).toBe(5);
    fail = true;
    now = 100;
    expect((await reader.read())!.queued.import).toBe(5);
    expect(reader.lastError).toBe(true);
  });

  it('returns null when it has never read successfully', async () => {
    const reader = new JobMetricsReader(
      prisma(async () => {
        throw new Error('down');
      }) as never,
    );
    expect(await reader.read()).toBeNull();
  });
});

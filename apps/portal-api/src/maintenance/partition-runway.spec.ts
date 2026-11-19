// SPDX-License-Identifier: AGPL-3.0-or-later
import { evaluateRunway, quoteQualified, type PartitionSetState } from './partition-runway.js';
import { PartitionRunwayService } from './partition-runway.service.js';

function set(over: Partial<PartitionSetState> = {}): PartitionSetState {
  return {
    parentTable: 'public.observation',
    partitionInterval: '1 mon',
    lastEnd: new Date('2027-02-01T00:00:00Z'),
    shortRunway: false,
    recentData: true,
    defaultHasRows: false,
    ...over,
  };
}

describe('evaluateRunway', () => {
  it('reports nothing while partitions run ahead of the data', () => {
    expect(evaluateRunway([set()])).toEqual([]);
  });

  it('warns when an active set is about to run past its last partition', () => {
    const [f] = evaluateRunway([set({ shortRunway: true })]);
    expect(f?.level).toBe('warn');
    expect(f?.message).toContain('run_maintenance_proc');
  });

  it('stays quiet about a short runway on a set that gets no new data', () => {
    // pg_partman only builds ahead of the newest row when
    // infinite_time_partitions is off, as on the demo.
    expect(evaluateRunway([set({ shortRunway: true, recentData: false })])).toEqual([]);
  });

  it('reports rows in the default partition as an error, whatever the runway', () => {
    const [f] = evaluateRunway([set({ defaultHasRows: true, recentData: false })]);
    expect(f?.level).toBe('error');
    expect(f?.message).toContain("partition_data_proc('public.observation')");
  });
});

describe('quoteQualified', () => {
  it('quotes each part', () => {
    expect(quoteQualified('public.observation')).toBe('"public"."observation"');
    expect(quoteQualified('we"ird')).toBe('"we""ird"');
  });
});

describe('PartitionRunwayService', () => {
  function service(answers: unknown[][], leader = true) {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return answers.shift() ?? [];
      }),
    };
    const svc = new PartitionRunwayService(
      prisma as never,
      { shouldRun: () => leader } as never,
    );
    return { svc, calls };
  }

  it('does nothing where pg_partman is not installed', async () => {
    const { svc, calls } = service([[{ ok: false }]]);
    expect(await svc.check()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads each set, its recent data and its default partition', async () => {
    const { svc, calls } = service([
      [{ ok: true }],
      [
        {
          parent_table: 'public.observation',
          control: 'tx_time',
          partition_interval: '1 mon',
          last_end: new Date('2026-12-01T00:00:00Z'),
          short_runway: true,
          has_default: true,
        },
      ],
      [{ yes: true }],
      [{ yes: false }],
    ]);
    const findings = await svc.check();
    expect(findings.map((f) => f.level)).toEqual(['warn']);
    expect(calls[2]?.sql).toContain('from "public"."observation"');
    expect(calls[2]?.sql).toContain('"tx_time" >= now() - $1::interval');
    expect(calls[2]?.args).toEqual(['1 mon']);
    expect(calls[3]?.sql).toContain('from only "public"."observation_default"');
  });

  it('only runs on the leader', async () => {
    const { svc, calls } = service([[{ ok: false }]], false);
    await svc.handleCron();
    expect(calls).toHaveLength(0);
  });
});

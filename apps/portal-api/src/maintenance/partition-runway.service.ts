// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeaderElectionService } from '../cron/leader-election.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  evaluateRunway,
  quoteQualified,
  type PartitionSetState,
  type RunwayFinding,
} from './partition-runway.js';
import { RunAsSystem } from '../common/tenant-context.js';

type SetRow = {
  parent_table: string;
  control: string;
  partition_interval: string;
  last_end: Date | null;
  short_runway: boolean;
  has_default: boolean;
};

const SETS_SQL = `
  select c.parent_table,
         c.control,
         c.partition_interval,
         e.last_end,
         coalesce(e.last_end < now() + c.partition_interval::interval, true) as short_runway,
         to_regclass(c.parent_table || '_default') is not null as has_default
    from partman.part_config c
    cross join lateral (
      select max(i.child_end_time) as last_end
        from partman.show_partitions(c.parent_table) s
        cross join lateral partman.show_partition_info(
          s.partition_schemaname || '.' || s.partition_tablename,
          c.partition_interval,
          c.parent_table) i
    ) e
   where c.partition_type = 'range'
     -- Time-based sets only; an id-based set has no end time.
     and (select a.atttypid::regtype::text
            from pg_attribute a
           where a.attrelid = c.parent_table::regclass
             and a.attname = c.control)
         in ('timestamp with time zone', 'timestamp without time zone', 'date')`;

/**
 * Hourly check that pg_partman keeps a partition ready ahead of the
 * data. See partition-runway.ts for what it reports and why.
 */
@Injectable()
export class PartitionRunwayService {
  private readonly log = new Logger(PartitionRunwayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leader: LeaderElectionService,
  ) {}

  // Fifteen minutes after pg_partman's worker would have run (its
  // interval counts from server start, so this is only roughly after).
  @Cron('0 40 * * * *', { name: 'partition-runway', timeZone: 'UTC' })
  @RunAsSystem('cron:partition-runway')
  async handleCron(): Promise<void> {
    if (!this.leader.shouldRun()) return;
    try {
      await this.check();
    } catch (err) {
      this.log.warn(`partition runway check failed: ${String(err)}`);
    }
  }

  async check(): Promise<RunwayFinding[]> {
    const installed = await this.prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `select to_regclass('partman.part_config') is not null as ok`,
    );
    if (!installed[0]?.ok) return [];
    const rows = await this.prisma.$queryRawUnsafe<SetRow[]>(SETS_SQL);
    const sets: PartitionSetState[] = [];
    for (const r of rows) {
      const parent = quoteQualified(r.parent_table);
      const control = quoteQualified(r.control);
      const recent = await this.prisma.$queryRawUnsafe<Array<{ yes: boolean }>>(
        `select exists (select 1 from ${parent}
           where ${control} >= now() - $1::interval) as yes`,
        r.partition_interval,
      );
      const inDefault = r.has_default
        ? await this.prisma.$queryRawUnsafe<Array<{ yes: boolean }>>(
            `select exists (select 1 from only ${quoteQualified(`${r.parent_table}_default`)}) as yes`,
          )
        : [{ yes: false }];
      sets.push({
        parentTable: r.parent_table,
        partitionInterval: r.partition_interval,
        lastEnd: r.last_end,
        shortRunway: r.short_runway,
        recentData: Boolean(recent[0]?.yes),
        defaultHasRows: Boolean(inDefault[0]?.yes),
      });
    }
    const findings = evaluateRunway(sets);
    for (const f of findings) {
      if (f.level === 'error') this.log.error(f.message);
      else this.log.warn(f.message);
    }
    return findings;
  }
}

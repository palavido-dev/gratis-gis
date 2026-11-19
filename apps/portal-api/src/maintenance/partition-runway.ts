// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is pg_partman keeping ahead of the data?
 *
 * `observation` (and any other partition set pg_partman manages) needs a
 * partition ready for the rows that arrive. pg_partman's background
 * worker creates them, but on Postgres 17.12 its worker errors out on
 * every run (#758, upstream pgpartman/pg_partman#891), and nothing would
 * say so until it mattered. When rows arrive past the last partition
 * they land in the default partition, and pg_partman then refuses to
 * create a partition that overlaps them, so it never recovers alone.
 *
 * Two findings:
 *  - error: the default partition holds rows. They have to be moved
 *    (`CALL partman.partition_data_proc('<parent>')`) before
 *    maintenance can catch up.
 *  - warn: a set that received data within its last interval has less
 *    than one interval of partitions ahead. Maintenance is not keeping
 *    up; run `CALL partman.run_maintenance_proc()`.
 *
 * A set that receives no data is fine with a short runway: with
 * `infinite_time_partitions = false` pg_partman only builds ahead of the
 * newest row, which is what the demo's quiet data looks like.
 */

export interface PartitionSetState {
  parentTable: string;
  partitionInterval: string;
  /** Upper bound of the newest child, or null when there is none. */
  lastEnd: Date | null;
  /** lastEnd is earlier than now plus one interval. */
  shortRunway: boolean;
  /** The set has a row newer than now minus one interval. */
  recentData: boolean;
  defaultHasRows: boolean;
}

export interface RunwayFinding {
  level: 'error' | 'warn';
  parentTable: string;
  message: string;
}

export function evaluateRunway(sets: PartitionSetState[]): RunwayFinding[] {
  const out: RunwayFinding[] = [];
  for (const s of sets) {
    if (s.defaultHasRows) {
      out.push({
        level: 'error',
        parentTable: s.parentTable,
        message:
          `${s.parentTable}: rows are in the default partition, so pg_partman ` +
          'will not create the partitions that should hold them. Move them with ' +
          `CALL partman.partition_data_proc('${s.parentTable}'), then run ` +
          'CALL partman.run_maintenance_proc(). See issue #758.',
      });
      continue;
    }
    if (s.shortRunway && s.recentData) {
      const end = s.lastEnd ? s.lastEnd.toISOString() : 'nowhere';
      out.push({
        level: 'warn',
        parentTable: s.parentTable,
        message:
          `${s.parentTable}: partitions end at ${end}, less than one interval ` +
          `(${s.partitionInterval}) ahead, and the table is receiving data. ` +
          'pg_partman maintenance may not be running. Run ' +
          'CALL partman.run_maintenance_proc(). See issue #758.',
      });
    }
  }
  return out;
}

/** "schema.table" (or "table") as quoted SQL identifiers. */
export function quoteQualified(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

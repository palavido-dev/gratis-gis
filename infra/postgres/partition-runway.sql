-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Partition runway for infra/doctor.sh (#758). One line per
-- time-based pg_partman set that has a default partition:
--   parent | rows in default | end of last partition | under one interval ahead
-- The API runs the same check hourly (src/maintenance/partition-runway.ts).
select format(
  'select %L, exists (select 1 from only %I.%I), e.last_end, '
  || 'coalesce(e.last_end < now() + %L::interval, true) '
  || 'from (select max(i.child_end_time) as last_end '
  || 'from partman.show_partitions(%L) s '
  || 'cross join lateral partman.show_partition_info('
  || 's.partition_schemaname || ''.'' || s.partition_tablename, %L, %L) i) e',
  c.parent_table,
  split_part(c.parent_table, '.', 1),
  split_part(c.parent_table, '.', 2) || '_default',
  c.partition_interval,
  c.parent_table,
  c.partition_interval,
  c.parent_table)
from partman.part_config c
where to_regclass(c.parent_table || '_default') is not null
  and (select a.atttypid::regtype::text
         from pg_attribute a
        where a.attrelid = c.parent_table::regclass
          and a.attname = c.control)
      in ('timestamp with time zone', 'timestamp without time zone', 'date')
\gexec
